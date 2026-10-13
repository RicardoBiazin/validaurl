/* URLs de texto livre: mesmas regras de validaurl/entradas.py. */

import { normalizar } from "./links.ts";

const RE_URL = /https?:\/\/[^\s"'<>\][{}|\\^`]+/gi;
const RE_DOMINIO = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const PONTUACAO_FINAL = ".,;:!?)'\"»";

function limpar(url: string): string {
  url = url.trim();
  while (url && PONTUACAO_FINAL.includes(url[url.length - 1])) {
    if (url.endsWith(")") && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

export function deduplicar(urls: string[]): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    const k = normalizar(u);
    if (!vistos.has(k)) {
      vistos.add(k);
      saida.push(u);
    }
  }
  return saida;
}

export function urlsDoTexto(texto: string): string[] {
  const saida: string[] = [];
  for (const linha of texto.split(/\r?\n/)) {
    const achadas = linha.match(RE_URL);
    if (achadas) {
      saida.push(...achadas.map(limpar));
      continue;
    }
    for (let p of linha.trim().split(/[\s;,\t]+/)) {
      p = limpar(p);
      if (p && !p.includes("@") && RE_DOMINIO.test(p)) saida.push("https://" + p);
    }
  }
  return deduplicar(saida);
}

/** Sem esquema, assume https. */
export function comEsquema(texto: string): string {
  const t = texto.trim();
  return t && !t.includes("://") ? "https://" + t : t;
}
