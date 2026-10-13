/* GET /api/confirmar?id&token[&sair=1]: confirma (ou cancela) os avisos por e-mail. */

import { porteiro } from "../../servidor/acesso.ts";
import { tratarConfirmacao } from "../../servidor/api-monitores.ts";
import { armazemBlobs } from "../../servidor/monitor.ts";

export default async function (req: Request): Promise<Response> {
  // Vem de um link de e-mail: sem cookie do portão e sem Origin.
  const recusa = await porteiro(req, { metodos: ["GET"], passe: false });
  if (recusa) return recusa;
  return tratarConfirmacao(req, await armazemBlobs());
}

export const config = {
  path: "/api/confirmar",
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
