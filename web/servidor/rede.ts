/*
 * Requisições HTTP das Functions, à prova de SSRF.
 *
 * A Function roda dentro da rede do Netlify/AWS: sem estas travas, qualquer um
 * poderia usá-la para sondar endereços internos (169.254.169.254, 10.x...).
 *  - só http/https e portas 80, 443, 8080, 8443;
 *  - o IP é conferido NA HORA DA CONEXÃO (opção `lookup` do http.request), o
 *    que fecha a brecha de "DNS rebinding" (resolver público na checagem e
 *    privado na conexão);
 *  - IP literal na URL também é conferido (o Node não chama `lookup` nesse caso);
 *  - cada redirect passa pelas mesmas travas;
 *  - corpo só é lido para HTML/XML/texto, até 2 MB, e nunca é devolvido inteiro.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";
import type { Checagem } from "../src/comum/classificar.ts";

export const VERSAO_UA = "ValidaURL-web";
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 " +
  VERSAO_UA;
export const PORTAS = new Set(["", "80", "443", "8080", "8443"]);
export const MAX_CORPO = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 10;

const bloqueados = new BlockList();
for (const [rede, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) bloqueados.addSubnet(rede, bits, "ipv4");
for (const [rede, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["100::", 64],
] as const) bloqueados.addSubnet(rede, bits, "ipv6");

let loopbackLiberado = false;
/** SÓ para os testes, que sobem um servidor em 127.0.0.1. Nada em produção chama isto. */
export function liberarLoopbackParaTestes(sim: boolean): void {
  loopbackLiberado = sim;
}

/** IPv6 que embute IPv4 (::ffff:a.b.c.d e ::a.b.c.d) é conferido como IPv4. */
export function ipBloqueado(ip: string): boolean {
  if (loopbackLiberado && (ip.startsWith("127.") || ip === "::1")) return false;
  const v = isIP(ip);
  if (v === 4) return bloqueados.check(ip, "ipv4");
  if (v === 6) {
    const m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) return bloqueados.check(m[1], "ipv4");
    const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (h) {
      const a = parseInt(h[1], 16), b = parseInt(h[2], 16);
      return bloqueados.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, "ipv4");
    }
    return bloqueados.check(ip, "ipv6");
  }
  return true;
}

export class Recusada extends Error {}

/** Motivo para recusar a URL antes de qualquer rede, ou null. */
export function motivoRecusa(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL inválida";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Protocolo não suportado (use http ou https)";
  if (!u.hostname) return "URL sem domínio";
  if (u.username || u.password) return "URL com usuário/senha não é aceita";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopbackDeTeste = loopbackLiberado && (host.startsWith("127.") || host === "::1");
  if (!PORTAS.has(u.port) && !loopbackDeTeste) return "Porta não permitida (só 80, 443, 8080 e 8443)";
  if (isIP(host) && ipBloqueado(host)) return "Endereço interno bloqueado";
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    return "Endereço interno bloqueado";
  }
  return null;
}

type CbLookup = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `lookup` que recusa IP interno. Respeita `all` (o Node 20+ pede todos os endereços). */
export function lookupSeguro(host: string, opcoes: { all?: boolean; family?: number } | number, cb: CbLookup): void {
  const op = typeof opcoes === "number" ? { family: opcoes } : (opcoes ?? {});
  dnsLookup(host, { all: true, family: op.family ?? 0, verbatim: true }, (err, enderecos) => {
    if (err) return cb(err, "", 4);
    const lista = enderecos as LookupAddress[];
    const bons = lista.filter((e) => !ipBloqueado(e.address));
    if (!bons.length || bons.length !== lista.length) {
      const e = new Recusada("Endereço interno bloqueado") as NodeJS.ErrnoException;
      e.code = "EBLOQUEADO";
      return cb(e, "", 4);
    }
    if (op.all) return cb(null, bons);
    cb(null, bons[0].address, bons[0].family);
  });
}

interface Resposta {
  status: number;
  local: string | null;
  tipo: string;
  corpo: Buffer | null;
}

const EH_TEXTO = (tipo: string) => !tipo || /html|xml|^text\/|gzip|octet-stream/.test(tipo);

function umaRequisicao(metodo: string, url: string, lerCorpo: boolean, prazo: number, sinal?: AbortSignal):
  Promise<Resposta> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const modulo = u.protocol === "https:" ? https : http;
    const restante = prazo - Date.now();
    if (restante <= 0) return reject(new Error("Tempo esgotado"));
    const req = modulo.request(u, {
      method: metodo,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Accept-Encoding": lerCorpo ? "gzip, deflate, br" : "identity",
      },
      lookup: lookupSeguro as never,
      timeout: restante,
      signal: sinal,
    }, (res) => {
      const tipo = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const status = res.statusCode ?? 0;
      const local = typeof res.headers.location === "string" ? res.headers.location : null;
      if (!lerCorpo || metodo !== "GET" || status >= 300 || !EH_TEXTO(tipo)) {
        res.destroy();
        return resolve({ status, local, tipo, corpo: null });
      }
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      let fluxo: NodeJS.ReadableStream = res;
      if (enc === "gzip" || enc === "x-gzip") fluxo = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") fluxo = res.pipe(zlib.createInflate());
      else if (enc === "br") fluxo = res.pipe(zlib.createBrotliDecompress());
      const pedacos: Buffer[] = [];
      let total = 0;
      let acabou = false;
      const fim = () => {
        if (acabou) return;
        acabou = true;
        res.destroy();
        resolve({ status, local, tipo, corpo: Buffer.concat(pedacos).subarray(0, MAX_CORPO) });
      };
      fluxo.on("data", (b: Buffer) => {
        pedacos.push(b);
        total += b.length;
        if (total >= MAX_CORPO) fim();
      });
      fluxo.on("end", fim);
      fluxo.on("error", (e) => (acabou ? undefined : (total ? fim() : reject(e))));
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado")));
    req.on("error", reject);
    req.end();
  });
}

