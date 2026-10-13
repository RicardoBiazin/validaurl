/*
 * Function agendada: a cada 5 minutos roda os monitores vencidos.
 * Limite do Netlify para função agendada: 30 s. O orçamento de 12 s para
 * COMEÇAR monitores + 2 rodadas de 5 s por monitor deixa folga; o que sobrar
 * fica para a próxima rodada (os mais atrasados vão primeiro).
 */

import { ambienteDoProcesso, armazemBlobs, rodarVencidos } from "../../servidor/monitor.ts";

export default async function (): Promise<Response> {
  const r = await rodarVencidos(await armazemBlobs(), ambienteDoProcesso());
  console.log(`[agendado] ${r.rodados} monitor(es) checado(s), ${r.pendentes} para a próxima rodada`);
  return new Response(null, { status: 204 });
}

export const config = { schedule: "*/5 * * * *" };
