"""Checa uma URL: código HTTP, cadeia de redirects, tempo e motivo da falha.

Estratégia: HEAD primeiro (não baixa corpo). Se o HEAD falhar ou devolver
>= 400, repete com GET, porque muitos servidores tratam HEAD errado (405, 403,
404 ou até 500 no HEAD e 200 no GET). O GET é em streaming e o corpo não é lido,
a não ser que quem chama peça o HTML (rastreio).
"""

from __future__ import annotations

import ssl
import time
from dataclasses import asdict, dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

from . import VERSAO
from .classificar import classificar

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) Chrome/140.0 Safari/537.36 ValidaURL/{VERSAO}"
)
CABECALHOS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}
MAX_REDIRECTS = 10
MAX_HTML = 2 * 1024 * 1024
STATUS_REDIRECT = (301, 302, 303, 307, 308)


@dataclass
class Opcoes:
    timeout: float = 15.0
    seguir_redirects: bool = True
    verificar_ssl: bool = True
    concorrencia: int = 16
    por_host: int = 4
    so_get: bool = False


@dataclass
class Resultado:
    url: str
    status: int | None = None
    categoria: str = ""
    url_final: str = ""
    redirects: list[tuple[int, str]] = field(default_factory=list)
    tempo_ms: int = 0
    erro: str = ""
    encontrado_em: str = ""
    tipo: str = ""
    metodo: str = ""

    @property
    def n_redirects(self) -> int:
        return len(self.redirects)

    @property
    def status_inicial(self) -> int | None:
        return self.redirects[0][0] if self.redirects else self.status

    def como_dict(self) -> dict:
        d = asdict(self)
        d["redirects"] = [{"status": s, "url": u} for s, u in self.redirects]
        return d


def novo_cliente(opcoes: Opcoes) -> httpx.Client:
    limite = max(opcoes.concorrencia, 1)
    return httpx.Client(
        headers=CABECALHOS,
        timeout=httpx.Timeout(opcoes.timeout, connect=min(opcoes.timeout, 10.0)),
        follow_redirects=False,
        verify=opcoes.verificar_ssl,
        limits=httpx.Limits(max_connections=limite * 2, max_keepalive_connections=limite),
    )


def descrever_erro(exc: BaseException) -> str:
    texto = str(exc) or exc.__class__.__name__
    baixo = texto.lower()
    if isinstance(exc, httpx.TimeoutException):
        return "Tempo esgotado"
    if isinstance(exc, ssl.SSLError) or "certificate" in baixo or "ssl" in baixo:
        return f"Erro de certificado/SSL: {texto}"
    if isinstance(exc, httpx.ConnectError):
        if any(p in baixo for p in ("getaddrinfo", "name or service", "nodename", "no address",
                                     "name resolution", "11001")):
            return "Domínio não encontrado (DNS)"
        if "refused" in baixo or "10061" in baixo:
            return "Conexão recusada"
        return f"Falha de conexão: {texto}"
    if isinstance(exc, httpx.RemoteProtocolError):
        return f"Resposta inválida do servidor: {texto}"
    if isinstance(exc, httpx.UnsupportedProtocol):
        return "Protocolo não suportado (use http ou https)"
    if isinstance(exc, httpx.InvalidURL):
        return f"URL inválida: {texto}"
    return f"{exc.__class__.__name__}: {texto}"


def url_valida(url: str) -> str | None:
    """None se a URL é checável; senão o motivo."""
    try:
        partes = urlsplit(url)
    except ValueError:
        return "URL inválida"
    if partes.scheme not in ("http", "https"):
        return "Protocolo não suportado (use http ou https)"
    if not partes.hostname:
        return "URL sem domínio"
    return None


def _uma_requisicao(cliente: httpx.Client, metodo: str, url: str, ler_html: bool):
    """(status, location, tipo, html|None). Nunca segue redirect sozinho."""
    with cliente.stream(metodo, url) as r:
        tipo = r.headers.get("content-type", "").split(";")[0].strip().lower()
        html = None
        if ler_html and metodo == "GET" and r.status_code < 300 and _eh_texto_util(tipo):
            pedacos, total = [], 0
            for bloco in r.iter_bytes():
                pedacos.append(bloco)
                total += len(bloco)
                if total >= MAX_HTML:
                    break
            bruto = b"".join(pedacos)[:MAX_HTML]
            html = bruto.decode(r.encoding or "utf-8", errors="replace")
        return r.status_code, r.headers.get("location"), tipo, html


def _eh_texto_util(tipo: str) -> bool:
    return (not tipo) or "html" in tipo or "xml" in tipo or tipo.startswith("text/")


def _seguir(cliente, metodo, url, opcoes, ler_html):
    """Executa a cadeia de redirects. Devolve (status, url_final, redirects, tipo, html)."""
    redirects: list[tuple[int, str]] = []
    atual = url
    vistos = {url}
    while True:
        status, local, tipo, html = _uma_requisicao(cliente, metodo, atual, ler_html)
        if status in STATUS_REDIRECT and local and opcoes.seguir_redirects:
            proxima = urljoin(atual, local)
            redirects.append((status, atual))
            if proxima in vistos:
                raise _LoopRedirect(f"Loop de redirect em {proxima}")
            if len(redirects) >= MAX_REDIRECTS:
                raise _LoopRedirect(f"Mais de {MAX_REDIRECTS} redirects")
            motivo = url_valida(proxima)
            if motivo:
                raise _LoopRedirect(f"Redirect para endereço não checável: {proxima}")
            vistos.add(proxima)
            atual = proxima
            continue
        return status, atual, redirects, tipo, html


class _LoopRedirect(Exception):
    pass


def verificar(url: str, cliente: httpx.Client, opcoes: Opcoes, ler_html: bool = False,
              encontrado_em: str = "") -> tuple[Resultado, str | None]:
    """Checa a URL. Devolve (Resultado, html se ler_html e a página é texto)."""
    res = Resultado(url=url, encontrado_em=encontrado_em)
    motivo = url_valida(url)
    if motivo:
        res.erro = motivo
        res.categoria = classificar(None, 0)
        return res, None

    inicio = time.perf_counter()
    html = None
    metodos = ["GET"] if (opcoes.so_get or ler_html) else ["HEAD", "GET"]
    for i, metodo in enumerate(metodos):
        ultimo = i == len(metodos) - 1
        try:
            status, final, redirects, tipo, html = _seguir(cliente, metodo, url, opcoes, ler_html)
        except _LoopRedirect as exc:
            res.status, res.erro, res.metodo = None, str(exc), metodo
            if not ultimo:
                continue
            break
        except Exception as exc:  # noqa: BLE001 - qualquer falha vira resultado
            res.status, res.erro, res.metodo = None, descrever_erro(exc), metodo
            # Timeout/DNS no HEAD se repetiriam no GET: não gastar o dobro do tempo.
            if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError)) or ultimo:
                break
            continue
        res.status, res.url_final, res.redirects, res.tipo, res.metodo = status, final, redirects, tipo, metodo
        res.erro = ""
        if status < 400 or ultimo:
            break
    res.tempo_ms = int((time.perf_counter() - inicio) * 1000)
    res.categoria = classificar(res.status, res.n_redirects, opcoes.seguir_redirects)
    if res.status is not None and not res.erro and res.status >= 400:
        res.erro = httpx.codes.get_reason_phrase(res.status) or ""
    return res, html
