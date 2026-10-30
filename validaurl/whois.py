"""WHOIS (RDAP), DNS e geolocalização de um domínio ou IP.

Mesma lógica de web/servidor/whois.ts. Só fala com três serviços públicos e
fixos: rdap.org (RDAP), Cloudflare DNS-over-HTTPS e ip-api.com (geolocalização).
O endereço consultado nunca vira URL de requisição sem validação.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import asdict, dataclass, field

import httpx

from . import VERSAO

RE_DOMINIO = re.compile(r"^(?=.{4,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$")
URL_RDAP_DOMINIO = "https://rdap.org/domain/{}"
URL_RDAP_IP = "https://rdap.org/ip/{}"
URL_DOH = "https://cloudflare-dns.com/dns-query"
URL_GEO = "http://ip-api.com/json/{}?fields=status,message,country,regionName,city,lat,lon,isp,org,as"
CABECALHO_RDAP = {"Accept": "application/rdap+json, application/json"}
CABECALHO_DOH = {"Accept": "application/dns-json"}
TIPOS_DNS = ("A", "AAAA", "MX", "NS", "TXT")
CODIGO_TIPO = {"A": 1, "NS": 2, "MX": 15, "TXT": 16, "AAAA": 28, "PTR": 12}
MAX_ENDERECOS = 8


def classificar_alvo(texto: str) -> tuple[str, str]:
    """('dominio', 'exemplo.com.br') ou ('ip', '8.8.8.8'). Levanta ValueError se não for nada disso."""
    bruto = texto.strip()
    t = re.sub(r"^https?://", "", bruto.lower()).split("/")[0].rstrip(".")
    if not t:
        raise ValueError("Informe um domínio (ex.: exemplo.com.br) ou um IP.")
    try:
        ip = ipaddress.ip_address(t)
    except ValueError:
        if RE_DOMINIO.match(t):
            return "dominio", t
        raise ValueError(f"Não reconheço {bruto!r} como domínio nem como IP.") from None
    if not ip.is_global:
        raise ValueError("IP interno ou reservado: não tem registro público para consultar.")
    return "ip", str(ip)


def dados_doh(resposta: dict, tipo: str) -> list[str]:
    """Respostas de um tipo, do JSON do DNS-over-HTTPS."""
    codigo = CODIGO_TIPO[tipo]
    saida = []
    for item in resposta.get("Answer", []):
        if item.get("type") != codigo:
            continue
        dado = str(item.get("data", "")).strip()
        if tipo == "TXT":
            dado = dado.replace('" "', "").strip('"')
        if dado:
            saida.append(dado)
    return saida


def _entidade(j: dict, papel: str) -> str:
    for e in j.get("entities", []):
        if papel in e.get("roles", []):
            for campo in (e.get("vcardArray") or [None, []])[1]:
                if campo and campo[0] == "fn" and len(campo) > 3:
                    return str(campo[3])
            if e.get("handle"):
                return str(e["handle"])
    return ""


def resumo_rdap_dominio(j: dict) -> dict:
    eventos = {e.get("eventAction"): e.get("eventDate") for e in j.get("events", [])}
    return {
        "dominio": j.get("ldhName") or "",
        "registrador": _entidade(j, "registrar"),
        "criado": eventos.get("registration"),
        "expira": eventos.get("expiration"),
        "atualizado": eventos.get("last changed"),
        "status": list(j.get("status", [])),
        "nameservers": [n["ldhName"].lower() for n in j.get("nameservers", []) if n.get("ldhName")],
    }


def resumo_rdap_ip(j: dict) -> dict:
    inicio, fim = j.get("startAddress", ""), j.get("endAddress", "")
    return {
        "nome": j.get("name") or "",
        "pais": j.get("country") or "",
        "faixa": f"{inicio} – {fim}" if inicio and fim else "",
        "organizacao": _entidade(j, "registrant"),
    }


def resumo_geo(j: dict) -> dict | None:
    if j.get("status") != "success":
        return None
    return {k: j.get(k) for k in ("country", "regionName", "city", "lat", "lon", "isp", "org", "as")}


@dataclass
class Relatorio:
    tipo: str
    alvo: str
    dominio: dict | None = None
    ip: dict | None = None
    dns: dict[str, list[str]] = field(default_factory=dict)
    enderecos: list[dict] = field(default_factory=list)
    avisos: list[str] = field(default_factory=list)

    def como_dict(self) -> dict:
        return asdict(self)


def _cliente_padrao() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": f"ValidaURL/{VERSAO}", "Accept-Language": "pt-BR"},
                        timeout=8, follow_redirects=True)


def _buscar(cliente: httpx.Client, url: str, params: dict | None = None,
            headers: dict | None = None) -> tuple[dict | None, str]:
    try:
        r = cliente.get(url, params=params, headers=headers)
    except httpx.HTTPError as exc:
        return None, type(exc).__name__
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    try:
        return r.json(), ""
    except ValueError:
        return None, "resposta inválida"


def _dns(cliente: httpx.Client, nome: str, tipo: str) -> list[str]:
    j, _ = _buscar(cliente, URL_DOH, params={"name": nome, "type": tipo}, headers=CABECALHO_DOH)
    return dados_doh(j, tipo) if j else []


def _ptr(cliente: httpx.Client, ip: str) -> str:
    respostas = _dns(cliente, ipaddress.ip_address(ip).reverse_pointer, "PTR")
    return respostas[0].rstrip(".") if respostas else ""


def _geo(cliente: httpx.Client, ip: str) -> dict | None:
    j, _ = _buscar(cliente, URL_GEO.format(ip))
    return resumo_geo(j) if j else None


def consultar(texto: str, cliente: httpx.Client | None = None) -> Relatorio:
    """Consulta WHOIS (RDAP), DNS, PTR e geolocalização. Levanta ValueError se o alvo for inválido."""
    tipo, alvo = classificar_alvo(texto)
    proprio = cliente is None
    cli = cliente or _cliente_padrao()
    try:
        rel = Relatorio(tipo, alvo)
        if tipo == "dominio":
            j, erro = _buscar(cli, URL_RDAP_DOMINIO.format(alvo), headers=CABECALHO_RDAP)
            if j:
                rel.dominio = resumo_rdap_dominio(j)
            else:
                rel.avisos.append(f"WHOIS (RDAP) indisponível: {erro}")
            for t in TIPOS_DNS:
                rel.dns[t] = _dns(cli, alvo, t)
            ips = rel.dns["A"] + rel.dns["AAAA"]
            if not ips:
                rel.avisos.append("Nenhum endereço (A/AAAA) encontrado para o domínio.")
        else:
            j, erro = _buscar(cli, URL_RDAP_IP.format(alvo), headers=CABECALHO_RDAP)
            if j:
                rel.ip = resumo_rdap_ip(j)
            else:
                rel.avisos.append(f"RDAP do IP indisponível: {erro}")
            ips = [alvo]
        for ip in ips[:MAX_ENDERECOS]:
            rel.enderecos.append({"ip": ip, "ptr": _ptr(cli, ip), "geo": _geo(cli, ip)})
        return rel
    finally:
        if proprio:
            cli.close()
