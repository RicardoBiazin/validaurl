/*
 * POST /api/pagina  {url, modo: "html" | "sitemap" | "robots"}
 *  - html:    checa a página e devolve os links dela (para o rastreio);
 *  - sitemap: devolve as URLs (ou sub-sitemaps) do sitemap;
 *  - robots:  devolve as regras do robots.txt do site (para "*").
 * O corpo da página nunca volta para o navegador: só status e links.
 */

import { extrairLinks, regrasRobots } from "../../src/comum/links.ts";
import { consumir, erro, ipDe, json, lerJson, porteiro } from "../../servidor/acesso.ts";
import { checar } from "../../servidor/rede.ts";
import { lerSitemap } from "../../servidor/sitemap.ts";

export const LIMITE_POR_MINUTO = 120;
const MAX_LINKS = 5000;

export default async function (req: Request): Promise<Response> {
  const recusa = await porteiro(req);
  if (recusa) return recusa;
  const dados = await lerJson<{ url?: unknown; modo?: unknown; seguirRedirects?: unknown }>(req);
  const modo = dados?.modo;
  if (!dados || typeof dados.url !== "string" || dados.url.length > 8192 ||
    (modo !== "html" && modo !== "sitemap" && modo !== "robots")) {
    return erro("Pedido inválido.", 400);
  }
  if (!consumir("pagina:" + ipDe(req), 1, LIMITE_POR_MINUTO)) {
    return erro("Muitas páginas em pouco tempo. Espere um minuto.", 429, { "Retry-After": "60" });
  }
  let alvo = dados.url;
  if (modo === "robots") {
    try {
      alvo = new URL("/robots.txt", alvo).toString();
    } catch {
      return erro("URL inválida.", 400);
    }
  }
  const { corpo, ...checagem } = await checar(alvo, {
    lerCorpo: true, seguirRedirects: dados.seguirRedirects !== false, timeoutMs: 8000,
  });
  if (modo === "html") {
    const html = corpo && /html|^$/.test(checagem.tipo) ? corpo.toString("utf8") : "";
    const links = html ? extrairLinks(html, checagem.urlFinal || alvo).slice(0, MAX_LINKS) : [];
    return json({ checagem, links });
  }
  if (modo === "robots") {
    const ok = checagem.status === 200 && corpo;
    return json({ checagem, robots: ok ? regrasRobots(corpo.toString("utf8")) : null });
  }
  if (checagem.status !== 200 || !corpo) {
    const motivo = checagem.status === null ? checagem.erro : `O sitemap respondeu ${checagem.status}` +
      (checagem.erro ? ` (${checagem.erro})` : "");
    return json({ checagem, erro: motivo });
  }
  try {
    const { paginas, filhos } = lerSitemap(corpo);
    return json({ checagem, paginas: paginas.slice(0, 50_000), filhos: filhos.slice(0, 100) });
  } catch (e) {
    return json({ checagem, erro: `Sitemap ilegível: ${(e as Error).message}` });
  }
}

export const config = {
  path: "/api/pagina",
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
