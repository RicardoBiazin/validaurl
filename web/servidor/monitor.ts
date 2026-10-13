/*
 * Monitores da versão web: guardados no Netlify Blobs, checados pela Function
 * agendada (a cada 5 min) e com avisos por e-mail (Resend), webhook e
 * notificação push do navegador.
 *
 * Não há login: quem cria recebe um link secreto (id + chave). O servidor só
 * guarda o SHA-256 da chave. Limites existem para o serviço não virar robô de
 * terceiros: poucas URLs por monitor, intervalo mínimo de 5 min, poucos
 * monitores por IP por dia e e-mail só depois de confirmado (dupla
 * confirmação: ninguém recebe aviso que não pediu).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { classificar, ehProblema } from "../src/comum/classificar.ts";
import { deduplicar } from "../src/comum/entradas.ts";
import { checar, emParalelo, motivoRecusa, postarJson } from "./rede.ts";
import { lerSitemap } from "./sitemap.ts";

export const MAX_URLS = 25;
export const INTERVALOS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];
export const MAX_MONITORES = 300;
export const CRIACOES_POR_IP_DIA = 5;
export const MAX_PUSH = 5;
export const MAX_HISTORICO = 96;

// ------------------------------------------------------------ armazenamento

export interface Armazem {
  get(chave: string): Promise<unknown | null>;
  set(chave: string, valor: unknown): Promise<void>;
  delete(chave: string): Promise<void>;
  list(prefixo: string): Promise<string[]>;
}

export function armazemMemoria(): Armazem & { dados: Map<string, string> } {
  const dados = new Map<string, string>();
  return {
    dados,
    async get(k) {
      const v = dados.get(k);
      return v === undefined ? null : JSON.parse(v);
    },
    async set(k, v) {
      dados.set(k, JSON.stringify(v));
    },
    async delete(k) {
      dados.delete(k);
    },
    async list(p) {
      return [...dados.keys()].filter((k) => k.startsWith(p));
    },
  };
}

export async function armazemBlobs(): Promise<Armazem> {
  const { getStore } = await import("@netlify/blobs");
  const loja = getStore({ name: "monitores", consistency: "strong" });
  return {
    get: (k) => loja.get(k, { type: "json" }),
    set: async (k, v) => {
      await loja.setJSON(k, v);
    },
    delete: (k) => loja.delete(k),
    list: async (p) => (await loja.list({ prefix: p })).blobs.map((b) => b.key),
  };
}

// ------------------------------------------------------------ modelo

export interface ResultadoCurto {
  url: string;
  status: number | null;
  categoria: string;
  erro: string;
  tempoMs: number;
  urlFinal: string;
}

export interface Monitor {
  id: string;
  chaveHash: string;
  nome: string;
  tipo: "lista" | "sitemap";
  urls: string[];
  sitemap: string;
  intervaloMin: number;
  ativo: boolean;
  criadoEm: string;
  proximaEm: number;
  ultimaEm: number;
  resultados: ResultadoCurto[];
  historico: { em: number; total: number; problemas: number }[];
  avisos: {
    email: { endereco: string; confirmado: boolean; token: string } | null;
    webhook: string;
    push: PushAssinatura[];
    repetirProblemas: boolean;
    avisarRecuperacao: boolean;
  };
  ultimoErroAviso: string;
}

export interface PushAssinatura {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** O que o dono vê (sem hash, sem token, sem as chaves de push). */
export function publico(m: Monitor) {
  const { chaveHash: _c, avisos, ...resto } = m;
  return {
    ...resto,
    avisos: {
      email: avisos.email ? { endereco: avisos.email.endereco, confirmado: avisos.email.confirmado } : null,
      webhook: avisos.webhook,
      push: avisos.push.length,
      repetirProblemas: avisos.repetirProblemas,
      avisarRecuperacao: avisos.avisarRecuperacao,
    },
  };
}

export const hashChave = (chave: string) => createHash("sha256").update(chave).digest("hex");
export const novoId = () => randomBytes(9).toString("base64url");
export const novaChave = () => randomBytes(24).toString("base64url");

