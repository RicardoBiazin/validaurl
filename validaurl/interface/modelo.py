"""Modelo da tabela de resultados e o filtro por categoria/texto."""

from __future__ import annotations

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QSortFilterProxyModel, Qt
from PySide6.QtGui import QBrush, QColor

from ..classificar import CORES, eh_problema
from ..links import normalizar
from ..verificador import Resultado

COLUNAS = ["URL", "Status", "Categoria", "URL final", "Redirects", "Tempo (ms)", "Erro", "Encontrado em"]
COL_URL, COL_STATUS, COL_CATEGORIA, COL_FINAL, COL_REDIRECTS, COL_TEMPO, COL_ERRO, COL_ORIGEM = range(8)

FILTRO_TODAS = "Todas"
FILTRO_PROBLEMAS = "Só problemas"


class ModeloResultados(QAbstractTableModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.resultados: list[Resultado] = []
        self._indice: dict[str, int] = {}
        self._cores = {k: QBrush(QColor(v)) for k, v in CORES.items()}
        self._texto_escuro = QBrush(QColor("#1b1b1b"))

    # --- API ------------------------------------------------------------------
    def limpar(self):
        self.beginResetModel()
        self.resultados.clear()
        self._indice.clear()
        self.endResetModel()

    def adicionar(self, novos: list[Resultado]):
        """Acrescenta; se a URL já existe (re-checagem), substitui a linha."""
        acrescentar = []
        for r in novos:
            chave = normalizar(r.url)
            if chave in self._indice:
                linha = self._indice[chave]
                if not r.encontrado_em:
                    r.encontrado_em = self.resultados[linha].encontrado_em
                self.resultados[linha] = r
                self.dataChanged.emit(self.index(linha, 0), self.index(linha, len(COLUNAS) - 1))
            else:
                self._indice[chave] = -1
                acrescentar.append((chave, r))
        if acrescentar:
            inicio = len(self.resultados)
            self.beginInsertRows(QModelIndex(), inicio, inicio + len(acrescentar) - 1)
            for i, (chave, r) in enumerate(acrescentar):
                self._indice[chave] = inicio + i
                self.resultados.append(r)
            self.endInsertRows()

    def contagem(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for r in self.resultados:
            c[r.categoria] = c.get(r.categoria, 0) + 1
        return c

    def problemas(self) -> list[Resultado]:
        return [r for r in self.resultados if eh_problema(r.categoria)]

    # --- Qt -------------------------------------------------------------------
    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.resultados)

    def columnCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(COLUNAS)

    def headerData(self, secao, orientacao, papel=Qt.DisplayRole):
        if orientacao == Qt.Horizontal and papel == Qt.DisplayRole:
            return COLUNAS[secao]
        return None

    def data(self, indice, papel=Qt.DisplayRole):
        if not indice.isValid():
            return None
        r = self.resultados[indice.row()]
        col = indice.column()
        if papel == Qt.DisplayRole:
            return self._texto(r, col)
        if papel == Qt.UserRole:  # ordenação
            if col == COL_STATUS:
                return r.status if r.status is not None else -1
            if col == COL_TEMPO:
                return r.tempo_ms
            if col == COL_REDIRECTS:
                return r.n_redirects
            return self._texto(r, col)
        if papel == Qt.BackgroundRole:
            return self._cores.get(r.categoria)
        if papel == Qt.ForegroundRole:
            return self._texto_escuro  # fundo claro também no tema escuro
        if papel == Qt.ToolTipRole:
            if col == COL_REDIRECTS and r.redirects:
                return "\n".join(f"{s}  {u}" for s, u in r.redirects) + f"\n→ {r.status}  {r.url_final}"
            if col in (COL_URL, COL_FINAL, COL_ERRO, COL_ORIGEM):
                return self._texto(r, col) or None
        if papel == Qt.TextAlignmentRole and col in (COL_STATUS, COL_REDIRECTS, COL_TEMPO):
            return int(Qt.AlignRight | Qt.AlignVCenter)
        return None

    @staticmethod
    def _texto(r: Resultado, col: int) -> str:
        if col == COL_URL:
            return r.url
        if col == COL_STATUS:
            return "" if r.status is None else str(r.status)
        if col == COL_CATEGORIA:
            return r.categoria
        if col == COL_FINAL:
            return r.url_final if r.url_final and r.url_final != r.url else ""
        if col == COL_REDIRECTS:
            return str(r.n_redirects) if r.redirects else ""
        if col == COL_TEMPO:
            return str(r.tempo_ms)
        if col == COL_ERRO:
            return r.erro
        if col == COL_ORIGEM:
            return r.encontrado_em
        return ""


class FiltroResultados(QSortFilterProxyModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.categoria = FILTRO_TODAS
        self.texto = ""
        self.setSortRole(Qt.UserRole)

    def definir(self, categoria: str | None = None, texto: str | None = None):
        if categoria is not None:
            self.categoria = categoria
        if texto is not None:
            self.texto = texto.strip().lower()
        self.invalidateFilter()

    def filterAcceptsRow(self, linha, pai):
        r = self.sourceModel().resultados[linha]
        if self.categoria == FILTRO_PROBLEMAS and not eh_problema(r.categoria):
            return False
        if self.categoria not in (FILTRO_TODAS, FILTRO_PROBLEMAS) and r.categoria != self.categoria:
            return False
        if self.texto:
            alvo = " ".join((r.url, r.url_final, r.erro, r.encontrado_em, str(r.status or ""))).lower()
            return self.texto in alvo
        return True

    def resultado(self, indice_proxy) -> Resultado:
        return self.sourceModel().resultados[self.mapToSource(indice_proxy).row()]
