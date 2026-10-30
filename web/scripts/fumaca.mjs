/*
 * Fumaça do ValidaURL web num Chrome/Edge headless de verdade (CDP).
 *
 *   node scripts/fumaca.mjs                       contra o `netlify dev` (http://localhost:8888)
 *   node scripts/fumaca.mjs --url=https://...     contra o site publicado (passa pelo portão anti-robô)
 *   node scripts/fumaca.mjs --monitor             também cria, checa e exclui um monitor
 *
 * Confere: portão resolvido, versão na tela, lista validada pelas Functions
 * (200 e 404 de verdade), filtro, CSV, rastreio curto, aba Monitores e
 * nenhuma violação de CSP / erro de console.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const URL_APP = (arg("url") ?? "http://localhost:8888").replace(/\/?$/, "/");
const COM_MONITOR = process.argv.includes("--monitor");
const versao = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const chrome = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((c) => existsSync(c));
if (!chrome) {
  console.log("Nenhum Chrome/Edge encontrado; defina CHROME=caminho.");
  process.exit(2);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const falhas = [];
const ok = (cond, msg) => {
  console.log(`${cond ? "ok    " : "FALHOU"} ${msg}`);
  if (!cond) falhas.push(msg);
};

const perfil = join(tmpdir(), "validaurl-fumaca-perfil");
rmSync(perfil, { recursive: true, force: true });
const nav = spawn(chrome, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${perfil}`, "--no-first-run",
  "--no-default-browser-check", "--disable-component-update", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let alvo;
for (let i = 0; i < 50 && !alvo; i++) {
  try {
    alvo = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page");
  } catch { /* abrindo */ }
  await espera(200);
}
if (!alvo) throw new Error("não conectou ao navegador");
const ws = new WebSocket(alvo.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pend = new Map();
const erros = [];
const dialogos = [];
const respostasRuins = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    m.error ? p.no(new Error(m.error.message)) : p.ok(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    erros.push("exceção: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    erros.push("log: " + m.params.entry.text);
  } else if (m.method === "Network.responseReceived" && m.params.response.status >= 400) {
    respostasRuins.push(`${m.params.response.status} ${m.params.response.url}`);
  } else if (m.method === "Page.javascriptDialogOpening") {
    dialogos.push(m.params.message);
    void cdp("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
  }
});
const cdp = (method, params = {}, ms = 20000) => new Promise((res, no) => {
  const id = ++seq;
  const t = setTimeout(() => {
    pend.delete(id);
    no(new Error(`${method}: sem resposta`));
  }, ms);
  pend.set(id, { ok: (v) => (clearTimeout(t), res(v)), no: (e) => (clearTimeout(t), no(e)) });
  ws.send(JSON.stringify({ id, method, params }));
});
const avaliar = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const aguardar = async (expr, ms = 30000) => {
  for (const fim = Date.now() + ms; Date.now() < fim; await espera(250)) {
    try {
      if (await avaliar(expr)) return true;
    } catch { /* página trocando */ }
  }
  return false;
};

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Network.enable");
  await cdp("Page.navigate", { url: URL_APP });
  // O portão (se houver) resolve a prova de trabalho e recarrega sozinho.
  ok(await aguardar("!!document.getElementById('versao')?.textContent", 60000), "app carregou (portão resolvido, se houver)");
  ok(await avaliar("document.getElementById('versao').textContent") === versao, `versão ${versao} na tela`);
  ok(await avaliar("document.querySelectorAll('.descricao').length === 4"), "descrição em cada uma das 4 abas");

  const urls = ["https://www.google.com/", "https://www.google.com/nao-existe-validaurl-" + Date.now()];
  await avaliar(`(() => { const t = document.getElementById('txt-lista'); t.value = ${JSON.stringify(urls.join("\n"))};
    t.dispatchEvent(new Event('input')); document.getElementById('bt-validar').click(); })()`);
  ok(await aguardar("document.querySelectorAll('#tabela tbody tr').length === 2 && !document.getElementById('bt-validar').disabled"),
    "lista de 2 URLs validada pelas Functions");
  const linhas = await avaliar(`[...document.querySelectorAll('#tabela tbody tr')].map(tr => [tr.cells[0].textContent, tr.cells[1].textContent, tr.className])`);
  const porUrl = Object.fromEntries(linhas.map(([u, s, c]) => [u, { s, c }]));
  ok(porUrl[urls[0]]?.s === "200" && porUrl[urls[0]]?.c === "ok", `200 em ${urls[0]} (${JSON.stringify(porUrl[urls[0]])})`);
  ok(porUrl[urls[1]]?.s === "404" && porUrl[urls[1]]?.c === "e4", `404 na página inexistente (${JSON.stringify(porUrl[urls[1]])})`);
  await avaliar("(() => { const c = document.getElementById('cb-filtro'); c.value = 'Só problemas'; c.dispatchEvent(new Event('change')); })()");
  ok(await aguardar("document.querySelectorAll('#tabela tbody tr').length === 1", 3000), "filtro 'Só problemas'");
  ok(await avaliar("localStorage.getItem('vu_lista')?.includes('google')"), "lista lembrada no navegador");

  // SSRF pelo navegador: a Function recusa endereço interno.
  const ssrf = await avaliar(`fetch('/api/checar', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({urls:['http://169.254.169.254/latest/meta-data/','http://127.0.0.1/']})}).then(r => r.json())`);
  ok(ssrf.resultados?.every((r) => /bloqueado/.test(r.erro)), "Function recusa 169.254.169.254 e 127.0.0.1");

  // Rastreio curto do próprio site (2 páginas).
  await avaliar(`(() => { const c = document.getElementById('cb-filtro'); c.value = 'Todas'; c.dispatchEvent(new Event('change'));
    document.querySelector('[data-aba=rastreio]').click();
    document.getElementById('ed-site').value = 'https://example.com/\\nhttps://example.org/'; document.getElementById('sp-paginas').value = '5';
    document.getElementById('ck-externos').checked = true; document.getElementById('bt-validar').click(); })()`);
  ok(await aguardar("!document.getElementById('bt-validar').disabled && document.querySelectorAll('#tabela tbody tr').length >= 2", 60000),
    "rastreio curto concluído (example.com + o link externo dele)");
  const origem = await avaliar("[...document.querySelectorAll('#tabela tbody tr')].map(tr => tr.cells[8].textContent).filter(Boolean)");
  ok(origem.includes("https://example.com/"), "coluna 'Encontrado em' preenchida");

  await avaliar("document.querySelector('[data-aba=monitores]').click()");
  ok(await aguardar("[...document.querySelectorAll('#monitores button')].some(b => b.textContent === 'Novo monitor')", 10000),
    "aba Monitores abre");
  if (COM_MONITOR) {
    await avaliar(`[...document.querySelectorAll('#monitores button')].find(b => b.textContent === 'Novo monitor').click()`);
    ok(await aguardar("!!document.querySelector('.form-monitor')", 10000), "formulário de monitor");
    await avaliar(`(() => { const f = document.querySelector('.form-monitor');
      f.querySelector('input[type=text]').value = 'Fumaça';
      f.querySelector('textarea').value = 'https://www.google.com/';
      f.requestSubmit(); })()`);
    ok(await aguardar("document.querySelector('#monitores h2')?.textContent.startsWith('Fumaça') && document.querySelectorAll('#monitores tbody tr').length === 1", 30000),
      "monitor criado e checado");
    await avaliar(`[...document.querySelectorAll('#monitores button')].find(b => b.textContent === 'Excluir').click()`);
    ok(await aguardar("[...document.querySelectorAll('#monitores button')].some(b => b.textContent === 'Novo monitor')", 15000),
      "monitor excluído");
  }

  const csp = erros.filter((e) => /Content Security Policy|Refused/.test(e));
  ok(csp.length === 0, `sem violação de CSP${csp.length ? ": " + csp.join(" | ") : ""}`);
  const outros = erros.filter((e) => !csp.includes(e) && !/favicon|404 \(\)|status of 404/.test(e));
  ok(outros.length === 0, `sem erro de console${outros.length ? ": " + outros.join(" | ") : ""}`);
  if (dialogos.length) console.log("Diálogos:", dialogos);
  if (respostasRuins.length) console.log("Respostas >= 400:", respostasRuins);
} catch (e) {
  ok(false, "roteiro: " + e.message);
  if (erros.length) console.log("Erros do navegador:", erros);
  if (respostasRuins.length) console.log("Respostas >= 400:", respostasRuins);
} finally {
  ws.close();
  nav.kill();
}
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : "\nFUMAÇA OK");
process.exit(falhas.length ? 1 : 0);
