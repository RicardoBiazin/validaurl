/* As Functions inteiras: porteiro (passe do portão, origem, método), limites e respostas. */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import checarFn from "../netlify/functions/checar.mts";
import paginaFn from "../netlify/functions/pagina.mts";
import { zerarLimites } from "../servidor/acesso.ts";
import { liberarLoopbackParaTestes } from "../servidor/rede.ts";
import { criarPasse } from "../src/portao/nucleo.ts";
import { type Local, servidorLocal } from "./ajudantes.ts";

const SEGREDO = "segredo-de-teste-com-mais-de-32-bytes!!";
const UA = "Mozilla/5.0 Teste";
const ORIGEM = "https://validaurl.teste";
let srv: Local;
let passe: string;

before(async () => {
  srv = await servidorLocal();
  liberarLoopbackParaTestes(true);
  process.env.PORTAO_SEGREDO = SEGREDO;
  delete process.env.NETLIFY_DEV;
  passe = await criarPasse(SEGREDO, UA);
});
after(async () => {
  liberarLoopbackParaTestes(false);
  delete process.env.PORTAO_SEGREDO;
  await srv.fechar();
});
beforeEach(() => zerarLimites());

function pedido(caminho: string, corpo: unknown, h: Record<string, string> = {}, metodo = "POST") {
  return new Request(ORIGEM + caminho, {
    method: metodo,
    headers: { "content-type": "application/json", "user-agent": UA, origin: ORIGEM, cookie: `vu_passe=${passe}`,
      "x-nf-client-connection-ip": "5.5.5.5", ...h },
    body: metodo === "GET" ? undefined : JSON.stringify(corpo),
  });
}

test("checar: lote ok", async () => {
  const r = await checarFn(pedido("/api/checar", { urls: [srv.base + "/ok", srv.base + "/nada"] }));
  assert.equal(r.status, 200);
  const { resultados } = await r.json() as { resultados: { status: number }[] };
  assert.deepEqual(resultados.map((x) => x.status), [200, 404]);
  assert.match(r.headers.get("x-robots-tag")!, /noindex/);
});

test("porteiro: sem passe, passe de outro navegador, outra origem, GET", async () => {
  const corpo = { urls: [srv.base + "/ok"] };
  assert.equal((await checarFn(pedido("/api/checar", corpo, { cookie: "" }))).status, 403);
  assert.equal((await checarFn(pedido("/api/checar", corpo, { "user-agent": "curl/8" }))).status, 403);
  assert.equal((await checarFn(pedido("/api/checar", corpo, { origin: "https://outro.site" }))).status, 403);
  assert.equal((await checarFn(pedido("/api/checar", corpo, { origin: "" }))).status, 403);
  assert.equal((await checarFn(pedido("/api/checar", corpo, {}, "GET"))).status, 405);
  delete process.env.PORTAO_SEGREDO;
  assert.equal((await checarFn(pedido("/api/checar", corpo))).status, 500, "sem segredo em produção: fechado");
  process.env.NETLIFY_DEV = "true";
  assert.equal((await checarFn(pedido("/api/checar", corpo, { cookie: "" }))).status, 200, "netlify dev: aberto");
  delete process.env.NETLIFY_DEV;
  process.env.PORTAO_SEGREDO = SEGREDO;
});

test("checar: pedidos inválidos e limite por minuto", async () => {
  assert.equal((await checarFn(pedido("/api/checar", { urls: [] }))).status, 400);
  assert.equal((await checarFn(pedido("/api/checar", { urls: Array(11).fill("https://a.com") }))).status, 400);
  assert.equal((await checarFn(pedido("/api/checar", { urls: [1, 2] }))).status, 400);
  assert.equal((await checarFn(pedido("/api/checar", "lixo"))).status, 400);
  let ultimo = 200;
  for (let i = 0; i < 31 && ultimo === 200; i++) {
    ultimo = (await checarFn(pedido("/api/checar", { urls: Array(10).fill(srv.base + "/ok") }))).status;
  }
  assert.equal(ultimo, 429, "300 URLs por minuto por IP");
});

test("pagina: html devolve links, nunca o corpo; robots e sitemap", async () => {
  let r = await paginaFn(pedido("/api/pagina", { url: srv.base + "/site/", modo: "html" }));
  const html = await r.json() as { checagem: Record<string, unknown>; links: string[] };
  assert.equal(html.checagem.status, 200);
  assert.equal(html.checagem.corpo, undefined);
  assert.ok(html.links.includes(srv.base + "/site/a"));
  assert.ok(html.links.includes(srv.base + "/site/b"));
  assert.ok(!html.links.some((l) => l.startsWith("mailto")));
  r = await paginaFn(pedido("/api/pagina", { url: srv.base + "/qualquer", modo: "robots" }));
  const rob = await r.json() as { robots: { bloquear: string[]; sitemaps: string[] } };
  assert.deepEqual(rob.robots.bloquear, ["/site/privado"]);
  r = await paginaFn(pedido("/api/pagina", { url: srv.base + "/sitemap_index.xml", modo: "sitemap" }));
  assert.equal(((await r.json()) as { filhos: string[] }).filhos.length, 2);
  r = await paginaFn(pedido("/api/pagina", { url: srv.base + "/nao-tem.xml", modo: "sitemap" }));
  assert.match(((await r.json()) as { erro: string }).erro, /404/);
  assert.equal((await paginaFn(pedido("/api/pagina", { url: srv.base, modo: "outro" }))).status, 400);
});
