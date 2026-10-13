import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { tratarConfirmacao, tratarMonitores } from "../servidor/api-monitores.ts";
import { zerarLimites } from "../servidor/acesso.ts";
import { type Ambiente, armazemMemoria, comparar, type Monitor, rodarVencidos, validar } from "../servidor/monitor.ts";
import { liberarLoopbackParaTestes } from "../servidor/rede.ts";
import { type Local, servidorLocal } from "./ajudantes.ts";

let srv: Local;
before(async () => {
  srv = await servidorLocal();
  liberarLoopbackParaTestes(true);
});
after(async () => {
  liberarLoopbackParaTestes(false);
  await srv.fechar();
});
beforeEach(() => zerarLimites());

function ambiente() {
  const emails: { para: string; assunto: string; texto: string }[] = [];
  const pushes: string[] = [];
  const posts: unknown[] = [];
  const a: Ambiente = {
    baseUrl: "https://validaurl.teste",
    enviarEmail: async (para, assunto, texto) => void emails.push({ para, assunto, texto }),
    enviarPush: async (s, dados) => {
      if (s.endpoint.includes("vencida")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      pushes.push(dados);
    },
    postar: async (_url, dados) => {
      posts.push(dados);
      return 200;
    },
    vapid: { publica: "PUB", privada: "PRIV", contato: "mailto:x@y.z" },
  };
  return { a, emails, pushes, posts };
}

const req = (ip = "1.2.3.4") => new Request("https://validaurl.teste/api/monitores", {
  method: "POST", headers: { "x-nf-client-connection-ip": ip },
});

async function chamar(loja: ReturnType<typeof armazemMemoria>, a: Ambiente, p: Record<string, unknown>, ip?: string) {
  const r = await tratarMonitores(req(ip), p, loja, a);
  return { status: r.status, corpo: await r.json() as Record<string, any> };
}

test("validação do formulário", () => {
  assert.equal(validar({ intervaloMin: 3, urls: ["https://a.com"] }), "Intervalo inválido.");
  assert.match(String(validar({ intervaloMin: 5, urls: [] })), /pelo menos uma/);
  assert.match(String(validar({ intervaloMin: 5, urls: Array.from({ length: 26 }, (_, i) => `https://a.com/${i}`) })), /25/);
  liberarLoopbackParaTestes(false);
  assert.match(String(validar({ intervaloMin: 5, urls: ["http://169.254.169.254/"] })), /bloqueado/);
  liberarLoopbackParaTestes(true);
  assert.match(String(validar({ intervaloMin: 5, urls: ["https://a.com"], webhook: "http://hooks.x.com/" })), /https/);
  assert.match(String(validar({ intervaloMin: 5, urls: ["https://a.com"], email: "nao-e-email" })), /E-mail/);
  const ok = validar({ intervaloMin: 15, urls: ["https://a.com", "https://a.com/"], email: "Eu@Exemplo.com" });
  assert.equal(typeof ok, "object");
  assert.deepEqual((ok as { urls: string[] }).urls, ["https://a.com"]);
  assert.equal((ok as { email: string }).email, "eu@exemplo.com");
});

test("comparação: só a mudança gera aviso", () => {
  const r = (url: string, categoria: string) => ({ url, status: 0, categoria, erro: "", tempoMs: 0, urlFinal: "" });
  const m = comparar([r("a", "OK"), r("b", "Erro 4xx"), r("c", "Erro 5xx")], [r("a", "Erro 4xx"), r("b", "OK"), r("c", "Erro 5xx")]);
  assert.deepEqual([m.novos.length, m.recuperados.length, m.ainda.length], [1, 1, 1]);
  assert.equal(comparar(null, [r("a", "Falha")]).novos.length, 1);
});

test("ciclo completo: criar, confirmar e-mail, checar, avisar, editar, excluir", async () => {
  const loja = armazemMemoria();
  const { a, emails, pushes, posts } = ambiente();
  const cfg = await chamar(loja, a, { acao: "config" });
  assert.equal(cfg.corpo.emailDisponivel, true);
  assert.equal(cfg.corpo.pushChave, "PUB");

  const criar = await chamar(loja, a, { acao: "criar", monitor: {
    nome: "Meu site", tipo: "lista", urls: [srv.base + "/ok", srv.base + "/nada"], intervaloMin: 5,
    email: "dono@exemplo.com", webhook: "https://hooks.exemplo.com/x",
  } });
  assert.equal(criar.status, 201);
  const { id, chave } = criar.corpo;
  assert.ok(id && chave);
  assert.equal(criar.corpo.monitor.chaveHash, undefined, "hash da chave não sai");
  assert.equal(criar.corpo.monitor.avisos.email.confirmado, false);
  assert.equal(emails.length, 1, "e-mail de confirmação");
  assert.match(emails[0].assunto, /Confirme/);
  const link = /(https:\/\/\S+\/api\/confirmar\?\S+)/.exec(emails[0].texto)![1];

  // chave errada
  assert.equal((await chamar(loja, a, { acao: "ver", id, chave: "errada" })).status, 404);

  // 1ª checagem: /nada é problema novo -> webhook (e-mail ainda não confirmado: nada)
  let r = await chamar(loja, a, { acao: "checar", id, chave });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.monitor.resultados.length, 2);
  assert.equal(posts.length, 1);
  assert.equal(emails.length, 1);
  assert.equal((await chamar(loja, a, { acao: "checar", id, chave })).status, 200);
  assert.equal((await chamar(loja, a, { acao: "checar", id, chave })).status, 429, "checar tem limite por minuto");
  assert.equal(posts.length, 1, "sem mudança, sem aviso");

  // confirmar o e-mail pelo link
  const pagina = await tratarConfirmacao(new Request(link.replace("https://validaurl.teste", "https://validaurl.teste")), loja);
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /confirmado/);
  const salvo = (await loja.get(`monitor/${id}`)) as Monitor;
  assert.equal(salvo.avisos.email!.confirmado, true);

  // push: uma válida, uma vencida (sai sozinha no próximo aviso)
  for (const endpoint of ["https://push.exemplo/ok", "https://push.exemplo/vencida"]) {
    r = await chamar(loja, a, { acao: "push", id, chave, assinatura: { endpoint, keys: { p256dh: "k", auth: "a" } } });
    assert.equal(r.status, 200);
  }
  assert.equal(r.corpo.monitor.avisos.push, 2);
  assert.equal((await chamar(loja, a, { acao: "push", id, chave, assinatura: { endpoint: "http://inseguro" } })).status, 400);

  // testar avisos: todos os canais
  r = await chamar(loja, a, { acao: "testar-avisos", id, chave });
  assert.deepEqual(r.corpo.erros, []);
  assert.equal(emails.length, 2);
  assert.match(emails[1].texto, /api\/confirmar\?.*sair=1/, "e-mail de aviso tem link para sair");
  assert.equal(pushes.length, 1);
  assert.equal(((await loja.get(`monitor/${id}`)) as Monitor).avisos.push.length, 2, "teste não grava o monitor");

  // editar: troca o alvo (resultados zeram) e o e-mail (volta a pedir confirmação)
  r = await chamar(loja, a, { acao: "editar", id, chave, monitor: { nome: "Outro", tipo: "lista", urls: [srv.base + "/ok"],
    intervaloMin: 60, email: "novo@exemplo.com", webhook: "", ativo: false } });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.monitor.nome, "Outro");
  assert.equal(r.corpo.monitor.resultados.length, 0);
  assert.equal(r.corpo.monitor.avisos.email.confirmado, false);
  assert.equal(r.corpo.monitor.ativo, false);
  assert.equal(emails.length, 3);
  // o link antigo de confirmação não vale mais
  assert.equal((await tratarConfirmacao(new Request(link), loja)).status, 404);

  // descadastro pelo link do e-mail
  const novo = (await loja.get(`monitor/${id}`)) as Monitor;
  const sair = await tratarConfirmacao(new Request(`https://v.t/api/confirmar?id=${id}&token=${novo.avisos.email!.token}&sair=1`), loja);
  assert.equal(sair.status, 200);
  assert.equal(((await loja.get(`monitor/${id}`)) as Monitor).avisos.email, null);

  assert.equal((await chamar(loja, a, { acao: "excluir", id, chave })).status, 200);
  assert.equal((await chamar(loja, a, { acao: "ver", id, chave })).status, 404);
});

