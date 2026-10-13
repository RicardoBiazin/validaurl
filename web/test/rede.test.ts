import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { checar, ipBloqueado, liberarLoopbackParaTestes, motivoRecusa, postarJson } from "../servidor/rede.ts";
import { lerSitemap } from "../servidor/sitemap.ts";
import { type Local, servidorLocal } from "./ajudantes.ts";

let srv: Local;
before(async () => {
  srv = await servidorLocal();
});
after(async () => {
  liberarLoopbackParaTestes(false);
  await srv.fechar();
});

test("SSRF: endereços internos e esquisitos são recusados", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(ipBloqueado(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(ipBloqueado(ip), false, ip);
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://localhost/",
    "http://x.localhost/", "http://metadata.google.internal/", "http://10.0.0.1:80/", "ftp://x.com/",
    "http://user:senha@x.com/", "http://x.com:22/", "http://2130706433/", "http://0x7f000001/"]) {
    assert.ok(motivoRecusa(url), url);
  }
  assert.equal(motivoRecusa("https://exemplo.com.br/pagina"), null);
  assert.equal(motivoRecusa("http://exemplo.com:8080/"), null);
});

test("sem a liberação de testes, nem o servidor local é alcançável", async () => {
  liberarLoopbackParaTestes(false);
  let r = await checar(srv.base + "/ok");
  assert.equal(r.status, null);
  assert.match(r.erro, /Porta não permitida/);
  r = await checar("http://127.0.0.1/ok");
  assert.equal(r.erro, "Endereço interno bloqueado");
});

test("nome que resolve para IP interno é barrado na conexão (DNS)", async () => {
  liberarLoopbackParaTestes(false);
  const r = await checar("http://localtest.me/"); // resolve para 127.0.0.1 em DNS público
  assert.equal(r.status, null);
  assert.match(r.erro, /bloqueado|DNS/);
});

test("checagens contra o servidor local", async () => {
  liberarLoopbackParaTestes(true);
  let r = await checar(srv.base + "/ok");
  assert.equal(r.status, 200);
  assert.equal(r.metodo, "HEAD");
  r = await checar(srv.base + "/nada");
  assert.equal(r.status, 404);
  assert.equal(r.metodo, "GET");
  assert.equal(r.erro, "Not Found");
  r = await checar(srv.base + "/redir2");
  assert.equal(r.status, 200);
  assert.deepEqual(r.redirects.map((x) => x.status), [302, 301]);
  r = await checar(srv.base + "/redir", { seguirRedirects: false });
  assert.equal(r.status, 301);
  r = await checar(srv.base + "/loop");
  assert.equal(r.status, null);
  assert.match(r.erro, /Loop/);
  r = await checar(srv.base + "/head405");
  assert.equal(r.status, 200);
  assert.equal(r.metodo, "GET");
  r = await checar(srv.base + "/para-interno");
  assert.equal(r.status, null);
  assert.match(r.erro, /Redirect recusado/);
  r = await checar(srv.base + "/lento", { timeoutMs: 600 });
  assert.equal(r.erro, "Tempo esgotado");
  assert.ok(r.tempoMs < 2000, `tempo ${r.tempoMs}`);
  r = await checar(srv.base + "/gzip", { lerCorpo: true });
  assert.match(r.corpo!.toString(), /href="\/ok"/);
  r = await checar(srv.base + "/img.png", { lerCorpo: true });
  assert.equal(r.corpo, null);
});

test("sitemap (simples, CDATA e .gz)", async () => {
  liberarLoopbackParaTestes(true);
  const r = await checar(srv.base + "/sitemap.xml", { lerCorpo: true });
  assert.deepEqual(lerSitemap(r.corpo!).paginas, [srv.base + "/ok", srv.base + "/500", srv.base + "/redir"]);
  const i = await checar(srv.base + "/sitemap_index.xml", { lerCorpo: true });
  assert.equal(lerSitemap(i.corpo!).filhos.length, 2);
  const g = await checar(srv.base + "/sitemap2.xml.gz", { lerCorpo: true });
  assert.deepEqual(lerSitemap(g.corpo!).paginas, [srv.base + "/head405"]);
});

test("webhook com as mesmas travas", async () => {
  liberarLoopbackParaTestes(true);
  assert.equal(await postarJson(srv.base + "/webhook", { a: 1 }), 204);
  assert.deepEqual(srv.webhooks.at(-1), { a: 1 });
  await assert.rejects(postarJson(srv.base + "/quebrado", {}), /500/);
  await assert.rejects(postarJson("http://169.254.169.254/x", {}), /bloqueado/);
});
