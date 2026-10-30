import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BITS_PADRAO, cabecalhoCookie, criarDesafio, criarPasse, lerCookie, resolverDesafio, verificarDesafio,
  verificarPasse, zerosIniciais,
} from "../src/portao/nucleo.ts";
import { JS_SHA256 } from "../src/portao/pagina.ts";

const SEGREDO = "segredo-de-teste-com-mais-de-32-bytes!!";
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/140";
const HORA = 3600_000;

// O SHA-256 em JS que a pagina do desafio usa, executado aqui.
const cliente = new Function(JS_SHA256 + "; return { epfResolver, epfSha256Palavras };")() as {
  epfResolver(sal: string, bits: number, inicio: number, fim: number): number;
  epfSha256Palavras(msg: string, saida: Int32Array): Int32Array;
};

test("passe válido passa; adulterado, vencido ou de outro navegador não", async () => {
  const agora = Date.now();
  const passe = await criarPasse(SEGREDO, UA, agora);
  assert.equal(await verificarPasse(SEGREDO, passe, UA, agora), true);
  assert.equal(await verificarPasse(SEGREDO, passe, UA, agora + 6 * 24 * HORA), true, "ainda vale no 6º dia");
  assert.equal(await verificarPasse(SEGREDO, passe, UA, agora + 7 * 24 * HORA + 1000), false, "venceu depois de 7 dias");
  assert.equal(await verificarPasse(SEGREDO, passe, "Outro navegador", agora), false, "outro User-Agent");
  assert.equal(await verificarPasse("outro-segredo-qualquer-bem-longo", passe, UA, agora), false, "outro segredo");
  const [expira, sig] = passe.split(".");
  assert.equal(await verificarPasse(SEGREDO, `${Number(expira) + 999999}.${sig}`, UA, agora), false, "validade esticada");
  const trocado = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(await verificarPasse(SEGREDO, `${expira}.${trocado}`, UA, agora), false, "assinatura trocada");
  for (const lixo of [null, "", "abc", "1.2", `${expira}.`, `.${sig}`, passe + "x"]) {
    assert.equal(await verificarPasse(SEGREDO, lixo, UA, agora), false, `lixo: ${lixo}`);
  }
});

test("a assinatura de um desafio não serve como passe", async () => {
  const d = await criarDesafio(SEGREDO);
  const [, expira, sig] = d.split(".");
  assert.equal(await verificarPasse(SEGREDO, `${expira}.${sig}`, UA), false);
});

