"""Execução em segundo plano.

Nenhuma thread de trabalho toca em widget: os resultados vão para uma fila e a
janela os recolhe com um QTimer; o fim vem por sinal (conexão enfileirada).
"""

from __future__ import annotations

import threading
from collections import deque

from PySide6.QtCore import QObject, Signal

from ..lote import verificar_lote
from ..rastreador import OpcoesRastreio, rastrear
from ..sitemap import ErroSitemap, urls_do_sitemap
from ..verificador import Opcoes, Resultado, novo_cliente


class Trabalho(QObject):
    terminou = Signal(list, str)  # avisos, erro ("" se ok)
    fase = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.fila: deque[Resultado] = deque()
        self.cancelar = threading.Event()
        self.total = 0
        self.paginas = 0
        self._thread: threading.Thread | None = None

    @property
    def rodando(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _iniciar(self, alvo, *args):
        self.cancelar = threading.Event()
        self.fila.clear()
        self.total = 0
        self.paginas = 0
        self._thread = threading.Thread(target=self._envelope, args=(alvo, *args), daemon=True)
        self._thread.start()

    def _envelope(self, alvo, *args):
        avisos: list[str] = []
        try:
            alvo(avisos, *args)
        except ErroSitemap as exc:
            self.terminou.emit(avisos, f"Não consegui ler o sitemap: {exc}")
            return
        except ValueError as exc:
            self.terminou.emit(avisos, str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            self.terminou.emit(avisos, f"{exc.__class__.__name__}: {exc}")
            return
        self.terminou.emit(avisos, "")

    # --- modos ------------------------------------------------------------------
    def lista(self, urls: list, opcoes: Opcoes):
        self._iniciar(self._lista, urls, opcoes)

    def _lista(self, avisos, urls, opcoes):
        self.total = len(urls)
        verificar_lote(urls, opcoes, ao_resultado=self.fila.append, cancelar=self.cancelar)

    def sitemap(self, endereco: str, opcoes: Opcoes):
        self._iniciar(self._sitemap, endereco, opcoes)

    def _sitemap(self, avisos, endereco, opcoes):
        self.fase.emit("Lendo o sitemap…")
        with novo_cliente(opcoes) as cli:
            urls = urls_do_sitemap(cli, endereco, avisos)
        if not urls:
            avisos.append("O sitemap não tem nenhuma URL.")
            return
        self.fase.emit(f"{len(urls)} URLs no sitemap")
        self._lista(avisos, [(u, endereco) for u in urls], opcoes)

    def rastreio(self, inicios: list[str], opcoes: Opcoes, opc: OpcoesRastreio):
        self._iniciar(self._rastreio, inicios, opcoes, opc)

    def _rastreio(self, avisos, inicios, opcoes, opc):
        def progresso(p):
            self.total = p.agendados
            self.paginas = p.paginas

        self.total = 1
        rastrear(inicios, opcoes, opc, ao_resultado=self.fila.append, ao_progresso=progresso,
                 cancelar=self.cancelar, avisos=avisos)
