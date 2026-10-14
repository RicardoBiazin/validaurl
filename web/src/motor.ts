/*
 * Orquestração no navegador: a fila fica aqui e as Functions só fazem as
 * requisições (lotes pequenos, cada chamada bem abaixo do limite de 10 s).
 */

import { type Checagem, classificar, type Resultado } from "./comum/classificar.ts";
import { deduplicar } from "./comum/entradas.ts";
import { ehRecurso, mesmoSite, normalizar, regrasRobots, robotsPermite, semFragmento } from "./comum/links.ts";

export const LOTE = 10;
export const LOTES_SIMULTANEOS = 3;
export const PAGINAS_SIMULTANEAS = 3;

/** Mesmo texto do desktop (validaurl/rastreador.py). */
export function avisoRedirecionamentoFora(host: string): string {
  return `A página inicial redireciona para ${host}, fora do site informado. O rastreio só segue links ` +
    "dentro do site, então não havia o que seguir. Para checar subdomínios, cole os endereços na aba Lista de URLs.";
}

export class ErroApi extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

const espera = (ms: number, sinal?: AbortSignal) => new Promise<void>((ok, falha) => {
  const t = setTimeout(ok, ms);
  sinal?.addEventListener("abort", () => {
    clearTimeout(t);
    falha(new DOMException("cancelado", "AbortError"));
  }, { once: true });
});

/** POST JSON para a API. 429 espera e tenta de novo (até 3 vezes). */
export async function api<T>(caminho: string, dados: unknown, sinal?: AbortSignal, tentativas = 3): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await fetch(caminho, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados),
      credentials: "same-origin", signal: sinal,
    });
    if (r.status === 429 && i < tentativas) {
      await espera((Number(r.headers.get("retry-after")) || 20) * 1000, sinal);
      continue;
    }
    let corpo: { erro?: string } & Record<string, unknown> = {};
    try {
      corpo = await r.json();
    } catch { /* corpo não-JSON (ex.: 403 do portão em texto) */ }
    if (!r.ok) {
      if (r.status === 403 && !corpo.erro) throw new ErroApi("Sessão expirada: recarregue a página.", 403);
      throw new ErroApi(corpo.erro ?? `Erro ${r.status}`, r.status);
    }
    return corpo as T;
  }
}

export interface Opcoes {
  seguirRedirects: boolean;
  soGet: boolean;
}

export function paraResultado(c: Checagem, encontradoEm = "", seguiu = true): Resultado {
  return { ...c, categoria: classificar(c.status, c.redirects.length, seguiu), encontradoEm };
}

function falhaLocal(url: string, erro: string, encontradoEm = ""): Resultado {
  return { url, status: null, urlFinal: "", redirects: [], tempoMs: 0, erro, tipo: "", metodo: "",
    categoria: classificar(null, 0), encontradoEm };
}

async function emParalelo<T>(itens: T[], n: number, f: (x: T) => Promise<void>, sinal?: AbortSignal) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length && !sinal?.aborted) await f(itens[i++]);
  }));
}

/** Checa uma lista de (url, encontradoEm). */
export async function validarLista(itens: { url: string; encontradoEm?: string }[], op: Opcoes,
  aoResultado: (r: Resultado) => void, sinal?: AbortSignal): Promise<void> {
  const lotes: typeof itens[] = [];
  for (let i = 0; i < itens.length; i += LOTE) lotes.push(itens.slice(i, i + LOTE));
  await emParalelo(lotes, LOTES_SIMULTANEOS, async (lote) => {
    try {
      const { resultados } = await api<{ resultados: Checagem[] }>("/api/checar",
        { urls: lote.map((x) => x.url), seguirRedirects: op.seguirRedirects, soGet: op.soGet }, sinal);
      resultados.forEach((c, j) => aoResultado(paraResultado(c, lote[j].encontradoEm ?? "", op.seguirRedirects)));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof ErroApi && e.status === 403) throw e;
      for (const x of lote) aoResultado(falhaLocal(x.url, `Não checado: ${(e as Error).message}`, x.encontradoEm));
    }
  }, sinal);
}

// ------------------------------------------------------------ sitemap

interface RespPagina {
  checagem: Checagem;
  links?: string[];
  paginas?: string[];
  filhos?: string[];
  robots?: { permitir: string[]; bloquear: string[]; sitemaps: string[] } | null;
  erro?: string;
}