export function descreverErro(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { cause?: { code?: string } };
  const codigo = err?.code ?? err?.cause?.code ?? "";
  const msg = String(err?.message ?? e);
  if (e instanceof Recusada || codigo === "EBLOQUEADO") return "Endereço interno bloqueado";
  if (/Tempo esgotado|ETIMEDOUT|timeout/i.test(msg) || codigo === "ETIMEDOUT") return "Tempo esgotado";
  if (codigo === "ENOTFOUND" || codigo === "EAI_AGAIN") return "Domínio não encontrado (DNS)";
  if (codigo === "ECONNREFUSED") return "Conexão recusada";
  if (codigo === "ECONNRESET") return "Conexão interrompida pelo servidor";
  if (/CERT|SSL|TLS|self.signed|certificate/i.test(codigo + msg)) return `Erro de certificado/SSL: ${codigo || msg}`;
  if (err?.name === "AbortError") return "Cancelado";
  return `Falha de conexão: ${codigo || msg}`;
}

export interface OpcoesChecagem {
  seguirRedirects?: boolean;
  soGet?: boolean;
  lerCorpo?: boolean;
  timeoutMs?: number;
  sinal?: AbortSignal;
}

/** Checa uma URL: HEAD e, se falhar ou der >= 400, GET (muitos servidores tratam HEAD errado). */
export async function checar(url: string, op: OpcoesChecagem = {}): Promise<Checagem & { corpo: Buffer | null }> {
  const inicio = Date.now();
  const prazo = inicio + (op.timeoutMs ?? 7000);
  const r: Checagem & { corpo: Buffer | null } = {
    url, status: null, urlFinal: "", redirects: [], tempoMs: 0, erro: "", tipo: "", metodo: "", corpo: null,
  };
  const recusa = motivoRecusa(url);
  if (recusa) {
    r.erro = recusa;
    return r;
  }
  const metodos = op.soGet || op.lerCorpo ? ["GET"] : ["HEAD", "GET"];
  for (let i = 0; i < metodos.length; i++) {
    const metodo = metodos[i];
    const ultimo = i === metodos.length - 1;
    const redirects: { status: number; url: string }[] = [];
    let atual = url;
    const vistos = new Set([url]);
    try {
      for (;;) {
        const resp = await umaRequisicao(metodo, atual, !!op.lerCorpo, prazo, op.sinal);
        if ([301, 302, 303, 307, 308].includes(resp.status) && resp.local && op.seguirRedirects !== false) {
          const proxima = new URL(resp.local, atual).toString();
          redirects.push({ status: resp.status, url: atual });
          if (vistos.has(proxima)) throw new Error(`Loop de redirect em ${proxima}`);
          if (redirects.length >= MAX_REDIRECTS) throw new Error(`Mais de ${MAX_REDIRECTS} redirects`);
          const motivo = motivoRecusa(proxima);
          if (motivo) throw new Error(`Redirect recusado (${motivo}): ${proxima}`);
          vistos.add(proxima);
          atual = proxima;
          continue;
        }
        Object.assign(r, { status: resp.status, urlFinal: atual, redirects, tipo: resp.tipo, metodo, erro: "",
          corpo: resp.corpo });
        break;
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      r.status = null;
      r.metodo = metodo;
      r.erro = /^(Loop|Mais de|Redirect recusado)/.test(msg) ? msg : descreverErro(e);
      if (ultimo || r.erro === "Tempo esgotado" || /DNS|recusada|bloqueado/.test(r.erro)) break;
      continue;
    }
    if ((r.status ?? 0) < 400 || ultimo) break;
  }
  if (r.status !== null && r.status >= 400 && !r.erro) r.erro = http.STATUS_CODES[r.status] ?? "";
  r.tempoMs = Date.now() - inicio;
  return r;
}

/** Executa tarefas com no máximo `n` simultâneas. */
export async function emParalelo<T, R>(itens: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = new Array(itens.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await f(itens[i]);
    }
  }));
  return saida;
}

/** POST de JSON para um webhook do usuário, com as mesmas travas de SSRF. */
export function postarJson(url: string, dados: unknown, timeoutMs = 8000): Promise<number> {
  const recusa = motivoRecusa(url);
  if (recusa) return Promise.reject(new Error(recusa));
  const corpo = Buffer.from(JSON.stringify(dados));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": corpo.length,
        "User-Agent": VERSAO_UA },
      lookup: lookupSeguro as never,
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      const s = res.statusCode ?? 0;
      if (s >= 400) reject(new Error(`O webhook respondeu ${s}`));
      else resolve(s);
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado")));
    req.on("error", (e) => reject(new Error(descreverErro(e))));
    req.end(corpo);
  });
}
