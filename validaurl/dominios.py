"""Acompanhamento de vencimento de domínios: quando vence, quão perto está e onde registrar.

Mesma lógica de web/src/comum/dominios.ts. Consulta só o RDAP (rdap.org), o mesmo da aba WHOIS.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import httpx

from .whois import CABECALHO_RDAP, URL_RDAP_DOMINIO, _buscar, classificar_alvo, resumo_rdap_dominio

LIMITE_CRITICO = 15  # dias
LIMITE_ATENCAO = 60  # dias
SITUACOES = ("vencido", "critico", "atencao", "ok", "desconhecido")
GRAVIDADE = {"vencido": 0, "critico": 1, "atencao": 2, "ok": 3, "desconhecido": 4}
CORES = {
    "vencido": "#f5c6cb",
    "critico": "#f8d7da",
    "atencao": "#fff4cc",
    "ok": "#d9f2d9",
    "desconhecido": "#e2e3e5",
}
ROTULOS = {
    "vencido": "Vencido",
    "critico": "Vence em breve",
    "atencao": "Atenção",
    "ok": "OK",
    "desconhecido": "Sem data",
}

# Onde registrar ou renovar. .br só no Registro.br; o resto, registradores gerais.
ONDE_REGISTRAR_BR = [("Registro.br (lista de registradores credenciados)", "https://registro.br/")]
ONDE_REGISTRAR_GERAL = [
    ("Cloudflare Registrar", "https://www.cloudflare.com/products/registrar/"),
    ("Namecheap", "https://www.namecheap.com/"),
    ("Porkbun", "https://porkbun.com/"),
]


def sugestoes_registro(dominio: str) -> list[tuple[str, str]]:
    """(nome, endereço) de onde registrar ou renovar o domínio."""
    return list(ONDE_REGISTRAR_BR if dominio.lower().endswith(".br") else ONDE_REGISTRAR_GERAL)


def dias_ate(expira: str | None, agora: datetime | None = None) -> int | None:
    """Dias inteiros até a data de vencimento (negativo se já venceu); None se não há data."""
    if not expira:
        return None
    try:
        data = datetime.fromisoformat(expira.replace("Z", "+00:00"))
    except ValueError:
        return None
    if data.tzinfo is None:
        data = data.replace(tzinfo=timezone.utc)
    agora = agora or datetime.now(timezone.utc)
    return math.floor((data - agora).total_seconds() / 86400)


def situacao(dias: int | None) -> str:
    if dias is None:
        return "desconhecido"
    if dias < 0:
        return "vencido"
    if dias <= LIMITE_CRITICO:
        return "critico"
    if dias <= LIMITE_ATENCAO:
        return "atencao"
    return "ok"


def verificar(dominio: str, cliente: httpx.Client, agora: datetime | None = None) -> dict:
    """Consulta o RDAP do domínio. Levanta ValueError se não for um domínio."""
    tipo, alvo = classificar_alvo(dominio)
    if tipo != "dominio":
        raise ValueError("Informe um domínio (ex.: exemplo.com.br), não um IP.")
    agora = agora or datetime.now(timezone.utc)
    verificado = agora.isoformat(timespec="seconds")
    j, erro = _buscar(cliente, URL_RDAP_DOMINIO.format(alvo), headers=CABECALHO_RDAP)
    if not j:
        return {"dominio": alvo, "expira": None, "registrador": "", "status": [],
                "erro": f"RDAP indisponível: {erro}", "verificado": verificado}
    r = resumo_rdap_dominio(j)
    return {"dominio": alvo, "expira": r["expira"], "registrador": r["registrador"], "status": r["status"],
            "erro": "", "verificado": verificado}


def atualizar_avisos(itens: list[dict], agora: datetime | None = None) -> list[dict]:
    """Marca em cada item a situação já avisada e devolve os que precisam de aviso agora.

    Avisa quando a situação piora (ex.: de "atencao" para "critico") ou quando vence.
    Quando o domínio é renovado (volta a "ok"), a memória de avisos é zerada.
    """
    novos = []
    for item in itens:
        atual = situacao(dias_ate(item.get("expira"), agora))
        ja = item.get("ultimo_aviso") or "ok"
        if atual == "desconhecido":
            continue  # sem data não há o que avisar; mantém a memória
        if atual == "ok":
            item["ultimo_aviso"] = "ok"  # renovado: a próxima queda volta a avisar
            continue
        if GRAVIDADE[atual] < GRAVIDADE[ja]:
            item["ultimo_aviso"] = atual
            novos.append(item)
    return novos


def texto_aviso(item: dict, agora: datetime | None = None) -> str:
    dias = dias_ate(item.get("expira"), agora)
    if dias is None:
        quando = "sem data de vencimento"
    elif dias < 0:
        quando = f"venceu há {-dias} dia(s)"
    else:
        quando = f"vence em {dias} dia(s)"
    nomes = " · ".join(n for n, _ in sugestoes_registro(item["dominio"]))
    return f"{item['dominio']}: {quando}. Renovar ou registrar em: {nomes}."
