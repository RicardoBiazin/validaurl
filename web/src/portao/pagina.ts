/*
 * A pagina do desafio "Verificando que voce nao e' um robo...", servida pela
 * Edge Function. Nada de fora: HTML, CSS e JS saem daqui mesmo, sem script
 * embutido na pagina (a CSP do site so' permite script de arquivo proprio),
 * por isso o JS e o CSS tem rotas proprias em /__portao/.
 */

/** SHA-256 em JS puro para a prova de trabalho. O crypto.subtle e'
 *  assincrono e custa caro por chamada; aqui sao ~500 mil hashes de uma
 *  mensagem curta, entao um SHA-256 sincrono de um bloco e' muito mais rapido.
 *  Os testes conferem este codigo contra o SHA-256 do crypto. */
export const JS_SHA256 = `
var EPF_K = new Uint32Array([
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
var EPF_W = new Uint32Array(64);
/* Primeira palavra (32 bits) do SHA-256 de uma mensagem ASCII de ate' 55 bytes. */
function epfSha256Palavras(msg, saida) {
  var W = EPF_W, K = EPF_K, n = msg.length, i;
  for (i = 0; i < 16; i++) W[i] = 0;
  for (i = 0; i < n; i++) W[i >> 2] |= (msg.charCodeAt(i) & 255) << (24 - (i & 3) * 8);
  W[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
  W[15] = n * 8;
  for (i = 16; i < 64; i++) {
    var x = W[i - 15], y = W[i - 2];
    var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  var a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a,
      e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
  for (i = 0; i < 64; i++) {
    var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  saida[0] = (a + 0x6a09e667) | 0; saida[1] = (b + 0xbb67ae85) | 0; saida[2] = (c + 0x3c6ef372) | 0;
  saida[3] = (d + 0xa54ff53a) | 0; saida[4] = (e + 0x510e527f) | 0; saida[5] = (f + 0x9b05688c) | 0;
  saida[6] = (g + 0x1f83d9ab) | 0; saida[7] = (h + 0x5be0cd19) | 0;
  return saida;
}
function epfZeros(palavras) {
  var n = 0;
  for (var i = 0; i < 8; i++) {
    if (palavras[i] === 0) { n += 32; continue; }
    return n + Math.clz32(palavras[i]);
  }
  return n;
}
/* Procura um nonce em [inicio, fim). Devolve -1 se nao achar. */
function epfResolver(sal, bits, inicio, fim) {
  var h = new Int32Array(8);
  for (var n = inicio; n < fim; n++) {
    if (epfZeros(epfSha256Palavras(sal + n, h)) >= bits) return n;
  }
  return -1;
}
`;

const JS_PAGINA = `
(function () {
  var raiz = document.getElementById("portao");
  var msg = document.getElementById("portao-msg");
  var barra = document.getElementById("portao-barra");
  var desafio = raiz.getAttribute("data-desafio");
  var bits = Number(raiz.getAttribute("data-bits"));
  var sal = desafio.split(".")[0];
  var esperado = Math.pow(2, bits);
  var n = 0, passo = 25000, t0 = Date.now();
  function falhar(texto) {
    msg.textContent = texto;
    raiz.classList.add("erro");
  }
  function enviar(nonce) {
    msg.textContent = "Confirmando…";
    fetch("/__portao/verificar", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desafio: desafio, nonce: String(nonce) })
    }).then(function (r) {
      if (r.ok) { msg.textContent = "Pronto! Abrindo o ValidaURL…"; location.reload(); return; }
      if (r.status === 409) { location.reload(); return; }
      falhar("Não foi possível confirmar. Recarregue a página para tentar de novo.");
    }).catch(function () {
      falhar("Sem conexão. Verifique a internet e recarregue a página.");
    });
  }
  function rodada() {
    var achado = epfResolver(sal, bits, n, n + passo);
    if (achado >= 0) { barra.style.width = "100%"; enviar(achado); return; }
    n += passo;
    // Progresso estimado (o sorteio pode passar da media; a barra satura em 95%).
    var p = Math.min(0.95, 1 - Math.exp(-n / esperado));
    barra.style.width = (p * 100).toFixed(1) + "%";
    if (Date.now() - t0 > 120000) { falhar("Está demorando demais. Recarregue a página."); return; }
    setTimeout(rodada, 0);
  }
  setTimeout(rodada, 30);
})();
`;

export const JS_DESAFIO = JS_SHA256 + JS_PAGINA;

export const CSS_DESAFIO = `
:root { --fundo:#eef0f3; --painel:#fff; --texto:#1d2127; --texto-2:#5b6470; --borda:#d8dce2; --realce:#c62828;
  color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
@media (prefers-color-scheme: dark) {
  :root { --fundo:#15171b; --painel:#1f2228; --texto:#e8eaed; --texto-2:#a3abb6; --borda:#363b44; --realce:#ef5350; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--fundo); color: var(--texto); padding: 16px; }
main { width: 100%; max-width: 440px; background: var(--painel); border: 1px solid var(--borda); border-radius: 16px;
  padding: 32px 24px; text-align: center; box-shadow: 0 4px 14px rgb(0 0 0 / .1); }
.logo { width: 64px; height: 64px; }
h1 { font-size: 1.3rem; margin: 14px 0 6px; }
p { color: var(--texto-2); line-height: 1.5; margin: 6px 0; }
.trilho { height: 8px; border-radius: 4px; background: var(--borda); overflow: hidden; margin: 18px 0 10px; }
#portao-barra { height: 100%; width: 3%; background: var(--realce); transition: width .2s; }
.erro #portao-msg { color: var(--realce); font-weight: 600; }
.nota { font-size: .82rem; }
noscript p { color: var(--realce); font-weight: 600; }
`;

const LOGO = `<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><rect x="10" y="10" width="492" height="492" rx="102" fill="#c62828"/><path d="M138 92H307L374 159V420H138Z" fill="#fff"/><path d="M307 92V159H374Z" fill="#efbebe"/><path d="M174 184H287M174 230H338M174 276H317" stroke="#ced3da" stroke-width="11" stroke-linecap="round"/><path d="M169 353c30-35 52-35 80-8s55 18 90-18" fill="none" stroke="#c62828" stroke-width="15" stroke-linecap="round"/></svg>`;

function escaparAtributo(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function paginaDesafio(desafio: string, bits: number): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Verificando… — ValidaURL</title>
<link rel="stylesheet" href="/__portao/estilo.css">
<script src="/__portao/desafio.js" defer></script>
</head>
<body>
<main id="portao" data-desafio="${escaparAtributo(desafio)}" data-bits="${bits}">
${LOGO}
<h1>Verificando que você não é um robô…</h1>
<p id="portao-msg">Isto leva um ou dois segundos e acontece só de vez em quando.</p>
<div class="trilho"><div id="portao-barra"></div></div>
<p class="nota">Seu navegador resolve uma pequena conta; nenhum dado seu é coletado e nenhum serviço de terceiros é usado.</p>
<noscript><p>O ValidaURL precisa de JavaScript ativado.</p></noscript>
</main>
</body>
</html>`;
}
