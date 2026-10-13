/*
 * POST /api/checar  {urls: string[] (até 10), seguirRedirects?, soGet?}
 *  -> {resultados: Checagem[]}
 * O navegador orquestra a fila e manda lotes pequenos: cada chamada termina
 * bem antes do limite de 10 s da Function.
 */

import { consumir, erro, ipDe, json, lerJson, porteiro } from "../../servidor/acesso.ts";
import { checar, emParalelo } from "../../servidor/rede.ts";

export const MAX_LOTE = 10;
export const LIMITE_POR_MINUTO = 300; // URLs por IP por minuto

export default async function (req: Request): Promise<Response> {
  const recusa = await porteiro(req);
  if (recusa) return recusa;
  const dados = await lerJson<{ urls?: unknown; seguirRedirects?: unknown; soGet?: unknown }>(req, 128 * 1024);
  if (!dados || !Array.isArray(dados.urls) || !dados.urls.every((u) => typeof u === "string" && u.length <= 64 * 1024)) {
    return erro("Pedido inválido.", 400);
  }
  const urls = dados.urls as string[];
  if (!urls.length || urls.length > MAX_LOTE) return erro(`Mande de 1 a ${MAX_LOTE} URLs por vez.`, 400);
  if (!consumir("checar:" + ipDe(req), urls.length, LIMITE_POR_MINUTO)) {
    return erro("Muitas checagens em pouco tempo. Espere um minuto.", 429, { "Retry-After": "60" });
  }
  const resultados = await emParalelo(urls, MAX_LOTE, async (url) => {
    if (url.length > 8192) {
      return { url, status: null, urlFinal: "", redirects: [], tempoMs: 0, erro: "URL longa demais (mais de 8192 caracteres)",
        tipo: "", metodo: "" };
    }
    const { corpo: _, ...r } = await checar(url, {
      seguirRedirects: dados.seguirRedirects !== false, soGet: dados.soGet === true, timeoutMs: 7000,
    });
    return r;
  });
  return json({ resultados });
}

export const config = {
  path: "/api/checar",
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
