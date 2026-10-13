"""Extração de links de HTML e normalização de URL."""

from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

# (tag, atributo) que apontam para recursos que o navegador baixaria ou o
# usuário clicaria.
ATRIBUTOS = {
    "a": ("href",),
    "area": ("href",),
    "link": ("href",),
    "img": ("src",),
    "script": ("src",),
    "iframe": ("src",),
    "source": ("src",),
    "video": ("src", "poster"),
    "audio": ("src",),
    "embed": ("src",),
}
IGNORAR_PREFIXOS = ("mailto:", "tel:", "javascript:", "data:", "blob:", "about:", "#", "sms:", "whatsapp:")
LINK_REL_IGNORAR = {"preconnect", "dns-prefetch"}


class _Coletor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.base: str | None = None
        self.links: list[str] = []
        self.nofollow_pagina = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "base" and a.get("href") and self.base is None:
            self.base = a["href"].strip()
            return
        if tag == "meta" and a.get("name", "").lower() == "robots" and "nofollow" in a.get("content", "").lower():
            self.nofollow_pagina = True
        if tag == "link" and set(a.get("rel", "").lower().split()) & LINK_REL_IGNORAR:
            return
        for nome in ATRIBUTOS.get(tag, ()):
            valor = a.get(nome, "").strip()
            if valor:
                self.links.append(valor)
        if tag in ("img", "source") and a.get("srcset"):
            for parte in a["srcset"].split(","):
                pedaco = parte.strip().split(" ")[0]
                if pedaco:
                    self.links.append(pedaco)

    handle_startendtag = handle_starttag


def extrair_links(html: str, url_pagina: str) -> list[str]:
    """Links absolutos (sem fragmento, sem duplicatas, na ordem em que aparecem)."""
    coletor = _Coletor()
    try:
        coletor.feed(html)
        coletor.close()
    except Exception:  # noqa: BLE001 - HTML quebrado: fica com o que deu para ler
        pass
    base = urljoin(url_pagina, coletor.base) if coletor.base else url_pagina
    vistos, saida = set(), []
    for bruto in coletor.links:
        if bruto.lower().startswith(IGNORAR_PREFIXOS):
            continue
        try:
            absoluta = sem_fragmento(urljoin(base, bruto))
        except ValueError:
            continue
        if urlsplit(absoluta).scheme not in ("http", "https"):
            continue
        chave = normalizar(absoluta)
        if chave not in vistos:
            vistos.add(chave)
            saida.append(absoluta)
    return saida


def sem_fragmento(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path or "/", p.query, ""))


def normalizar(url: str) -> str:
    """Chave para deduplicar: esquema e domínio minúsculos, sem porta padrão,
    sem fragmento, caminho vazio vira "/", parâmetros em ordem."""
    p = urlsplit(url.strip())
    esquema = p.scheme.lower()
    host = (p.hostname or "").lower()
    porta = p.port
    if porta and not ((esquema == "http" and porta == 80) or (esquema == "https" and porta == 443)):
        host = f"{host}:{porta}"
    if p.username:
        host = f"{p.username}@{host}"
    query = urlencode(sorted(parse_qsl(p.query, keep_blank_values=True)))
    return urlunsplit((esquema, host, p.path or "/", query, ""))


def mesmo_site(url: str, raiz: str, subdominios: bool = False) -> bool:
    h = (urlsplit(url).hostname or "").lower()
    r = (urlsplit(raiz).hostname or "").lower()
    if h.startswith("www."):
        h = h[4:]
    if r.startswith("www."):
        r = r[4:]
    return h == r or (subdominios and h.endswith("." + r))
