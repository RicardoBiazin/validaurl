/* Sitemap XML (e sitemap index, .gz) sem parser de XML: só os <loc>. */

import zlib from "node:zlib";

export function lerSitemap(corpo: Buffer): { paginas: string[]; filhos: string[] } {
  let dados = corpo;
  if (dados[0] === 0x1f && dados[1] === 0x8b) dados = zlib.gunzipSync(dados, { maxOutputLength: 50 * 1024 * 1024 });
  const texto = dados.toString("utf8");
  const ehIndice = /<(?:\w+:)?sitemapindex[\s>]/i.test(texto);
  const locs: string[] = [];
  const re = /<(?:\w+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const v = m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (v) locs.push(v);
  }
  return ehIndice ? { paginas: [], filhos: locs } : { paginas: locs, filhos: [] };
}
