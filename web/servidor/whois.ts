/*
 * WHOIS (RDAP), DNS e geolocalização de um domínio ou IP, no servidor.
 * Mesma lógica de validaurl/whois.py. Só fala com três serviços públicos e
 * fixos: rdap.org (RDAP), Cloudflare DNS-over-HTTPS e ip-api.com (geolocalização).
 * O endereço consultado é validado antes de virar URL; nada vem do usuário
 * como URL completa.
 */

import { isIP } from "node:net";
import { ipBloqueado } from "./rede.ts";

export const RE_DOMINIO = /^(?=.{4,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const URL_RDAP_DOMINIO = "https://rdap.org/domain/";
const URL_RDAP_IP = "https://rdap.org/ip/";
const URL_DOH = "https://cloudflare-dns.com/dns-query";
const URL_GEO = "http://ip-api.com/json/";
const TIPOS_DNS = ["A", "AAAA", "MX", "NS", "TXT"] as const;
const CODIGO_TIPO: Record<string, number> = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28, PTR: 12 };
const MAX_ENDERECOS = 8;
const TEMPO_RDAP = 4000;
const TEMPO_DNS = 3000;
const TEMPO_GEO = 3000;
const USER_AGENT = "ValidaURL-web";

export interface Geo {
  country: string | null;
  regionName: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  isp: string | null;
  org: string | null;
  as: string | null;
}

export interface Endereco {
  ip: string;
  ptr: string;
  geo: Geo | null;
}

export interface Relatorio {
  tipo: "dominio" | "ip";
  alvo: string;
  dominio: {
    dominio: string;
    registrador: string;
    criado: string | null;
    expira: string | null;
    atualizado: string | null;
    status: string[];
    nameservers: string[];
  } | null;
  ip: { nome: string; pais: string; faixa: string; organizacao: string } | null;
  dns: Record<string, string[]>;
  enderecos: Endereco[];
  avisos: string[];
}

/** ('dominio', 'exemplo.com.br') ou ('ip', '8.8.8.8'). Lança Error se não for nada disso. */
export function classificarAlvo(texto: string): { tipo: "dominio" | "ip"; alvo: string } {
  const bruto = texto.trim();
  const t = bruto.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.+$/, "");
  if (!t) throw new Error("Informe um domínio (ex.: exemplo.com.br) ou um IP.");
  if (isIP(t)) {
    if (ipBloqueado(t)) throw new Error("IP interno ou reservado: não tem registro público para consultar.");
    return { tipo: "ip", alvo: t };
  }
  if (RE_DOMINIO.test(t)) return { tipo: "dominio", alvo: t };
  throw new Error(`Não reconheço "${bruto}" como domínio nem como IP.`);
}

/** Nome para consulta PTR (equivale a ipaddress.reverse_pointer no Python). */
export function nomeReverso(ip: string): string {
  if (isIP(ip) === 4) return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  return expandirIPv6(ip).split("").reverse().join(".") + ".ip6.arpa";
}

function expandirIPv6(ip: string): string {
  let partes: string[];
  if (ip.includes("::")) {
    const [a, b] = ip.split("::");
    const ea = a ? a.split(":") : [];
    const eb = b ? b.split(":") : [];
    partes = [...ea, ...Array(8 - ea.length - eb.length).fill("0"), ...eb];
  } else {
    partes = ip.split(":");
  }
  return partes.map((p) => p.padStart(4, "0")).join("");
}

