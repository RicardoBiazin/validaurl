"""Aba Domínios: lista de domínios, quando vencem, onde registrar e avisos de vencimento.

A lista fica nas configurações do programa. A consulta roda em segundo plano (RDAP) e
roda sozinha ao abrir e a cada 12 horas enquanto o programa estiver aberto.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime

import httpx
from PySide6.QtCore import QObject, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QDesktopServices
from PySide6.QtWidgets import (
    QAbstractItemView, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMessageBox, QPushButton, QTableWidget,
    QTableWidgetItem, QVBoxLayout, QWidget,
)

from .. import NOME, VERSAO
from ..avisos import adaptar_ao_destino, enviar_email, enviar_webhook
from ..dominios import (
    CORES, GRAVIDADE, ROTULOS, atualizar_avisos, dias_ate, situacao, sugestoes_registro, texto_aviso, verificar,
)
from ..whois import classificar_alvo

INTERVALO_VERIFICACAO_MS = 12 * 60 * 60 * 1000
ATRASO_PRIMEIRA_MS = 4000
COLUNAS = ["Domínio", "Vence em", "Dias", "Situação", "Registrado com", "Onde registrar"]


def _data_br(iso: str | None) -> str:
    """Data do RDAP em dd/mm/aaaa; texto vazio se não der para ler."""
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%d/%m/%Y")
    except ValueError:
        return ""


class _RetornoDominios(QObject):
    pronto = Signal(list)  # resultados de verificar(); cada um com 'erro' se falhou


class AbaDominios(QWidget):
    def __init__(self, config, cfg_avisos, notificar, parent=None):
        """config: QSettings. cfg_avisos: função sem argumentos que devolve o ConfigAvisos atual.
        notificar: função(titulo, texto) que mostra o aviso na bandeja."""
        super().__init__(parent)
        self._config = config
        self._cfg_avisos = cfg_avisos
        self._notificar = notificar
        self._itens: list[dict] = self._carregar()
        self._retorno = _RetornoDominios(self)
        self._retorno.pronto.connect(self._recebeu)
        self._verificando = False

        raiz = QVBoxLayout(self)
        from .janela import _descricao  # import tardio: evita ciclo entre módulos

        raiz.addWidget(_descricao("Lista de domínios com a data de vencimento de cada um. Mostra há quantos dias vence, "
                                  "quem registrou e onde registrar ou renovar. Avisa quando um vencimento se aproxima "
                                  "(15 dias ou menos) ou quando já venceu."))
        linha = QHBoxLayout()
        self.ed_dominio = QLineEdit()
        self.ed_dominio.setPlaceholderText("exemplo.com.br")
        self.ed_dominio.returnPressed.connect(self.adicionar)
        linha.addWidget(self.ed_dominio, 1)
        bt = QPushButton("Adicionar")
        bt.clicked.connect(self.adicionar)
        linha.addWidget(bt)
        self.bt_verificar = QPushButton("Verificar agora")
        self.bt_verificar.clicked.connect(self.verificar_todos)
        linha.addWidget(self.bt_verificar)
        self.bt_remover = QPushButton("Remover")
        self.bt_remover.clicked.connect(self.remover)
        linha.addWidget(self.bt_remover)
        self.bt_registrar = QPushButton("Abrir site para registrar")
        self.bt_registrar.clicked.connect(self.abrir_registro)
        linha.addWidget(self.bt_registrar)
        raiz.addLayout(linha)

        self.tabela = QTableWidget(0, len(COLUNAS))
        self.tabela.setHorizontalHeaderLabels(COLUNAS)
        self.tabela.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tabela.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tabela.verticalHeader().setVisible(False)
        self.tabela.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        self.tabela.horizontalHeader().setStretchLastSection(True)
        self.tabela.doubleClicked.connect(lambda _i: self.abrir_registro())
        raiz.addWidget(self.tabela, 1)
        self.lbl_estado = QLabel("")
        raiz.addWidget(self.lbl_estado)

        self._temporizador = QTimer(self)
        self._temporizador.setInterval(INTERVALO_VERIFICACAO_MS)
        self._temporizador.timeout.connect(self.verificar_todos)
        self._temporizador.start()
        self._renderizar()
        if self._itens:
            QTimer.singleShot(ATRASO_PRIMEIRA_MS, self.verificar_todos)

    # ------------------------------------------------------------------ dados
    def _carregar(self) -> list[dict]:
        try:
            dados = json.loads(self._config.value("dominios", "[]") or "[]")
        except (TypeError, ValueError):
            return []
        return [d for d in dados if isinstance(d, dict) and d.get("dominio")]

    def _salvar(self):
        self._config.setValue("dominios", json.dumps(self._itens, ensure_ascii=False))

    def adicionar(self):
        texto = self.ed_dominio.text()
        try:
            tipo, alvo = classificar_alvo(texto)
        except ValueError as exc:
            QMessageBox.information(self, NOME, str(exc))
            return
        if tipo != "dominio":
            QMessageBox.information(self, NOME, "Informe um domínio (ex.: exemplo.com.br), não um IP.")
            return
        if any(i["dominio"] == alvo for i in self._itens):
            QMessageBox.information(self, NOME, f"{alvo} já está na lista.")
            return
        self._itens.append({"dominio": alvo, "expira": None, "registrador": "", "status": [], "erro": "",
                            "verificado": "", "ultimo_aviso": ""})
        self.ed_dominio.clear()
        self._salvar()
        self._renderizar()
        self.verificar_todos()

    def remover(self):
        dominio = self._dominio_selecionado()
        if not dominio:
            return
        if QMessageBox.question(self, NOME, f"Tirar {dominio} da lista?") != QMessageBox.Yes:
            return
        self._itens = [i for i in self._itens if i["dominio"] != dominio]
        self._salvar()
        self._renderizar()

    def _dominio_selecionado(self) -> str:
        linhas = self.tabela.selectionModel().selectedRows()
        return self.tabela.item(linhas[0].row(), 0).text() if linhas else ""

    def abrir_registro(self):
        dominio = self._dominio_selecionado()
        if not dominio:
            QMessageBox.information(self, NOME, "Selecione um domínio na lista.")
            return
        nome, endereco = sugestoes_registro(dominio)[0]
        QDesktopServices.openUrl(QUrl(endereco))

    # ------------------------------------------------------------------ verificação
    def verificar_todos(self):
        if self._verificando or not self._itens:
            return
        self._verificando = True
        self.bt_verificar.setEnabled(False)
        self.lbl_estado.setText("Verificando vencimentos…")
        dominios = [i["dominio"] for i in self._itens]
        threading.Thread(target=self._trabalho, args=(dominios,), daemon=True).start()

    def _trabalho(self, dominios: list[str]):
        # Thread de fundo: nada aqui toca em widget; o resultado volta pelo sinal.
        resultados = []
        with httpx.Client(headers={"User-Agent": f"ValidaURL/{VERSAO}"}, timeout=8, follow_redirects=True) as cli:
            for dominio in dominios:
                try:
                    resultados.append(verificar(dominio, cli))
                except Exception as exc:  # noqa: BLE001
                    resultados.append({"dominio": dominio, "expira": None, "registrador": "", "status": [],
                                       "erro": f"{exc.__class__.__name__}: {exc}",
                                       "verificado": datetime.now().isoformat(timespec="seconds")})
        self._retorno.pronto.emit(resultados)

    def _recebeu(self, resultados: list):
        self._verificando = False
        self.bt_verificar.setEnabled(True)
        por_dominio = {r["dominio"]: r for r in resultados}
        for item in self._itens:
            r = por_dominio.get(item["dominio"])
            if r:
                for campo in ("expira", "registrador", "status", "erro", "verificado"):
                    item[campo] = r[campo]
        novos = atualizar_avisos(self._itens)
        self._salvar()
        self._renderizar()
        self.lbl_estado.setText(f"Verificado às {datetime.now():%H:%M}.")
        if novos:
            self._avisar(novos)

    def _avisar(self, novos: list[dict]):
        textos = [texto_aviso(i) for i in novos]
        self._notificar(f"{NOME}: vencimento de domínio", "\n".join(textos))
        cfg = self._cfg_avisos()
        corpo = "\n".join(textos)
        if cfg.email.ativo:
            threading.Thread(target=self._enviar_email, args=(cfg.email, corpo), daemon=True).start()
        if cfg.webhook.strip():
            dados = adaptar_ao_destino(cfg.webhook.strip(), {"text": f"{NOME}: vencimento de domínio\n{corpo}"})
            threading.Thread(target=lambda: enviar_webhook(cfg.webhook.strip(), dados), daemon=True).start()

    @staticmethod
    def _enviar_email(email_cfg, corpo: str):
        try:
            enviar_email(email_cfg, f"{NOME}: vencimento de domínio", corpo)
        except Exception:  # noqa: BLE001 - falha de e-mail não derruba a aba
            pass

    # ------------------------------------------------------------------ tabela
    def _renderizar(self):
        agora = datetime.now().astimezone()
        ordenados = sorted(self._itens, key=lambda i: (
            GRAVIDADE[situacao(dias_ate(i.get("expira"), agora))],
            dias_ate(i.get("expira"), agora) if dias_ate(i.get("expira"), agora) is not None else 10**9,
        ))
        self.tabela.setRowCount(len(ordenados))
        for linha, item in enumerate(ordenados):
            dias = dias_ate(item.get("expira"), agora)
            sit = situacao(dias)
            nomes = " · ".join(n for n, _ in sugestoes_registro(item["dominio"]))
            celulas = [
                item["dominio"],
                _data_br(item.get("expira")) or item.get("erro") or "—",
                "" if dias is None else str(dias),
                ROTULOS[sit],
                item.get("registrador") or "—",
                nomes,
            ]
            for col, texto in enumerate(celulas):
                cel = QTableWidgetItem(texto)
                cel.setBackground(QColor(CORES[sit]))
                cel.setForeground(QColor("#1b1b1b"))
                if col == 5:
                    cel.setToolTip("\n".join(f"{n}: {u}" for n, u in sugestoes_registro(item["dominio"])))
                self.tabela.setItem(linha, col, cel)
        self.tabela.resizeColumnsToContents()
        self.tabela.setColumnWidth(0, 220)
        self.tabela.setColumnWidth(5, 420)
        self.bt_registrar.setEnabled(bool(self._itens))
        self.bt_remover.setEnabled(bool(self._itens))
