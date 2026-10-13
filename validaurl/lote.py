"""Checa muitas URLs em paralelo, com limite por domínio e cancelamento."""

from __future__ import annotations

import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Iterable
from urllib.parse import urlsplit

from .verificador import Opcoes, Resultado, novo_cliente, verificar


class LimitePorHost:
    """Semáforo por domínio: não martelar um servidor só com N conexões."""

    def __init__(self, por_host: int):
        self._por_host = max(por_host, 1)
        self._trava = threading.Lock()
        self._sem: dict[str, threading.Semaphore] = defaultdict(lambda: threading.Semaphore(self._por_host))

    def de(self, url: str) -> threading.Semaphore:
        host = (urlsplit(url).hostname or "").lower()
        with self._trava:
            return self._sem[host]


def verificar_lote(
    urls: Iterable[str] | Iterable[tuple[str, str]],
    opcoes: Opcoes | None = None,
    ao_resultado: Callable[[Resultado], None] | None = None,
    cancelar: threading.Event | None = None,
) -> list[Resultado]:
    """Checa as URLs (ou pares (url, encontrado_em)). Devolve na ordem de entrada.

    `ao_resultado` é chamado da thread de trabalho a cada URL concluída.
    """
    opcoes = opcoes or Opcoes()
    cancelar = cancelar or threading.Event()
    itens = [(u, "") if isinstance(u, str) else (u[0], u[1]) for u in urls]
    resultados: list[Resultado | None] = [None] * len(itens)
    limite = LimitePorHost(opcoes.por_host)

    with novo_cliente(opcoes) as cliente:
        def tarefa(i: int, url: str, origem: str):
            if cancelar.is_set():
                return i, None
            with limite.de(url):
                if cancelar.is_set():
                    return i, None
                res, _ = verificar(url, cliente, opcoes, encontrado_em=origem)
            return i, res

        with ThreadPoolExecutor(max_workers=max(opcoes.concorrencia, 1)) as pool:
            futuros = [pool.submit(tarefa, i, u, o) for i, (u, o) in enumerate(itens)]
            for fut in as_completed(futuros):
                i, res = fut.result()
                if res is None:
                    continue
                resultados[i] = res
                if ao_resultado:
                    ao_resultado(res)
            if cancelar.is_set():
                for f in futuros:
                    f.cancel()
    return [r for r in resultados if r is not None]
