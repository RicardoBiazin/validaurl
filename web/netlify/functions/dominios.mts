/*
 * POST /api/dominios {dominios: string[] (até 20)} -> {resultados}
 * Consulta só o vencimento (RDAP) de cada domínio. Ver servidor/dominios.ts.
 */

import { consumir, erro, ipDe, json, lerJson, porteiro } from "../../servidor/acesso.ts";
import { verificarDominio } from "../../servidor/dominios.ts";
import { emParalelo } from "../../servidor/rede.ts";

export const MAX_DOMINIOS = 20;
export const LIMITE_POR_MINUTO = 60;

export default async function (req: Request): Promise<Response> {
  const recusa = await porteiro(req);
  if (recusa) return recusa;
  const dados = await lerJson<{ dominios?: unknown }>(req, 8192);
  if (!dados || !Array.isArray(dados.dominios) || dados.dominios.length === 0 ||
    dados.dominios.length > MAX_DOMINIOS || !dados.dominios.every((d) => typeof d === "string" && d.length <= 300)) {
    return erro(`Mande de 1 a ${MAX_DOMINIOS} domínios por vez.`, 400);
  }
  const dominios = dados.dominios as string[];
  if (!consumir("dominios:" + ipDe(req), dominios.length, LIMITE_POR_MINUTO)) {
    return erro("Muitas consultas em pouco tempo. Espere um minuto.", 429, { "Retry-After": "60" });
  }
  const resultados = await emParalelo(dominios, 5, async (d) => {
    try {
      return await verificarDominio(d);
    } catch (e) {
      return { dominio: d, expira: null, registrador: "", status: [], erro: (e as Error).message,
        verificado: new Date().toISOString() };
    }
  });
  return json({ resultados });
}

export const config = {
  path: "/api/dominios",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
