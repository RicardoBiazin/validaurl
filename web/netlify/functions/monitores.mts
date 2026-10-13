/* POST /api/monitores {acao, ...}: criar, ver, editar, excluir, checar, testar-avisos, push, config. */

import { erro, lerJson, porteiro } from "../../servidor/acesso.ts";
import { tratarMonitores } from "../../servidor/api-monitores.ts";
import { ambienteDoProcesso, armazemBlobs } from "../../servidor/monitor.ts";

export default async function (req: Request): Promise<Response> {
  const recusa = await porteiro(req);
  if (recusa) return recusa;
  const pedido = await lerJson<Record<string, unknown>>(req);
  if (!pedido) return erro("Pedido inválido.", 400);
  return tratarMonitores(req, pedido, await armazemBlobs(), ambienteDoProcesso());
}

export const config = {
  path: "/api/monitores",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