export async function urlsDoSitemap(endereco: string, avisos: string[], sinal?: AbortSignal): Promise<string[]> {
  let iniciais = [endereco];
  const caminho = new URL(endereco).pathname.toLowerCase();
  if (!/\.(xml|gz)$/.test(caminho) && !caminho.includes("sitemap")) {
    const r = await api<RespPagina>("/api/pagina", { url: endereco, modo: "robots" }, sinal);
    iniciais = r.robots?.sitemaps.length ? r.robots.sitemaps : [new URL("/sitemap.xml", endereco).toString()];
  }
  const fila = [...iniciais];
  const vistos = new Set<string>();
  const paginas: string[] = [];
  const erros: string[] = [];
  while (fila.length && vistos.size < 50) {
    const atual = fila.shift()!;
    if (vistos.has(atual)) continue;
    vistos.add(atual);
    const r = await api<RespPagina>("/api/pagina", { url: atual, modo: "sitemap" }, sinal);
    if (r.erro) {
      (iniciais.includes(atual) ? erros : avisos).push(`${atual}: ${r.erro}`);
      continue;
    }
    paginas.push(...(r.paginas ?? []));
    fila.push(...(r.filhos ?? []));
  }
  if (fila.length) avisos.push(`Parei em 50 sitemaps; ${fila.length} ficaram de fora.`);
  if (!paginas.length && erros.length) throw new Error(erros.join("; "));
  return deduplicar(paginas);
}

// ------------------------------------------------------------ rastreio

export interface OpcoesRastreio extends Opcoes {
  maxPaginas: number;
  profundidade: number;
  subdominios: boolean;
  externos: boolean;
  robots: boolean;
}

export interface Progresso {
  concluidos: number;
  agendados: number;
  paginas: number;
}

export async function rastrear(inicioBruto: string, op: OpcoesRastreio, aoResultado: (r: Resultado) => void,
  aoProgresso: (p: Progresso) => void, avisos: string[], sinal?: AbortSignal): Promise<void> {
  const inicio = semFragmento(inicioBruto);
  let regras: { permitir: string[]; bloquear: string[] } | null = null;
  if (op.robots) {
    try {
      regras = (await api<RespPagina>("/api/pagina", { url: inicio, modo: "robots" }, sinal)).robots ?? null;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof ErroApi && e.status === 403) throw e;
    }
  }
  const vistos = new Set<string>();
  const paginas: { url: string; prof: number; origem: string }[] = [];
  const links: { url: string; encontradoEm: string }[] = [];
  let nPaginas = 0;
  let concluidos = 0;
  let avisouLimite = false;
  const progresso = () => aoProgresso({ concluidos, agendados: vistos.size, paginas: nPaginas });

  const agendar = (url: string, prof: number, origem: string) => {
    const k = normalizar(url);
    if (vistos.has(k)) return;
    const interno = mesmoSite(url, inicio, op.subdominios);
    if (!interno && !op.externos) return;
    vistos.add(k);
    if (interno && !ehRecurso(url) && prof <= op.profundidade && (!regras || robotsPermite(regras, url))) {
      if (nPaginas < op.maxPaginas) {
        nPaginas++;
        paginas.push({ url, prof, origem });
        return;
      }
      if (!avisouLimite) {
        avisouLimite = true;
        avisos.push(`Limite de ${op.maxPaginas} páginas atingido: links internos além disso foram só checados.`);
      }
    }
    links.push({ url, encontradoEm: origem });
  };

  agendar(inicio, 0, "");
  const umaPagina = async (p: { url: string; prof: number; origem: string }) => {
    try {
      const r = await api<RespPagina>("/api/pagina",
        { url: p.url, modo: "html", seguirRedirects: op.seguirRedirects }, sinal);
      concluidos++;
      aoResultado(paraResultado(r.checagem, p.origem, op.seguirRedirects));
      const final = r.checagem.urlFinal || p.url;
      if (p.url === inicio && !mesmoSite(final, inicio)) {
        avisos.push(avisoRedirecionamentoFora(new URL(final).hostname));
      }
      if (mesmoSite(final, inicio, op.subdominios)) for (const l of r.links ?? []) agendar(l, p.prof + 1, final);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof ErroApi && e.status === 403) throw e;
      concluidos++;
      aoResultado(falhaLocal(p.url, `Não checado: ${(e as Error).message}`, p.origem));
    }
    progresso();
  };
  const loteLinks = async () => {
    const lote = links.splice(0, LOTE);
    if (!lote.length) return;
    await validarLista(lote, op, (r) => {
      concluidos++;
      aoResultado(r);
    }, sinal);
    progresso();
  };

  // Páginas e links andam juntos: até 3 páginas e 2 lotes de links em voo.
  const emVoo = new Set<Promise<void>>();
  const lancar = (pr: Promise<void>) => {
    emVoo.add(pr);
    pr.finally(() => emVoo.delete(pr));
  };
  let paginasEmVoo = 0;
  let lotesEmVoo = 0;
  while (!sinal?.aborted) {
    while (paginas.length && paginasEmVoo < PAGINAS_SIMULTANEAS) {
      paginasEmVoo++;
      lancar(umaPagina(paginas.shift()!).finally(() => paginasEmVoo--));
    }
    // Lote cheio, ou o que sobrou quando não há mais páginas por vir.
    while (links.length && lotesEmVoo < 2 && (links.length >= LOTE || (!paginas.length && paginasEmVoo === 0))) {
      lotesEmVoo++;
      lancar(loteLinks().finally(() => lotesEmVoo--));
    }
    if (!emVoo.size) break;
    await Promise.race(emVoo);
  }
  progresso();
}
