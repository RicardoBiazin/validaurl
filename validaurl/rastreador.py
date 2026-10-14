"""Rastreia um site: segue os links internos e checa tudo o que encontrar."""

from __future__ import annotations

import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from .links import extrair_links, mesmo_site, normalizar, sem_fragmento
from .lote import LimitePorHost
from .verificador import USER_AGENT, Opcoes, Resultado, novo_cliente, url_valida, verificar

# Internos com estas extensões são checados, mas não abertos nem contados como página.
EXT_RECURSO = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
    ".css", ".js", ".mjs", ".map", ".json",
    ".pdf", ".zip", ".rar", ".7z", ".gz", ".exe", ".msi", ".dmg",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".csv",
    ".mp3", ".mp4", ".webm", ".avi", ".mov", ".wav", ".ogg",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
)


@dataclass
class OpcoesRastreio:
    max_paginas: int = 500
    profundidade: int = 10
    subdominios: bool = False
    checar_externos: bool = True
    respeitar_robots: bool = True


@dataclass
class Progresso:
    concluidos: int
    agendados: int
    paginas: int


def eh_recurso(url: str) -> bool:
    return urlsplit(url).path.lower().endswith(EXT_RECURSO)


def _robots(cliente: httpx.Client, inicio: str) -> RobotFileParser | None:
    p = urlsplit(inicio)
    rp = RobotFileParser()
    try:
        r = cliente.get(urljoin(f"{p.scheme}://{p.netloc}/", "robots.txt"), follow_redirects=True)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    rp.parse(r.text.splitlines())
    return rp


def rastrear(
    inicios: str | list[str],
    opcoes: Opcoes | None = None,
    opc: OpcoesRastreio | None = None,
    ao_resultado: Callable[[Resultado], None] | None = None,
    ao_progresso: Callable[[Progresso], None] | None = None,
    cancelar: threading.Event | None = None,
    avisos: list[str] | None = None,
) -> list[Resultado]:
    opcoes = opcoes or Opcoes()
    opc = opc or OpcoesRastreio()
    cancelar = cancelar or threading.Event()
    avisos = avisos if avisos is not None else []
    # Um endereço ou vários (um por linha): cada um é checado e tem os links internos seguidos.
    raizes = [inicios] if isinstance(inicios, str) else list(inicios)
    for bruto in raizes:
        motivo = url_valida(bruto)
        if motivo:
            raise ValueError(motivo)
    raizes = list(dict.fromkeys(sem_fragmento(u) for u in raizes))

    resultados: list[Resultado] = []
    vistos: set[str] = set()
    pendentes: dict = {}
    contagem = {"paginas": 0, "agendados": 0}
    limite = LimitePorHost(opcoes.por_host)
    avisou_limite = False

    with novo_cliente(opcoes) as cliente, ThreadPoolExecutor(max_workers=max(opcoes.concorrencia, 1)) as pool:
        robots_por_origem: dict[str, RobotFileParser | None] = {}

        def pode_robots(url: str) -> bool:
            if not opc.respeitar_robots:
                return True
            p = urlsplit(url)
            origem = f"{p.scheme}://{p.netloc}"
            if origem not in robots_por_origem:
                robots_por_origem[origem] = _robots(cliente, origem + "/")
            rp = robots_por_origem[origem]
            return rp is None or rp.can_fetch(USER_AGENT, url)

        def eh_interno(url: str) -> bool:
            return any(mesmo_site(url, raiz, opc.subdominios) for raiz in raizes)

        def tarefa(url: str, origem: str, abrir: bool):
            with limite.de(url):
                if cancelar.is_set():
                    return None, None
                return verificar(url, cliente, opcoes, ler_html=abrir, encontrado_em=origem)

        def agendar(url: str, profundidade: int, origem: str):
            nonlocal avisou_limite
            chave = normalizar(url)
            if chave in vistos:
                return
            interno = eh_interno(url)
            if not interno and not opc.checar_externos:
                return
            vistos.add(chave)
            abrir = False
            if interno and not eh_recurso(url) and profundidade <= opc.profundidade:
                if contagem["paginas"] < opc.max_paginas and pode_robots(url):
                    abrir = True
                    contagem["paginas"] += 1
                elif contagem["paginas"] >= opc.max_paginas and not avisou_limite:
                    avisou_limite = True
                    avisos.append(f"Limite de {opc.max_paginas} páginas atingido: "
                                  "links internos além disso foram só checados, não abertos.")
            contagem["agendados"] += 1
            fut = pool.submit(tarefa, url, origem, abrir)
            pendentes[fut] = (url, profundidade, abrir)

        for raiz in raizes:
            agendar(raiz, 0, "")
        while pendentes:
            feitos, _ = wait(list(pendentes), timeout=0.25, return_when=FIRST_COMPLETED)
            if cancelar.is_set():
                for f in pendentes:
                    f.cancel()
            for fut in feitos:
                url, prof, abrir = pendentes.pop(fut)
                if fut.cancelled():
                    continue
                res, html = fut.result()
                if res is None:
                    continue
                resultados.append(res)
                if ao_resultado:
                    ao_resultado(res)
                if (abrir and html and not cancelar.is_set() and "html" in (res.tipo or "text/html")
                        and eh_interno(res.url_final or url)):
                    pagina = res.url_final or url
                    for link in extrair_links(html, pagina):
                        agendar(link, prof + 1, pagina)
                if ao_progresso:
                    ao_progresso(Progresso(len(resultados), contagem["agendados"], contagem["paginas"]))
    for raiz in raizes:
        inicial = next((r for r in resultados if r.url == raiz), None)
        if inicial and inicial.url_final and not mesmo_site(inicial.url_final, raiz):
            host = urlsplit(inicial.url_final).hostname or inicial.url_final
            aviso = aviso_redirecionamento_fora(host)
            if aviso not in avisos:
                avisos.append(aviso)
    return resultados


def aviso_redirecionamento_fora(host: str) -> str:
    return (f"A página inicial redireciona para {host}, fora do site informado. O rastreio só segue links "
            "dentro do site, então não havia o que seguir. Para checar subdomínios, cole os endereços "
            "na aba Lista de URLs.")
