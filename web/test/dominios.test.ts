import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  atualizarAvisos, diasAte, type DominioItem, situacao, sugestoesRegistro, textoAviso,
} from "../src/comum/dominios.ts";
import { verificarDominio } from "../servidor/dominios.ts";

const AGORA = Date.parse("2026-11-04T12:00:00Z");
const em = (dias: number) => new Date(AGORA + dias * 86_400_000).toISOString();
const item = (dominio: string, dias: number | null, ultimoAviso = ""): DominioItem => ({
  dominio, expira: dias === null ? null : em(dias), registrador: "", status: [], erro: "", verificado: "", ultimoAviso,
});

test("situação pelos dias até o vencimento", () => {
  assert.equal(diasAte(em(10), AGORA), 10);
  assert.equal(diasAte("nao-e-data", AGORA), null);
  assert.equal(situacao(-1), "vencido");
  assert.equal(situacao(15), "critico");
  assert.equal(situacao(16), "atencao");
  assert.equal(situacao(61), "ok");
  assert.equal(situacao(null), "desconhecido");
});

test("sugestões de registro por sufixo", () => {
  assert.equal(sugestoesRegistro("exemplo.com.br")[0][1], "https://registro.br/");
  assert.ok(sugestoesRegistro("exemplo.com").some(([n]) => n === "Cloudflare Registrar"));
});

test("aviso só quando a situação piora; renovado zera a memória", () => {
  const itens = [item("a.com.br", 40)];
  assert.equal(atualizarAvisos(itens, AGORA).length, 1);
  assert.equal(atualizarAvisos(itens, AGORA).length, 0, "mesma situação não repete");
  itens[0].expira = em(5);
  assert.equal(atualizarAvisos(itens, AGORA).length, 1, "piorou para crítico");
  itens[0].expira = em(365);
  assert.equal(atualizarAvisos(itens, AGORA).length, 0, "renovou");
  assert.equal(itens[0].ultimoAviso, "ok");
  itens[0].expira = em(20);
  assert.equal(atualizarAvisos(itens, AGORA).length, 1, "voltou a ficar perto: avisa de novo");
  assert.equal(atualizarAvisos([item("sem.com", null)], AGORA).length, 0, "sem data não avisa");
});

test("texto do aviso", () => {
  const t = textoAviso(item("exemplo.com.br", 3), AGORA);
  assert.match(t, /exemplo\.com\.br: vence em 3 dia\(s\)/);
  assert.match(t, /Registro\.br/);
  assert.match(textoAviso(item("x.com", -2), AGORA), /venceu há 2 dia\(s\)/);
});

const RDAP = {
  ldhName: "EXEMPLO.COM.BR", status: ["active"],
  events: [{ eventAction: "expiration", eventDate: em(30) }],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Registro X"]]] }],
};
const original = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "rdap.org" && url.pathname === "/domain/exemplo.com.br") return Response.json(RDAP);
    return new Response("não achei", { status: 404 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = original;
});

test("verificarDominio: consulta RDAP e trata falhas", async () => {
  const r = await verificarDominio("Exemplo.com.br");
  assert.equal(r.dominio, "exemplo.com.br");
  assert.equal(r.registrador, "Registro X");
  assert.equal(situacao(diasAte(r.expira, AGORA)), "atencao");
  const falhou = await verificarDominio("nao-existe.com.br");
  assert.equal(falhou.expira, null);
  assert.match(falhou.erro, /RDAP indisponível/);
  await assert.rejects(verificarDominio("8.8.8.8"), /não um IP/);
});
