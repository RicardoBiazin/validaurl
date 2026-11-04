/*
 * Consulta de vencimento de um domínio (RDAP, via rdap.org), no servidor.
 * Mesma lógica de validaurl/dominios.py: só o RDAP, o mesmo da aba WHOIS.
 */

import type { DominioVerificado } from "../src/comum/dominios.ts";
import { buscarJson, classificarAlvo, resumoRdapDominio, URL_RDAP_DOMINIO } from "./whois.ts";

const TEMPO_RDAP = 6000;

export async function verificarDominio(texto: string, agora: Date = new Date()): Promise<DominioVerificado> {
  const { tipo, alvo } = classificarAlvo(texto);
  if (tipo !== "dominio") throw new Error("Informe um domínio (ex.: exemplo.com.br), não um IP.");
  const verificado = agora.toISOString();
  const { dados, erro } = await buscarJson(URL_RDAP_DOMINIO + alvo,
    { Accept: "application/rdap+json, application/json" }, TEMPO_RDAP);
  if (!dados) {
    return { dominio: alvo, expira: null, registrador: "", status: [], erro: `RDAP indisponível: ${erro}`, verificado };
  }
  const r = resumoRdapDominio(dados)!;
  return { dominio: alvo, expira: r.expira, registrador: r.registrador, status: r.status, erro: "", verificado };
}
