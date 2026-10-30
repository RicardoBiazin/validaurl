/*
 * POST /api/whois {alvo}: WHOIS (RDAP), DNS e geolocalização de um domínio ou IP.
 * Só valida o alvo e consulta serviços fixos (ver servidor/whois.ts).
 */

import { consumir, erro, ipDe, json, lerJson, porteiro } from "../../servidor/acesso.ts";
import { consultarWhois } from "../../servidor/whois.ts";

export const LIMITE_POR_MINUTO = 20;

export default async function (req: Request): Promise<Response> {
  const recusa = await porteiro(req);
  if (recusa) return recusa;
  const dados = await lerJson<{ alvo?: unknown }>(req, 2048);
  if (!dados || typeof dados.alvo !== "string" || dados.alvo.length > 300) {
    return erro("Pedido inválido.", 400);
  }
  if (!consumir("whois:" + ipDe(req), 1, LIMITE_POR_MINUTO)) {
    return erro("Muitas consultas em pouco tempo. Espere um minuto.", 429, { "Retry-After": "60" });
  }
  try {
    return json(await consultarWhois(dados.alvo));
  } catch (e) {
    return erro((e as Error).message, 400);
  }
}

export const config = {
  path: "/api/whois",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