test("desafio: nonce certo passa; errado, vencido ou adulterado não", async () => {
  const agora = Date.now();
  const d = await criarDesafio(SEGREDO, agora);
  const bits = 12;
  const nonce = await resolverDesafio(d, bits);
  assert.deepEqual(await verificarDesafio(SEGREDO, d, nonce, bits, agora), { ok: true });
  // Nonce errado (procura um que NAO satisfaca).
  let errado = Number(nonce) + 1;
  const sal = d.split(".")[0];
  while (zerosIniciais(createHash("sha256").update(sal + errado).digest()) >= bits) errado++;
  assert.deepEqual(await verificarDesafio(SEGREDO, d, String(errado), bits, agora), { ok: false, motivo: "trabalho" });
  assert.deepEqual(await verificarDesafio(SEGREDO, d, nonce, bits, agora + 5 * 60_000 + 1000),
    { ok: false, motivo: "expirado" });
  const [s, e, sig] = d.split(".");
  const outroSal = (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.deepEqual(await verificarDesafio(SEGREDO, `${outroSal}.${e}.${sig}`, nonce, bits, agora),
    { ok: false, motivo: "assinatura" });
  assert.deepEqual(await verificarDesafio(SEGREDO, `${s}.${Number(e) + 3600}.${sig}`, nonce, bits, agora),
    { ok: false, motivo: "assinatura" }, "validade esticada");
  assert.deepEqual(await verificarDesafio("outro-segredo-qualquer-bem-longo", d, nonce, bits, agora),
    { ok: false, motivo: "assinatura" });
  for (const [dd, nn] of [[d, "abc"], [d, ""], [d, 12], ["lixo", nonce], [null, nonce]] as const) {
    assert.deepEqual(await verificarDesafio(SEGREDO, dd, nn, bits, agora), { ok: false, motivo: "formato" });
  }
});

test("zeros iniciais", () => {
  assert.equal(zerosIniciais(new Uint8Array([0, 0, 0x80])), 16);
  assert.equal(zerosIniciais(new Uint8Array([0, 0x0f])), 12);
  assert.equal(zerosIniciais(new Uint8Array([0xff])), 0);
  assert.equal(zerosIniciais(new Uint8Array([0, 0])), 16);
});

test("o SHA-256 em JS da página confere com o do crypto e resolve o desafio do servidor", async () => {
  const saida = new Int32Array(8);
  for (const msg of ["", "abc", "x".repeat(55), "AbC_-0123456789abcdefgh" + 987654]) {
    const esperado = createHash("sha256").update(msg).digest();
    const got = Buffer.alloc(32);
    cliente.epfSha256Palavras(msg, saida).forEach((w, i) => got.writeInt32BE(w, i * 4));
    assert.deepEqual(got, esperado, `sha256(${JSON.stringify(msg)})`);
  }
  const d = await criarDesafio(SEGREDO);
  const nonce = cliente.epfResolver(d.split(".")[0], 14, 0, 1e8);
  assert.ok(nonce >= 0);
  assert.deepEqual(await verificarDesafio(SEGREDO, d, String(nonce), 14), { ok: true });
});

test("cookie: cabeçalho e leitura", async () => {
  const passe = await criarPasse(SEGREDO, UA);
  const c = cabecalhoCookie(passe);
  assert.match(c, /^vu_passe=/);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) assert.ok(c.includes(attr), attr);
  assert.equal(lerCookie(`a=1; vu_passe=${passe}; b=2`), passe);
  assert.equal(lerCookie("a=1"), null);
  assert.equal(lerCookie(null), null);
});

// ------------------------------------------------------------ Edge Function inteira

async function edge(ambiente: Record<string, string | undefined>) {
  (globalThis as unknown as { Netlify: unknown }).Netlify = { env: { get: (k: string) => ambiente[k] } };
  return (await import("../netlify/edge-functions/portao.ts")).default;
}

function contexto(deploy = "production") {
  let chamou = false;
  return {
    ctx: { next: async () => { chamou = true; return new Response("APP", { status: 200 }); }, deploy: { context: deploy } },
    chamou: () => chamou,
  };
}

const NAVEGAR = { "user-agent": UA, "sec-fetch-mode": "navigate", accept: "text/html" };

