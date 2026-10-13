/*
 * Portao anti-robo: a logica pura, so' com Web Crypto (roda no Deno da Edge
 * Function do Netlify e no Node dos testes).
 *
 * - PASSE (cookie `vu_passe`): "expira.hmac", com
 *     hmac = HMAC-SHA256(segredo, "passe|" + expira + "|" + sha256(User-Agent)).
 *   Vale 7 dias e so' para o mesmo navegador (User-Agent).
 * - DESAFIO: "sal.expira.hmac", com hmac = HMAC-SHA256(segredo,
 *   "desafio|" + sal + "|" + expira). Vale 5 minutos. O navegador precisa achar
 *   um `nonce` tal que SHA-256(sal + nonce) comece com N bits zero.
 *
 * Os prefixos "passe|" e "desafio|" separam os dominios: a assinatura de um
 * desafio nunca serve como passe, e vice-versa.
 *
 * Sem estado no servidor nao ha' protecao contra reuso: um desafio resolvido
 * pode ser trocado por passes varias vezes dentro dos 5 minutos. E' o limite
 * aceito deste desenho (sem banco de dados).
 */

export const COOKIE = "vu_passe";
export const VALIDADE_PASSE_MS = 7 * 24 * 60 * 60 * 1000;
export const VALIDADE_DESAFIO_MS = 5 * 60 * 1000;
/** Dificuldade: bits zero no inicio do hash. 21 bits = ~2,1 milhoes de
 *  tentativas em media. Medido: o SHA-256 em JS da pagina faz ~2,4 milhoes de
 *  hashes/s no V8 de um PC comum -> ~1 s (celular: 3-5 s). O sorteio varia:
 *  as vezes leva o dobro ou o triplo da media. */
export const BITS_PADRAO = 21;

const enc = new TextEncoder();

export function paraB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function chave(segredo: string): Promise<CryptoKey> {
  if (!segredo || segredo.length < 16) throw new Error("PORTAO_SEGREDO ausente ou curto demais (mínimo 16 caracteres).");
  return crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function assinar(segredo: string, mensagem: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await chave(segredo), enc.encode(mensagem));
  return paraB64url(new Uint8Array(sig));
}

/** Confere a assinatura em tempo constante (crypto.subtle.verify). */
async function conferir(segredo: string, mensagem: string, assinatura: string): Promise<boolean> {
  const sig = deB64url(assinatura);
  if (!sig || sig.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await chave(segredo), sig as unknown as BufferSource, enc.encode(mensagem));
}

export async function sha256(texto: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(texto)));
}

async function hashUA(ua: string): Promise<string> {
  return paraB64url((await sha256(ua)).subarray(0, 16));
}

// ------------------------------------------------------------ passe (cookie)

export async function criarPasse(segredo: string, ua: string, agora = Date.now(),
  validade = VALIDADE_PASSE_MS): Promise<string> {
  const expira = String(Math.floor((agora + validade) / 1000));
  return `${expira}.${await assinar(segredo, `passe|${expira}|${await hashUA(ua)}`)}`;
}

export async function verificarPasse(segredo: string, passe: string | null | undefined, ua: string,
  agora = Date.now()): Promise<boolean> {
  if (!passe) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(passe);
  if (!m) return false;
  if (Number(m[1]) * 1000 <= agora) return false;
  return conferir(segredo, `passe|${m[1]}|${await hashUA(ua)}`, m[2]);
}

export function cabecalhoCookie(passe: string, seguro = true): string {
  return `${COOKIE}=${passe}; Max-Age=${VALIDADE_PASSE_MS / 1000}; Path=/; HttpOnly; SameSite=Lax${seguro ? "; Secure" : ""}`;
}

export function lerCookie(cabecalho: string | null, nome = COOKIE): string | null {
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return v.join("=");
  }
  return null;
}

// ------------------------------------------------------------ desafio

export async function criarDesafio(segredo: string, agora = Date.now(),
  validade = VALIDADE_DESAFIO_MS): Promise<string> {
  const sal = paraB64url(crypto.getRandomValues(new Uint8Array(16)));
  const expira = String(Math.floor((agora + validade) / 1000));
  return `${sal}.${expira}.${await assinar(segredo, `desafio|${sal}|${expira}`)}`;
}

/** Bits zero no inicio de um hash. */
export function zerosIniciais(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export type MotivoRecusa = "formato" | "assinatura" | "expirado" | "trabalho";

export async function verificarDesafio(segredo: string, desafio: unknown, nonce: unknown,
  bits = BITS_PADRAO, agora = Date.now()): Promise<{ ok: true } | { ok: false; motivo: MotivoRecusa }> {
  if (typeof desafio !== "string" || typeof nonce !== "string" || !/^\d{1,16}$/.test(nonce)) {
    return { ok: false, motivo: "formato" };
  }
  const m = /^([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(desafio);
  if (!m) return { ok: false, motivo: "formato" };
  const [, sal, expira, sig] = m;
  if (!(await conferir(segredo, `desafio|${sal}|${expira}`, sig))) return { ok: false, motivo: "assinatura" };
  if (Number(expira) * 1000 <= agora) return { ok: false, motivo: "expirado" };
  if (zerosIniciais(await sha256(sal + nonce)) < bits) return { ok: false, motivo: "trabalho" };
  return { ok: true };
}

/** Resolve um desafio (usado nos testes; a pagina tem a propria copia em JS). */
export async function resolverDesafio(desafio: string, bits = BITS_PADRAO): Promise<string> {
  const sal = desafio.split(".")[0];
  for (let n = 0; ; n++) {
    if (zerosIniciais(await sha256(sal + n)) >= bits) return String(n);
  }
}