export function chaveConfere(m: Monitor, chave: unknown): boolean {
  if (typeof chave !== "string" || chave.length > 100) return false;
  const a = Buffer.from(hashChave(chave), "hex");
  const b = Buffer.from(m.chaveHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@<>()"',;]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,}$/i;

export interface Entrada {
  nome?: unknown;
  tipo?: unknown;
  urls?: unknown;
  sitemap?: unknown;
  intervaloMin?: unknown;
  ativo?: unknown;
  email?: unknown;
  webhook?: unknown;
  repetirProblemas?: unknown;
  avisarRecuperacao?: unknown;
}

export interface Campos {
  nome: string;
  tipo: "lista" | "sitemap";
  urls: string[];
  sitemap: string;
  intervaloMin: number;
  email: string;
  webhook: string;
  repetirProblemas: boolean;
  avisarRecuperacao: boolean;
  ativo: boolean;
}

/** Valida a entrada do formulário. Devolve a mensagem de erro ou os campos limpos. */
export function validar(e: Entrada): string | Campos {
  const nome = typeof e.nome === "string" ? e.nome.trim().slice(0, 80) : "";
  const tipo = e.tipo === "sitemap" ? "sitemap" : "lista";
  const intervaloMin = Number(e.intervaloMin);
  if (!INTERVALOS.includes(intervaloMin)) return "Intervalo inválido.";
  let urls: string[] = [];
  let sitemap = "";
  if (tipo === "lista") {
    if (!Array.isArray(e.urls) || !e.urls.every((u) => typeof u === "string")) return "Lista de URLs inválida.";
    urls = deduplicar((e.urls as string[]).map((u) => u.trim()).filter(Boolean));
    if (!urls.length) return "Informe pelo menos uma URL.";
    if (urls.length > MAX_URLS) return `No máximo ${MAX_URLS} URLs por monitor.`;
    for (const u of urls) {
      const r = motivoRecusa(u);
      if (r) return `${u}: ${r}`;
    }
  } else {
    sitemap = typeof e.sitemap === "string" ? e.sitemap.trim() : "";
    const r = motivoRecusa(sitemap);
    if (r) return `Sitemap: ${r}`;
  }
  const email = typeof e.email === "string" ? e.email.trim().toLowerCase() : "";
  if (email && !EMAIL.test(email)) return "E-mail inválido.";
  const webhook = typeof e.webhook === "string" ? e.webhook.trim() : "";
  if (webhook) {
    const r = motivoRecusa(webhook);
    if (r) return `Webhook: ${r}`;
    if (!webhook.startsWith("https://")) return "O webhook precisa ser https.";
  }
  return {
    nome: nome || (tipo === "lista" ? urls[0] : sitemap), tipo, urls, sitemap, intervaloMin, email, webhook,
    repetirProblemas: e.repetirProblemas === true, avisarRecuperacao: e.avisarRecuperacao !== false,
    ativo: e.ativo !== false,
  };
}

// ------------------------------------------------------------ execução

export async function urlsDoMonitor(m: Monitor, timeoutMs = 6000): Promise<{ urls: string[]; erro: string }> {
  if (m.tipo === "lista") return { urls: m.urls, erro: "" };
  const { corpo, ...c } = await checar(m.sitemap, { lerCorpo: true, timeoutMs });
  if (c.status !== 200 || !corpo) {
    return { urls: [], erro: c.status === null ? c.erro : `O sitemap respondeu ${c.status}${c.erro ? ` (${c.erro})` : ""}` };
  }
  try {
    const { paginas } = lerSitemap(corpo);
    return { urls: deduplicar(paginas).slice(0, MAX_URLS), erro: "" };
  } catch (e) {
    return { urls: [], erro: `Sitemap ilegível: ${(e as Error).message}` };
  }
}

export interface Mudancas {
  novos: ResultadoCurto[];
  recuperados: ResultadoCurto[];
  ainda: ResultadoCurto[];
  total: number;
}

export function comparar(antes: ResultadoCurto[] | null, agora: ResultadoCurto[]): Mudancas {
  const mapa = new Map((antes ?? []).map((r) => [r.url, ehProblema(r.categoria)]));
  const m: Mudancas = { novos: [], recuperados: [], ainda: [], total: agora.length };
  for (const r of agora) {
    const tinha = mapa.get(r.url);
    const tem = ehProblema(r.categoria);
    if (tem && !tinha) m.novos.push(r);
    else if (tem) m.ainda.push(r);
    else if (tinha) m.recuperados.push(r);
  }
  return m;
}

export function haAviso(m: Mudancas, mon: Monitor): boolean {
  return m.novos.length > 0 || (mon.avisos.avisarRecuperacao && m.recuperados.length > 0) ||
    (mon.avisos.repetirProblemas && m.ainda.length > 0);
}

/** Checa o monitor. Padrão da agenda: 13 de cada vez, 5 s por URL (2 rodadas = 10 s).
 *  Na checagem manual (Function de 10 s) usar tudo de uma vez e prazo curto. */
export async function executar(m: Monitor, agora = Date.now(), timeoutMs = 5000, paralelos = 13):
  Promise<{ resultados: ResultadoCurto[]; mudancas: Mudancas }> {
  const { urls, erro } = await urlsDoMonitor(m, Math.min(timeoutMs, 6000));
  let resultados: ResultadoCurto[];
  if (erro) {
    resultados = [{ url: m.sitemap, status: null, categoria: classificar(null, 0), erro, tempoMs: 0, urlFinal: "" }];
  } else {
    resultados = await emParalelo(urls, paralelos, async (url) => {
      const { corpo: _, ...c } = await checar(url, { timeoutMs });
      return { url, status: c.status, categoria: classificar(c.status, c.redirects.length), erro: c.erro,
        tempoMs: c.tempoMs, urlFinal: c.urlFinal !== url ? c.urlFinal : "" };
    });
  }
  const mudancas = comparar(m.ultimaEm ? m.resultados : null, resultados);
  m.resultados = resultados;
  m.ultimaEm = agora;
  m.proximaEm = agora + m.intervaloMin * 60_000;
  m.historico = [...m.historico, { em: agora, total: resultados.length,
    problemas: resultados.filter((r) => ehProblema(r.categoria)).length }].slice(-MAX_HISTORICO);
  return { resultados, mudancas };
}

// ------------------------------------------------------------ avisos

export interface Ambiente {
  baseUrl: string;
  resendChave?: string;
  remetente?: string;
  vapid?: { publica: string; privada: string; contato: string };
  /** Injetáveis nos testes. */
  enviarEmail?: (para: string, assunto: string, texto: string) => Promise<void>;
  enviarPush?: (a: PushAssinatura, dados: string) => Promise<void>;
  postar?: (url: string, dados: unknown) => Promise<number>;
}

export function ambienteDoProcesso(): Ambiente {
  const env = process.env;
  return {
    baseUrl: (env.URL ?? "http://localhost:8888").replace(/\/$/, ""),
    resendChave: env.RESEND_API_KEY,
    remetente: env.AVISO_REMETENTE ?? "ValidaURL <avisos@biazin.com.br>",
    vapid: env.VAPID_PUBLICA && env.VAPID_PRIVADA
      ? { publica: env.VAPID_PUBLICA, privada: env.VAPID_PRIVADA, contato: env.VAPID_CONTATO ?? "mailto:avisos@biazin.com.br" }
      : undefined,
  };
}

export const emailDisponivel = (a: Ambiente) => !!(a.enviarEmail || a.resendChave);

export async function enviarEmail(a: Ambiente, para: string, assunto: string, texto: string): Promise<void> {
  if (a.enviarEmail) return a.enviarEmail(para, assunto, texto);
  if (!a.resendChave) throw new Error("E-mail não configurado no servidor (RESEND_API_KEY).");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${a.resendChave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: a.remetente, to: [para], subject: assunto, text: texto }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Resend respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function enviarPush(a: Ambiente, s: PushAssinatura, dados: string): Promise<void> {
  if (a.enviarPush) return a.enviarPush(s, dados);
  if (!a.vapid) throw new Error("Push não configurado no servidor (VAPID).");
  const webpush = (await import("web-push")).default;
  await webpush.sendNotification(s, dados, {
    vapidDetails: { subject: a.vapid.contato, publicKey: a.vapid.publica, privateKey: a.vapid.privada },
    TTL: 3600, timeout: 6000,
  });
}

function linha(r: ResultadoCurto): string {
  return `  [${r.status ?? "---"}] ${r.url}${r.erro ? ` (${r.erro})` : ""}`;
}

export function textoAviso(mon: Monitor, m: Mudancas, a: Ambiente): { assunto: string; texto: string; curto: string } {
  const problemas = m.novos.length + m.ainda.length;
  const assunto = m.novos.length
    ? `[ValidaURL] ${m.novos.length} link(s) com problema em ${mon.nome}`
    : problemas ? `[ValidaURL] ${problemas} link(s) com problema em ${mon.nome}`
      : `[ValidaURL] Tudo OK de novo em ${mon.nome}`;
  const partes = [`Checagem de "${mon.nome}" em ${new Date(mon.ultimaEm).toLocaleString("pt-BR",
    { timeZone: "America/Sao_Paulo" })}: ${m.total} URLs, ${problemas} com problema.`];
  if (m.novos.length) partes.push("\nPassaram a falhar:\n" + m.novos.map(linha).join("\n"));
  if (mon.avisos.avisarRecuperacao && m.recuperados.length) {
    partes.push("\nVoltaram ao normal:\n" + m.recuperados.map(linha).join("\n"));
  }
  if (mon.avisos.repetirProblemas && m.ainda.length) {
    partes.push("\nContinuam com problema:\n" + m.ainda.map(linha).join("\n"));
  }
  partes.push(`\nVer o monitor: ${a.baseUrl}/#monitor=${mon.id}`);
  const curto = m.novos.length ? `${m.novos.length} link(s) passaram a falhar` :
    problemas ? `${problemas} link(s) continuam com problema` : `${m.recuperados.length} link(s) voltaram ao normal`;
  return { assunto, texto: partes.join("\n"), curto };
}

/** Formato aceito por cada serviço (igual ao desktop, validaurl/avisos.py).
 *  Google Chat recusa com 400 qualquer campo fora do recurso Message: só {text},
 *  título em *negrito*. Discord quer "content" (até 2000), Slack quer "text". */
export function adaptarAoDestino(url: string, dados: { text: string } & Record<string, unknown>): Record<string, unknown> {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch { /* fica o JSON completo */ }
  const texto = dados.text;
  if (host === "chat.googleapis.com") {
    const i = texto.indexOf("\n");
    const titulo = i < 0 ? texto : texto.slice(0, i);
    const resto = i < 0 ? "" : texto.slice(i + 1);
    return { text: `*${titulo}*\n${resto}`.slice(0, 4000) };
  }
  if (["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host)) {
    return { content: texto.slice(0, 2000) };
  }
  if (host === "hooks.slack.com") return { text: texto.slice(0, 39000) };
  return dados;
}

/** Envia os avisos. Devolve os erros; assinaturas push vencidas (404/410) saem do monitor. */
export async function avisar(mon: Monitor, m: Mudancas, a: Ambiente, teste = false): Promise<string[]> {
  if (!teste && !haAviso(m, mon)) return [];
  const { assunto, texto, curto } = textoAviso(mon, m, a);
  const erros: string[] = [];
  const email = mon.avisos.email;
  if (email?.confirmado) {
    const sair = `${a.baseUrl}/api/confirmar?id=${mon.id}&token=${email.token}&sair=1`;
    try {
      await enviarEmail(a, email.endereco, assunto, `${texto}\n\nNão quer mais estes e-mails? ${sair}`);
    } catch (e) {
      erros.push(`E-mail: ${(e as Error).message}`);
    }
  }
  if (mon.avisos.webhook) {
    const item = (r: ResultadoCurto) => ({ url: r.url, status: r.status, categoria: r.categoria, erro: r.erro });
    const dados = {
      text: `${assunto}\n${texto}`, content: `${assunto}\n${texto}`.slice(0, 1990), origem: "ValidaURL web",
      monitor: mon.nome, quando: new Date(mon.ultimaEm || Date.now()).toISOString(), total: m.total,
      novos_problemas: m.novos.map(item), recuperados: m.recuperados.map(item), ainda_com_problema: m.ainda.map(item),
    };
    try {
      await (a.postar ?? postarJson)(mon.avisos.webhook, adaptarAoDestino(mon.avisos.webhook, dados));
    } catch (e) {
      erros.push(`Webhook: ${(e as Error).message}`);
    }
  }
  if (mon.avisos.push.length) {
    const dados = JSON.stringify({ titulo: `ValidaURL: ${mon.nome}`, corpo: curto, url: `/#monitor=${mon.id}` });
    const validas: PushAssinatura[] = [];
    for (const s of mon.avisos.push) {
      try {
        await enviarPush(a, s, dados);
        validas.push(s);
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st !== 404 && st !== 410) {
          validas.push(s);
          erros.push(`Push: ${(e as Error).message}`);
        }
      }
    }
    mon.avisos.push = validas;
  }
  mon.ultimoErroAviso = erros.join(" | ");
  return erros;
}

// ------------------------------------------------------------ agenda

/** Roda os monitores vencidos dentro do orçamento de tempo da Function agendada. */
export async function rodarVencidos(loja: Armazem, a: Ambiente, agora = Date.now(), orcamentoMs = 12_000,
  paralelos = 4): Promise<{ rodados: number; pendentes: number }> {
  const inicio = Date.now();
  const chaves = await loja.list("monitor/");
  const todos = (await emParalelo(chaves, 16, (k) => loja.get(k) as Promise<Monitor | null>))
    .filter((m): m is Monitor => !!m && m.ativo && m.proximaEm <= agora)
    .sort((x, y) => x.proximaEm - y.proximaEm);
  let rodados = 0;
  let i = 0;
  await Promise.all(Array.from({ length: paralelos }, async () => {
    while (i < todos.length && Date.now() - inicio < orcamentoMs) {
      const m = todos[i++];
      const { mudancas } = await executar(m, Date.now());
      await avisar(m, mudancas, a);
      await loja.set(`monitor/${m.id}`, m);
      rodados++;
    }
  }));
  return { rodados, pendentes: todos.length - rodados };
}
