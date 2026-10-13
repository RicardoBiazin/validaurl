/*
 * Extração de links e normalização de URL, sem DOM: roda na Function (Node) e
 * no navegador. Equivale a validaurl/links.py.
 */

const ATRIBUTOS: Record<string, string[]> = {
  a: ["href"], area: ["href"], link: ["href"], img: ["src"], script: ["src"], iframe: ["src"],
  source: ["src"], video: ["src", "poster"], audio: ["src"], embed: ["src"],
};
const IGNORAR = /^(mailto|tel|javascript|data|blob|about|sms|whatsapp):|^#/i;
const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTIDADES) return ENTIDADES[k];
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

function atributos(texto: string): Record<string, string> {
  const saida: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const nome = m[1].toLowerCase();
    if (!(nome in saida)) saida[nome] = decodificar(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return saida;
}

export function semFragmento(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.toString();
}

/** Chave para deduplicar: minúsculas no esquema/domínio, sem porta padrão,
 *  sem fragmento e com os parâmetros em ordem. */
export function normalizar(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const pares = [...u.searchParams.entries()].sort((a, b) => (a[0] + "=" + a[1] < b[0] + "=" + b[1] ? -1 : 1));
    u.search = new URLSearchParams(pares).toString();
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function extrairLinks(html: string, urlPagina: string): string[] {
  const limpo = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, "$1");
  const brutos: string[] = [];
  let base: string | null = null;
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpo))) {
    const tag = m[1].toLowerCase();
    const a = atributos(m[2]);
    if (tag === "base" && a.href && base === null) {
      base = a.href.trim();
      continue;
    }
    if (tag === "link" && /\b(preconnect|dns-prefetch)\b/i.test(a.rel ?? "")) continue;
    for (const nome of ATRIBUTOS[tag] ?? []) {
      const v = (a[nome] ?? "").trim();
      if (v) brutos.push(v);
    }
    if ((tag === "img" || tag === "source") && a.srcset) {
      for (const parte of a.srcset.split(",")) {
        const p = parte.trim().split(/\s+/)[0];
        if (p) brutos.push(p);
      }
    }
  }
  let baseAbs = urlPagina;
  try {
    if (base) baseAbs = new URL(base, urlPagina).toString();
  } catch { /* base inválida: fica a da página */ }
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const b of brutos) {
    if (IGNORAR.test(b)) continue;
    let abs: string;
    try {
      abs = semFragmento(new URL(b, baseAbs).toString());
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    const k = normalizar(abs);
    if (!vistos.has(k)) {
      vistos.add(k);
      saida.push(abs);
    }
  }
  return saida;
}

function hostSemWww(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function mesmoSite(url: string, raiz: string, subdominios = false): boolean {
  const h = hostSemWww(url);
  const r = hostSemWww(raiz);
  return !!h && (h === r || (subdominios && h.endsWith("." + r)));
}

const EXT_RECURSO = /\.(jpe?g|png|gif|webp|svg|ico|bmp|avif|css|m?js|map|json|pdf|zip|rar|7z|gz|exe|msi|dmg|docx?|xlsx?|pptx?|odt|ods|csv|mp3|mp4|webm|avi|mov|wav|ogg|woff2?|ttf|otf|eot)$/i;

export function ehRecurso(url: string): boolean {
  try {
    return EXT_RECURSO.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Regras do robots.txt para "*" (prefixo, com * e $). */
export function regrasRobots(texto: string): { permitir: string[]; bloquear: string[]; sitemaps: string[] } {
  const permitir: string[] = [];
  const bloquear: string[] = [];
  const sitemaps: string[] = [];
  let doGrupo = false;
  let lendoAgentes = false;
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(linha);
    if (!m) continue;
    const campo = m[1].toLowerCase();
    const valor = m[2].trim();
    if (campo === "sitemap") {
      sitemaps.push(valor);
      continue;
    }
    if (campo === "user-agent") {
      if (!lendoAgentes) doGrupo = false;
      lendoAgentes = true;
      if (valor === "*") doGrupo = true;
      continue;
    }
    lendoAgentes = false;
    if (!doGrupo) continue;
    if (campo === "disallow" && valor) bloquear.push(valor);
    if (campo === "allow" && valor) permitir.push(valor);
  }
  return { permitir, bloquear, sitemaps };
}

function casa(regra: string, caminho: string): number {
  const fim = regra.endsWith("$");
  const corpo = (fim ? regra.slice(0, -1) : regra).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + corpo + (fim ? "$" : "")).test(caminho) ? regra.length : -1;
}

/** A regra mais longa vence; empate favorece Allow (RFC 9309). */
export function robotsPermite(regras: { permitir: string[]; bloquear: string[] }, url: string): boolean {
  let caminho: string;
  try {
    const u = new URL(url);
    caminho = u.pathname + u.search;
  } catch {
    return true;
  }
  const melhorBloq = Math.max(-1, ...regras.bloquear.map((r) => casa(r, caminho)));
  const melhorPerm = Math.max(-1, ...regras.permitir.map((r) => casa(r, caminho)));
  return melhorBloq < 0 || melhorPerm >= melhorBloq;
}