test("limites contra abuso: monitores por IP por dia", async () => {
  const loja = armazemMemoria();
  const { a } = ambiente();
  const m = { tipo: "lista", urls: ["https://exemplo.com/"], intervaloMin: 60 };
  for (let i = 0; i < 5; i++) assert.equal((await chamar(loja, a, { acao: "criar", monitor: m }, "9.9.9.9")).status, 201);
  assert.equal((await chamar(loja, a, { acao: "criar", monitor: m }, "9.9.9.9")).status, 429);
  assert.equal((await chamar(loja, a, { acao: "criar", monitor: m }, "8.8.8.8")).status, 201, "outro IP pode");
  const semEmail = { ...a, enviarEmail: undefined, resendChave: undefined };
  const r = await chamar(loja, semEmail, { acao: "criar", monitor: { ...m, email: "x@y.com" } }, "7.7.7.7");
  assert.equal(r.status, 400);
  assert.equal((await chamar(loja, a, { acao: "inventada" })).status, 400);
});

test("agenda: roda só os vencidos e ativos, e reagenda", async () => {
  const loja = armazemMemoria();
  const { a, posts } = ambiente();
  const criados = [];
  for (const [urls, ativo] of [[[srv.base + "/ok"], true], [[srv.base + "/500"], true], [[srv.base + "/ok"], false]] as const) {
    criados.push((await chamar(loja, a, { acao: "criar", monitor: { tipo: "lista", urls, intervaloMin: 5, ativo,
      webhook: "https://hooks.exemplo.com/x" } })).corpo.id);
  }
  const agora = Date.now() + 1000;
  const r = await rodarVencidos(loja, a, agora);
  assert.deepEqual(r, { rodados: 2, pendentes: 0 });
  assert.equal(posts.length, 1, "só o /500 avisa");
  const m = (await loja.get(`monitor/${criados[0]}`)) as Monitor;
  assert.ok(m.proximaEm > agora + 4 * 60_000);
  assert.equal(m.historico.length, 1);
  assert.deepEqual(await rodarVencidos(loja, a, agora + 60_000), { rodados: 0, pendentes: 0 }, "nada vencido");
});
