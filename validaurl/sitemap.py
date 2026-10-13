"""Leitura de sitemap.xml (inclusive sitemap index e .gz)."""

from __future__ import annotations

import gzip
import io
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

import httpx

from .entradas import deduplicar
from .verificador import MAX_HTML, url_valida

MAX_SITEMAPS = 50
MAX_BYTES = 50 * 1024 * 1024  # limite do protocolo sitemap: 50 MB descompactado


class ErroSitemap(Exception):
    pass


def _baixar(cliente: httpx.Client, url: str) -> bytes:
    r = cliente.get(url, follow_redirects=True)
    if r.status_code != 200:
        raise ErroSitemap(f"{url} respondeu {r.status_code}")
    dados = r.content
    if dados[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(dados)) as g:
            dados = g.read(MAX_BYTES + 1)
    if len(dados) > MAX_BYTES:
        raise ErroSitemap(f"{url} passa de 50 MB")
    return dados


def interpretar(dados: bytes) -> tuple[list[str], list[str]]:
    """(urls de página, urls de sub-sitemap)."""
    cabeca = dados[:MAX_HTML].lower()
    # ElementTree expande entidades declaradas: recusar DTD evita a "bomba de XML".
    if b"<!doctype" in cabeca or b"<!entity" in cabeca:
        raise ErroSitemap("sitemap com DTD/entidades recusado")
    try:
        raiz = ET.fromstring(dados)
    except ET.ParseError as exc:
        raise ErroSitemap(f"XML inválido: {exc}") from exc
    paginas, filhos = [], []
    for el in raiz.iter():
        nome = el.tag.rsplit("}", 1)[-1].lower()
        if nome not in ("url", "sitemap"):
            continue
        for sub in el:
            if sub.tag.rsplit("}", 1)[-1].lower() == "loc" and sub.text and sub.text.strip():
                (filhos if nome == "sitemap" else paginas).append(sub.text.strip())
    return paginas, filhos


def ler_sitemap(cliente: httpx.Client, url: str, avisos: list[str] | None = None) -> list[str]:
    """Todas as URLs de página do sitemap, seguindo sitemap index."""
    avisos = avisos if avisos is not None else []
    fila, vistos, paginas = [url], set(), []
    while fila and len(vistos) < MAX_SITEMAPS:
        atual = fila.pop(0)
        if atual in vistos:
            continue
        vistos.add(atual)
        try:
            p, f = interpretar(_baixar(cliente, atual))
        except (ErroSitemap, httpx.HTTPError) as exc:
            if atual == url:
                raise ErroSitemap(str(exc)) from exc
            avisos.append(f"Sitemap {atual} ignorado: {exc}")
            continue
        paginas.extend(p)
        fila.extend(x for x in f if url_valida(x) is None)
    if fila:
        avisos.append(f"Parei em {MAX_SITEMAPS} sitemaps; {len(fila)} ficaram de fora.")
    return deduplicar(paginas)


def descobrir(cliente: httpx.Client, site: str) -> list[str]:
    """Endereços de sitemap de um site: os do robots.txt ou /sitemap.xml."""
    p = urlsplit(site)
    raiz = f"{p.scheme}://{p.netloc}/"
    achados = []
    try:
        r = cliente.get(urljoin(raiz, "robots.txt"), follow_redirects=True)
        if r.status_code == 200:
            for linha in r.text.splitlines():
                if linha.lower().startswith("sitemap:"):
                    achados.append(linha.split(":", 1)[1].strip())
    except httpx.HTTPError:
        pass
    return achados or [urljoin(raiz, "sitemap.xml")]


def urls_do_sitemap(cliente: httpx.Client, endereco: str, avisos: list[str] | None = None) -> list[str]:
    """Aceita o endereço do sitemap ou só o site (aí procura o sitemap)."""
    avisos = avisos if avisos is not None else []
    caminho = urlsplit(endereco).path.lower()
    if caminho.endswith((".xml", ".gz")) or "sitemap" in caminho:
        return ler_sitemap(cliente, endereco, avisos)
    todas, erros = [], []
    for s in descobrir(cliente, endereco):
        try:
            todas.extend(ler_sitemap(cliente, s, avisos))
        except ErroSitemap as exc:
            erros.append(str(exc))
    if not todas and erros:
        raise ErroSitemap("; ".join(erros))
    return deduplicar(todas)