test("Edge Function: desafio, verificação, cookie e passagem", { timeout: 60_000 }, async () => {
  const portao = await edge({ PORTAO_SEGREDO: SEGREDO });
  // 1. Navegacao sem cookie: pagina do desafio.
  let c = contexto();
  let r = await portao(new Request("https://site.exemplo/", { headers: NAVEGAR }), c.ctx);
  assert.equal(r.status, 200);
  assert.equal(c.chamou(), false);
  const html = await r.text();
  assert.match(html, /Verificando que você não é um robô/);
  assert.match(html, /<noscript>/);
  assert.doesNotMatch(html, /<script>(?!<)/, "sem script embutido (CSP)");
  assert.match(r.headers.get("x-robots-tag")!, /noindex/);
  const desafio = /data-desafio="([^"]+)"/.exec(html)![1];
  const bits = Number(/data-bits="(\d+)"/.exec(html)![1]);
  assert.equal(bits, BITS_PADRAO);
  // 2. Arquivo sem cookie: 403.
  c = contexto();
  r = await portao(new Request("https://site.exemplo/assets/app.js", { headers: { "user-agent": UA, "sec-fetch-mode": "cors" } }), c.ctx);
  assert.equal(r.status, 403);
  assert.equal(c.chamou(), false);
  // 3. Rotas do proprio portao respondem sem cookie.
  r = await portao(new Request("https://site.exemplo/__portao/desafio.js"), contexto().ctx);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /javascript/);
  // 4. robots.txt, icone e manifesto passam (o navegador os pede sem cookie).
  for (const livre of ["/robots.txt", "/favicon.ico", "/manifest.webmanifest", "/icons/icone-192.png"]) {
    c = contexto();
    await portao(new Request("https://site.exemplo" + livre), c.ctx);
    assert.equal(c.chamou(), true, livre);
  }
  c = contexto();
  await portao(new Request("https://site.exemplo/icons/../assets/x.js"), c.ctx);
  assert.equal(c.chamou(), false, "sem escapar pela lista de livres");
  // 4b. Landing /sobre/ e sitemap passam sem cookie (indexaveis); /sobre/ perde o noindex.
  const GOOGLEBOT = { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", accept: "text/html" };
  for (const livre of ["/sobre/", "/sobre", "/sobre/index.html", "/sobre/sobre.css", "/sitemap.xml"]) {
    c = contexto();
    r = await portao(new Request("https://site.exemplo" + livre, { headers: GOOGLEBOT }), c.ctx);
    assert.equal(c.chamou(), true, livre);
    assert.equal(r.status, 200, livre);
  }
  r = await portao(new Request("https://site.exemplo/sobre/", { headers: GOOGLEBOT }), contexto().ctx);
  assert.equal(r.headers.get("x-robots-tag"), "index, follow");
  // O app, as Functions e caminhos parecidos continuam barrados para o robo.
  for (const barrado of ["/", "/index.html", "/api/checar", "/sobre/../api/checar", "/sobre/x.js", "/sobrex", "/sitemap.xml.gz"]) {
    c = contexto();
    await portao(new Request("https://site.exemplo" + barrado, { headers: GOOGLEBOT }), c.ctx);
    assert.equal(c.chamou(), false, barrado);
  }
  // 5. Nonce errado: 403, sem cookie.
  const post = (nonce: string, origem = "https://site.exemplo") => new Request("https://site.exemplo/__portao/verificar", {
    method: "POST", headers: { "user-agent": UA, "content-type": "application/json", origin: origem },
    body: JSON.stringify({ desafio, nonce }),
  });
  const nonce = String(cliente.epfResolver(desafio.split(".")[0], bits, 0, 1e9));
  r = await portao(post(nonce, "https://outro.site"), contexto().ctx);
  assert.equal(r.status, 403, "outra origem");
  let errado = Number(nonce) + 1;
  while (zerosIniciais(createHash("sha256").update(desafio.split(".")[0] + errado).digest()) >= bits) errado++;
  r = await portao(post(String(errado)), contexto().ctx);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("set-cookie"), null);
  // 6. Nonce certo: cookie.
  r = await portao(post(nonce), contexto().ctx);
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /^vu_passe=[^;]+; .*HttpOnly/);
  const passe = lerCookie(cookie.split(";")[0])!;
  // 7. Com o cookie: passa direto para o site.
  c = contexto();
  r = await portao(new Request("https://site.exemplo/assets/app.js",
    { headers: { "user-agent": UA, cookie: `vu_passe=${passe}` } }), c.ctx);
  assert.equal(c.chamou(), true);
  assert.equal(await r.text(), "APP");
  // 8. Mesmo cookie noutro navegador: volta o desafio.
  c = contexto();
  r = await portao(new Request("https://site.exemplo/", { headers: { ...NAVEGAR, "user-agent": "Robo/1.0", cookie: `vu_passe=${passe}` } }), c.ctx);
  assert.equal(c.chamou(), false);
  assert.match(await r.text(), /data-desafio/);
});

test("Edge Function: sem segredo fecha em produção e abre no netlify dev", async () => {
  const portao = await edge({});
  let c = contexto("production");
  let r = await portao(new Request("https://site.exemplo/", { headers: NAVEGAR }), c.ctx);
  assert.equal(r.status, 500);
  assert.equal(c.chamou(), false);
  c = contexto("deploy-preview");
  r = await portao(new Request("https://site.exemplo/", { headers: NAVEGAR }), c.ctx);
  assert.equal(r.status, 500);
  c = contexto("dev");
  await portao(new Request("http://localhost:8888/", { headers: NAVEGAR }), c.ctx);
  assert.equal(c.chamou(), true);
});