/** Respostas de um tipo, do JSON do DNS-over-HTTPS. */
export function dadosDoh(resposta: { Answer?: { type: number; data: string }[] }, tipo: string): string[] {
  const codigo = CODIGO_TIPO[tipo];
  const saida: string[] = [];
  for (const item of resposta.Answer ?? []) {
    if (item.type !== codigo) continue;
    let dado = String(item.data ?? "").trim();
    if (tipo === "TXT") dado = dado.replace(/" "/g, "").replace(/^"|"$/g, "");
    if (dado) saida.push(dado);
  }
  return saida;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function entidade(j: Json, papel: string): string {
  for (const e of j.entities ?? []) {
    if (!(e.roles ?? []).includes(papel)) continue;
    for (const campo of e.vcardArray?.[1] ?? []) {
      if (campo?.[0] === "fn" && campo.length > 3) return String(campo[3]);
    }
    if (e.handle) return String(e.handle);
  }
  return "";
}

export function resumoRdapDominio(j: Json): Relatorio["dominio"] {
  const eventos: Record<string, string> = {};
  for (const e of j.events ?? []) eventos[e.eventAction] = e.eventDate;
  return {
    dominio: j.ldhName ?? "",
    registrador: entidade(j, "registrar"),
    criado: eventos["registration"] ?? null,
    expira: eventos["expiration"] ?? null,
    atualizado: eventos["last changed"] ?? null,
    status: [...(j.status ?? [])],
    nameservers: (j.nameservers ?? []).filter((n: Json) => n.ldhName).map((n: Json) => String(n.ldhName).toLowerCase()),
  };
}

export function resumoRdapIp(j: Json): Relatorio["ip"] {
  const inicio = j.startAddress ?? "";
  const fim = j.endAddress ?? "";
  return {
    nome: j.name ?? "",
    pais: j.country ?? "",
    faixa: inicio && fim ? `${inicio} – ${fim}` : "",
    organizacao: entidade(j, "registrant"),
  };
}

export function resumoGeo(j: Json): Geo | null {
  if (j?.status !== "success") return null;
  return {
    country: j.country ?? null,
    regionName: j.regionName ?? null,
    city: j.city ?? null,
    lat: j.lat ?? null,
    lon: j.lon ?? null,
    isp: j.isp ?? null,
    org: j.org ?? null,
    as: j.as ?? null,
  };
}

async function buscarJson(url: string, headers: Record<string, string>, tempoMs: number):
  Promise<{ dados: Json | null; erro: string }> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(tempoMs),
    });
    if (!r.ok) return { dados: null, erro: `HTTP ${r.status}` };
    return { dados: await r.json(), erro: "" };
  } catch (e) {
    return { dados: null, erro: (e as Error).name === "TimeoutError" ? "Tempo esgotado" : "falha de conexão" };
  }
}

async function dns(nome: string, tipo: string): Promise<string[]> {
  const url = new URL(URL_DOH);
  url.searchParams.set("name", nome);
  url.searchParams.set("type", tipo);
  const { dados } = await buscarJson(url.toString(), { Accept: "application/dns-json" }, TEMPO_DNS);
  return dados ? dadosDoh(dados, tipo) : [];
}

async function ptr(ip: string): Promise<string> {
  const respostas = await dns(nomeReverso(ip), "PTR");
  return respostas[0]?.replace(/\.$/, "") ?? "";
}

async function geo(ip: string): Promise<Geo | null> {
  // ip já foi validado por isIP: só hex, ':' e '.', nada que precise de encode.
  const { dados } = await buscarJson(`${URL_GEO}${ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,as`,
    {}, TEMPO_GEO);
  return dados ? resumoGeo(dados) : null;
}

/** Consulta completa. Lança Error se o alvo for inválido. */
export async function consultarWhois(texto: string): Promise<Relatorio> {
  const { tipo, alvo } = classificarAlvo(texto);
  const rel: Relatorio = { tipo, alvo, dominio: null, ip: null, dns: {}, enderecos: [], avisos: [] };
  let ips: string[];
  if (tipo === "dominio") {
    const [rdap, ...respostas] = await Promise.all([
      buscarJson(URL_RDAP_DOMINIO + alvo, { Accept: "application/rdap+json, application/json" }, TEMPO_RDAP),
      ...TIPOS_DNS.map((t) => dns(alvo, t)),
    ]);
    if (rdap.dados) rel.dominio = resumoRdapDominio(rdap.dados);
    else rel.avisos.push(`WHOIS (RDAP) indisponível: ${rdap.erro}`);
    TIPOS_DNS.forEach((t, i) => (rel.dns[t] = respostas[i]));
    ips = [...rel.dns.A, ...rel.dns.AAAA];
    if (!ips.length) rel.avisos.push("Nenhum endereço (A/AAAA) encontrado para o domínio.");
  } else {
    const rdap = await buscarJson(URL_RDAP_IP + alvo, { Accept: "application/rdap+json, application/json" }, TEMPO_RDAP);
    if (rdap.dados) rel.ip = resumoRdapIp(rdap.dados);
    else rel.avisos.push(`RDAP do IP indisponível: ${rdap.erro}`);
    ips = [alvo];
  }
  rel.enderecos = await Promise.all(ips.slice(0, MAX_ENDERECOS).map(async (ip) => ({
    ip,
    ptr: await ptr(ip),
    geo: await geo(ip),
  })));
  return rel;
}
