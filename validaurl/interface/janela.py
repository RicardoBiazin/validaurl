"""Janela principal do ValidaURL."""

from __future__ import annotations

from pathlib import Path

import json
import os
import threading
from datetime import datetime, timedelta

from PySide6.QtCore import QObject, QSettings, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QAction, QDesktopServices, QGuiApplication, QIcon, QKeySequence
from PySide6.QtWidgets import (
    QAbstractItemView, QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QHBoxLayout,
    QHeaderView, QLabel, QLineEdit, QMainWindow, QMenu, QMessageBox, QPlainTextEdit, QProgressBar,
    QPushButton, QSpinBox, QSplitter, QStyle, QSystemTrayIcon, QTableView, QTabWidget, QVBoxLayout, QWidget,
)

from .. import NOME, VERSAO, segredos
from ..avisos import ConfigAvisos, Mudancas, comparar, disparar
from ..classificar import TODAS
from ..entradas import urls_do_arquivo, urls_do_texto
from ..exportar import exportar
from ..rastreador import OpcoesRastreio
from ..verificador import Opcoes, url_valida
from .modelo import (
    COL_CATEGORIA, COL_ERRO, COL_FINAL, COL_ORIGEM, COL_URL, FILTRO_PROBLEMAS, FILTRO_TODAS,
    FiltroResultados, ModeloResultados,
)
from .dialogo_avisos import DialogoAvisos
from .trabalho import Trabalho

ABA_LISTA, ABA_RASTREIO, ABA_SITEMAP = range(3)
FILTRO_ARQUIVOS = "Listas de URLs (*.txt *.csv *.tsv *.xlsx *.xlsm *.html *.htm);;Todos os arquivos (*)"


class _RetornoAvisos(QObject):
    erros = Signal(list)


def _com_esquema(texto: str) -> str:
    texto = texto.strip()
    if texto and "://" not in texto:
        texto = "https://" + texto
    return texto


class JanelaPrincipal(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"{NOME} {VERSAO}")
        self.resize(1200, 760)
        # VALIDAURL_CONFIG aponta para um .ini à parte (testes e autoverificação),
        # para não ler nem gravar a configuração real do usuário no registro.
        arquivo_config = os.environ.get("VALIDAURL_CONFIG")
        self.config = (QSettings(arquivo_config, QSettings.IniFormat) if arquivo_config
                       else QSettings("RicardoBiazin", NOME))
        self.modelo = ModeloResultados(self)
        self.filtro = FiltroResultados(self)
        self.filtro.setSourceModel(self.modelo)
        self.trabalho = Trabalho(self)
        self.trabalho.terminou.connect(self._terminou)
        self.trabalho.fase.connect(lambda t: self.lbl_fase.setText(t))
        self.cfg_avisos = ConfigAvisos()
        self._anteriores = None
        self._alvo = ""
        self._automatico = False
        self._proxima: datetime | None = None
        self._saindo = False
        self._retorno_avisos = _RetornoAvisos(self)
        self._retorno_avisos.erros.connect(self._erros_avisos)
        self.relogio_monitor = QTimer(self)
        self.relogio_monitor.setInterval(1000)
        self.relogio_monitor.timeout.connect(self._tique_monitor)
        self._montar()
        self._montar_bandeja()
        self._carregar_config()
        self.temporizador = QTimer(self)
        self.temporizador.setInterval(120)
        self.temporizador.timeout.connect(self._recolher)
        # Grava sozinho logo depois de cada edição: a lista não se perde se o
        # Windows desligar ou o processo for encerrado sem passar pelo fechar.
        self.autosalvar = QTimer(self)
        self.autosalvar.setSingleShot(True)
        self.autosalvar.setInterval(800)
        self.autosalvar.timeout.connect(self._autosalvar)
        for sinal in (self.txt_lista.textChanged, self.ed_site.textChanged, self.ed_sitemap.textChanged):
            sinal.connect(self.autosalvar.start)
        self._rechecando = False
        self._atualizar_botoes()

    # ------------------------------------------------------------------ montagem
    def _montar(self):
        central = QWidget()
        raiz = QVBoxLayout(central)

        # Divisor arrastável: a área da lista cresce puxando a borda para baixo.
        self.divisor = QSplitter(Qt.Vertical)
        self.divisor.setChildrenCollapsible(False)
        raiz.addWidget(self.divisor, 1)
        self.abas = QTabWidget()
        self.abas.setMinimumHeight(140)
        self.divisor.addWidget(self.abas)

        # Lista
        w = QWidget()
        lay = QVBoxLayout(w)
        self.txt_lista = QPlainTextEdit()
        self.txt_lista.setPlaceholderText("Cole aqui as URLs (uma por linha, ou texto livre com links)…")
        self.txt_lista.textChanged.connect(self._contar_lista)
        lay.addWidget(self.txt_lista)
        linha = QHBoxLayout()
        b = QPushButton("Abrir arquivo…")
        b.clicked.connect(self.abrir_arquivo)
        linha.addWidget(b)
        b = QPushButton("Salvar lista…")
        b.setToolTip("Grava as URLs num .txt (ou .csv) para abrir depois. Ctrl+Shift+S")
        b.clicked.connect(self.salvar_lista)
        linha.addWidget(b)
        b = QPushButton("Limpar")
        b.clicked.connect(self.txt_lista.clear)
        linha.addWidget(b)
        self.lbl_qtd = QLabel("0 URLs")
        linha.addWidget(self.lbl_qtd)
        linha.addStretch(1)
        lay.addLayout(linha)
        self.abas.addTab(w, "Lista de URLs")

        # Rastreio
        w = QWidget()
        form = QFormLayout(w)
        self.ed_site = QLineEdit()
        self.ed_site.setPlaceholderText("https://www.seusite.com.br/")
        self.ed_site.returnPressed.connect(self.iniciar)
        form.addRow("Site:", self.ed_site)
        self.sp_paginas = QSpinBox()
        self.sp_paginas.setRange(1, 100000)
        self.sp_paginas.setValue(500)
        self.sp_prof = QSpinBox()
        self.sp_prof.setRange(0, 100)
        self.sp_prof.setValue(10)
        linha = QHBoxLayout()
        linha.addWidget(QLabel("Máx. páginas:"))
        linha.addWidget(self.sp_paginas)
        linha.addWidget(QLabel("Profundidade:"))
        linha.addWidget(self.sp_prof)
        linha.addStretch(1)
        form.addRow(linha)
        self.ck_externos = QCheckBox("Checar links externos")
        self.ck_externos.setChecked(True)
        self.ck_subdom = QCheckBox("Incluir subdomínios no rastreio")
        self.ck_robots = QCheckBox("Respeitar robots.txt")
        self.ck_robots.setChecked(True)
        linha = QHBoxLayout()
        for ck in (self.ck_externos, self.ck_subdom, self.ck_robots):
            linha.addWidget(ck)
        linha.addStretch(1)
        form.addRow(linha)
        self.abas.addTab(w, "Rastrear site")

        # Sitemap
        w = QWidget()
        form = QFormLayout(w)
        self.ed_sitemap = QLineEdit()
        self.ed_sitemap.setPlaceholderText("https://www.seusite.com.br/sitemap.xml  (ou só o site)")
        self.ed_sitemap.returnPressed.connect(self.iniciar)
        form.addRow("Sitemap:", self.ed_sitemap)
        form.addRow(QLabel("Aceita sitemap index e .xml.gz. Só com o endereço do site, procura no robots.txt "
                           "e em /sitemap.xml."))
        self.abas.addTab(w, "Sitemap")

        # Tudo daqui para baixo fica na parte de baixo do divisor.
        baixo = QWidget()
        self.divisor.addWidget(baixo)
        self.divisor.setStretchFactor(0, 1)
        self.divisor.setStretchFactor(1, 2)
        self.divisor.setSizes([320, 440])
        raiz = QVBoxLayout(baixo)
        raiz.setContentsMargins(0, 0, 0, 0)

        # Opções comuns
        linha = QHBoxLayout()
        linha.addWidget(QLabel("Tempo limite (s):"))
        self.sp_timeout = QDoubleSpinBox()
        self.sp_timeout.setRange(1, 120)
        self.sp_timeout.setValue(15)
        linha.addWidget(self.sp_timeout)
        linha.addWidget(QLabel("Simultâneas:"))
        self.sp_conc = QSpinBox()
        self.sp_conc.setRange(1, 64)
        self.sp_conc.setValue(16)
        linha.addWidget(self.sp_conc)
        linha.addWidget(QLabel("Por domínio:"))
        self.sp_host = QSpinBox()
        self.sp_host.setRange(1, 32)
        self.sp_host.setValue(4)
        linha.addWidget(self.sp_host)
        self.ck_redirect = QCheckBox("Seguir redirects")
        self.ck_redirect.setChecked(True)
        self.ck_ssl = QCheckBox("Verificar certificado SSL")
        self.ck_ssl.setChecked(True)
        self.ck_get = QCheckBox("Só GET")
        self.ck_get.setToolTip("Não tenta HEAD antes. Mais lento, mas igual ao navegador.")
        for ck in (self.ck_redirect, self.ck_ssl, self.ck_get):
            linha.addWidget(ck)
        linha.addStretch(1)
        raiz.addLayout(linha)

        # Monitoramento
        linha = QHBoxLayout()
        self.ck_monitor = QCheckBox("Repetir a cada")
        self.ck_monitor.setToolTip("Depois de cada checagem, agenda a próxima e avisa quando algo mudar.")
        self.ck_monitor.toggled.connect(self._monitor_alterado)
        linha.addWidget(self.ck_monitor)
        self.sp_minutos = QSpinBox()
        self.sp_minutos.setRange(1, 1440)
        self.sp_minutos.setValue(15)
        self.sp_minutos.setSuffix(" min")
        linha.addWidget(self.sp_minutos)
        self.bt_avisos = QPushButton("Avisos (e-mail, webhook, notificação)…")
        self.bt_avisos.clicked.connect(self.configurar_avisos)
        linha.addWidget(self.bt_avisos)
        self.lbl_proxima = QLabel("")
        linha.addWidget(self.lbl_proxima)
        linha.addStretch(1)
        raiz.addLayout(linha)

        # Ações
        linha = QHBoxLayout()
        self.bt_validar = QPushButton("Validar  (Ctrl+Enter)")
        self.bt_validar.setDefault(True)
        self.bt_validar.clicked.connect(self.iniciar)
        self.bt_cancelar = QPushButton("Cancelar")
        self.bt_cancelar.clicked.connect(self.cancelar)
        self.bt_rechecar = QPushButton("Re-checar problemas")
        self.bt_rechecar.clicked.connect(self.rechecar)
        self.bt_exportar = QPushButton("Exportar…")
        self.bt_exportar.clicked.connect(self.exportar)
        for bt in (self.bt_validar, self.bt_cancelar, self.bt_rechecar, self.bt_exportar):
            linha.addWidget(bt)
        linha.addSpacing(20)
        linha.addWidget(QLabel("Mostrar:"))
        self.cb_filtro = QComboBox()
        self.cb_filtro.addItems([FILTRO_TODAS, FILTRO_PROBLEMAS, *TODAS])
        self.cb_filtro.currentTextChanged.connect(lambda t: (self.filtro.definir(categoria=t), self._resumo()))
        linha.addWidget(self.cb_filtro)
        self.ed_busca = QLineEdit()
        self.ed_busca.setPlaceholderText("Buscar…")
        self.ed_busca.setClearButtonEnabled(True)
        self.ed_busca.textChanged.connect(lambda t: (self.filtro.definir(texto=t), self._resumo()))
        linha.addWidget(self.ed_busca, 1)
        raiz.addLayout(linha)

        # Tabela
        self.tabela = QTableView()
        self.tabela.setModel(self.filtro)
        self.tabela.setSortingEnabled(True)
        self.tabela.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.tabela.setAlternatingRowColors(False)
        self.tabela.verticalHeader().setVisible(False)
        self.tabela.verticalHeader().setDefaultSectionSize(22)
        cab = self.tabela.horizontalHeader()
        cab.setSectionResizeMode(QHeaderView.Interactive)
        for col, larg in ((COL_URL, 380), (1, 60), (COL_CATEGORIA, 140), (COL_FINAL, 220), (4, 70), (5, 80),
                          (COL_ERRO, 200), (COL_ORIGEM, 260)):
            self.tabela.setColumnWidth(col, larg)
        cab.setStretchLastSection(True)
        self.tabela.doubleClicked.connect(self._abrir_no_navegador)
        self.tabela.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tabela.customContextMenuRequested.connect(self._menu_tabela)
        raiz.addWidget(self.tabela, 1)

        # Progresso
        linha = QHBoxLayout()
        self.progresso = QProgressBar()
        self.progresso.setTextVisible(True)
        linha.addWidget(self.progresso, 1)
        self.lbl_fase = QLabel("")
        linha.addWidget(self.lbl_fase)
        raiz.addLayout(linha)

        self.setCentralWidget(central)
        self.lbl_resumo = QLabel("")
        self.statusBar().addWidget(self.lbl_resumo, 1)
        self.statusBar().addPermanentWidget(QLabel(f"{NOME} {VERSAO}"))

        # Menu e atalhos
        menu = self.menuBar().addMenu("&Arquivo")
        acao = QAction("&Abrir lista de URLs…", self, shortcut=QKeySequence.Open, triggered=self.abrir_arquivo)
        menu.addAction(acao)
        acao = QAction("&Salvar lista de URLs…", self, shortcut=QKeySequence("Ctrl+Shift+S"),
                       triggered=self.salvar_lista)
        menu.addAction(acao)
        acao = QAction("&Exportar resultados…", self, shortcut=QKeySequence("Ctrl+S"), triggered=self.exportar)
        menu.addAction(acao)
        menu.addSeparator()
        menu.addAction(QAction("Sai&r", self, shortcut=QKeySequence("Ctrl+Q"), triggered=self.close))
        menu = self.menuBar().addMenu("A&juda")
        menu.addAction(QAction("&Sobre o ValidaURL", self, triggered=self.sobre))
        for tecla in ("Ctrl+Return", "Ctrl+Enter", "F5"):
            self.addAction(QAction(self, shortcut=QKeySequence(tecla), triggered=self.iniciar))
        self.addAction(QAction(self, shortcut=QKeySequence("Esc"), triggered=self.cancelar))

    # ------------------------------------------------------------------ config
    def _carregar_config(self):
        c = self.config
        try:
            self.sp_timeout.setValue(float(c.value("timeout", 15)))
            self.sp_conc.setValue(int(c.value("concorrencia", 16)))
            self.sp_host.setValue(int(c.value("por_host", 4)))
            self.ck_redirect.setChecked(c.value("seguir", "true") == "true")
            self.ck_ssl.setChecked(c.value("ssl", "true") == "true")
            self.ck_get.setChecked(c.value("so_get", "false") == "true")
            self.ed_site.setText(c.value("site", ""))
            self.ed_sitemap.setText(c.value("sitemap", ""))
            # A lista da última sessão volta sozinha (não se perde ao fechar).
            self.txt_lista.setPlainText(c.value("lista", "") or "")
            divisor = c.value("divisor")
            if divisor is not None:
                self.divisor.restoreState(divisor)
            self.abas.setCurrentIndex(int(c.value("aba", 0)))
            self.sp_minutos.setValue(int(c.value("minutos", 15)))
            self.cfg_avisos = ConfigAvisos.de_dict(json.loads(c.value("avisos", "{}") or "{}"), segredos.revelar)
        except (TypeError, ValueError):
            pass

    def _salvar_config(self):
        c = self.config
        c.setValue("timeout", self.sp_timeout.value())
        c.setValue("concorrencia", self.sp_conc.value())
        c.setValue("por_host", self.sp_host.value())
        c.setValue("seguir", "true" if self.ck_redirect.isChecked() else "false")
        c.setValue("ssl", "true" if self.ck_ssl.isChecked() else "false")
        c.setValue("so_get", "true" if self.ck_get.isChecked() else "false")
        c.setValue("site", self.ed_site.text())
        c.setValue("sitemap", self.ed_sitemap.text())
        c.setValue("lista", self.txt_lista.toPlainText()[:2_000_000])
        c.setValue("divisor", self.divisor.saveState())
        c.setValue("aba", self.abas.currentIndex())
        c.setValue("minutos", self.sp_minutos.value())
        c.setValue("avisos", json.dumps(self.cfg_avisos.como_dict(segredos.proteger), ensure_ascii=False))

    def _autosalvar(self):
        self._salvar_config()
        self.config.sync()

    def closeEvent(self, ev):
        if self.ck_monitor.isChecked() and self.bandeja is not None and not self._saindo:
            # Monitorando: fecha para a bandeja e continua checando.
            ev.ignore()
            self.hide()
            self.bandeja.show()
            self.bandeja.showMessage(NOME, "Continuo monitorando aqui na bandeja. "
                                     "Para sair de vez, use o menu do ícone.", QSystemTrayIcon.Information, 5000)
            return
        self._salvar_config()
        self.trabalho.cancelar.set()
        self.relogio_monitor.stop()
        if self.bandeja is not None:
            self.bandeja.hide()
        super().closeEvent(ev)

    def sair(self):
        self._saindo = True
        self.close()
        app = QApplication.instance()
        if app is not None and not self.isVisible():
            app.quit()

    # ------------------------------------------------------------------ monitoramento
    def _montar_bandeja(self):
        self.bandeja = None
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        app = QApplication.instance()
        icone = app.windowIcon() if app is not None else QIcon()
        if icone.isNull():
            icone = self.style().standardIcon(QStyle.SP_DialogApplyButton)
        self.bandeja = QSystemTrayIcon(icone, self)
        self.bandeja.setToolTip(NOME)
        menu = QMenu(self)
        menu.addAction("Abrir o ValidaURL", self._mostrar_janela)
        menu.addAction("Checar agora", lambda: self.iniciar(automatico=True))
        menu.addSeparator()
        menu.addAction("Sair (para o monitoramento)", self.sair)
        self.bandeja.setContextMenu(menu)
        self.bandeja.activated.connect(self._bandeja_ativada)
        self.bandeja.messageClicked.connect(self._mostrar_janela)

    def _bandeja_ativada(self, motivo):
        if motivo in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick):
            self._mostrar_janela()

    def _mostrar_janela(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def configurar_avisos(self):
        dlg = DialogoAvisos(self.cfg_avisos, self)
        if dlg.exec():
            self.cfg_avisos = dlg.config()
            self._salvar_config()

    def _monitor_alterado(self, ligado: bool):
        if ligado:
            if self.bandeja is not None:
                self.bandeja.show()
            if self.modelo.resultados and not self.trabalho.rodando:
                self._agendar()
            else:
                self.lbl_proxima.setText("Começa ao clicar em Validar")
        else:
            self._proxima = None
            self.relogio_monitor.stop()
            self.lbl_proxima.setText("")
            if self.bandeja is not None and self.isVisible():
                self.bandeja.hide()

    def _agendar(self):
        self._proxima = datetime.now() + timedelta(minutes=self.sp_minutos.value())
        self.relogio_monitor.start()
        self._tique_monitor()

    def _tique_monitor(self):
        if self._proxima is None:
            return
        falta = (self._proxima - datetime.now()).total_seconds()
        if falta <= 0:
            self._proxima = None
            self.relogio_monitor.stop()
            if not self.trabalho.rodando:
                self.iniciar(automatico=True)
            return
        minutos, segundos = divmod(int(falta), 60)
        self.lbl_proxima.setText(f"Próxima checagem às {self._proxima:%H:%M} (em {minutos}:{segundos:02d})")
        if self.bandeja is not None:
            self.bandeja.setToolTip(f"{NOME}: próxima checagem às {self._proxima:%H:%M}")

    def _avisar(self, m: Mudancas):
        cfg = self.cfg_avisos
        if m.vazio(cfg.repetir_problemas, cfg.avisar_recuperacao):
            return
        if cfg.notificacao and self.bandeja is not None:
            if m.novos_problemas:
                texto = f"{len(m.novos_problemas)} link(s) passaram a falhar em {self._alvo}"
                icone = QSystemTrayIcon.Warning
            elif cfg.repetir_problemas and m.ainda_com_problema:
                texto = f"{len(m.ainda_com_problema)} link(s) continuam com problema em {self._alvo}"
                icone = QSystemTrayIcon.Warning
            else:
                texto = f"{len(m.recuperados)} link(s) voltaram ao normal em {self._alvo}"
                icone = QSystemTrayIcon.Information
            self.bandeja.show()
            self.bandeja.showMessage(NOME, texto, icone, 10000)
        if cfg.email.ativo or cfg.webhook.strip():
            alvo = self._alvo
            retorno = self._retorno_avisos
            threading.Thread(target=lambda: retorno.erros.emit(disparar(cfg, m, alvo)), daemon=True).start()

    def _erros_avisos(self, erros: list):
        if erros:
            self.statusBar().showMessage("Falha ao enviar aviso: " + " | ".join(erros), 15000)

    # ------------------------------------------------------------------ ações
    def opcoes(self) -> Opcoes:
        return Opcoes(timeout=self.sp_timeout.value(), seguir_redirects=self.ck_redirect.isChecked(),
                      verificar_ssl=self.ck_ssl.isChecked(), concorrencia=self.sp_conc.value(),
                      por_host=self.sp_host.value(), so_get=self.ck_get.isChecked())

    def _contar_lista(self):
        n = len(urls_do_texto(self.txt_lista.toPlainText()))
        self.lbl_qtd.setText(f"{n} URL" + ("" if n == 1 else "s"))

    def abrir_arquivo(self):
        caminho, _ = QFileDialog.getOpenFileName(self, "Abrir lista de URLs", self.config.value("pasta", ""),
                                                 FILTRO_ARQUIVOS)
        if not caminho:
            return
        self.config.setValue("pasta", str(Path(caminho).parent))
        try:
            urls = urls_do_arquivo(caminho)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, NOME, f"Não consegui ler o arquivo:\n{exc}")
            return
        if not urls:
            QMessageBox.information(self, NOME, "Nenhuma URL encontrada no arquivo.")
            return
        self.txt_lista.setPlainText("\n".join(urls))
        self.abas.setCurrentIndex(ABA_LISTA)

    def salvar_lista(self):
        urls = urls_do_texto(self.txt_lista.toPlainText())
        if not urls:
            QMessageBox.information(self, NOME, "A lista está vazia.")
            return
        caminho, _ = QFileDialog.getSaveFileName(
            self, "Salvar lista de URLs", str(Path(self.config.value("pasta", "")) / "urls.txt"),
            "Texto, uma URL por linha (*.txt);;CSV (*.csv)")
        if not caminho:
            return
        self.config.setValue("pasta", str(Path(caminho).parent))
        try:
            if caminho.lower().endswith(".csv"):
                Path(caminho).write_text("URL\n" + "\n".join(urls) + "\n", encoding="utf-8-sig")
            else:
                Path(caminho).write_text("\n".join(urls) + "\n", encoding="utf-8")
        except OSError as exc:
            QMessageBox.warning(self, NOME, f"Não consegui salvar:\n{exc}")
            return
        self.statusBar().showMessage(f"{len(urls)} URLs salvas em {caminho}", 8000)

    def iniciar(self, automatico: bool = False):
        if self.trabalho.rodando:
            return
        self._automatico = bool(automatico)
        # Base de comparação para os avisos: na 1ª checagem, todo problema é novo.
        self._anteriores = list(self.modelo.resultados) if automatico else None
        aba = self.abas.currentIndex()
        opcoes = self.opcoes()
        if aba == ABA_LISTA:
            urls = urls_do_texto(self.txt_lista.toPlainText())
            if not urls:
                QMessageBox.information(self, NOME, "Cole ou abra uma lista com pelo menos uma URL.")
                return
            self.modelo.limpar()
            self.trabalho.lista(urls, opcoes)
            self._alvo = urls[0] if len(urls) == 1 else f"lista de {len(urls)} URLs"
            self.lbl_fase.setText(f"{len(urls)} URLs")
        elif aba == ABA_RASTREIO:
            site = _com_esquema(self.ed_site.text())
            if url_valida(site):
                QMessageBox.information(self, NOME, "Informe o endereço do site (http ou https).")
                return
            self.ed_site.setText(site)
            self.modelo.limpar()
            opc = OpcoesRastreio(max_paginas=self.sp_paginas.value(), profundidade=self.sp_prof.value(),
                                 subdominios=self.ck_subdom.isChecked(), checar_externos=self.ck_externos.isChecked(),
                                 respeitar_robots=self.ck_robots.isChecked())
            self.trabalho.rastreio(site, opcoes, opc)
            self._alvo = site
            self.lbl_fase.setText("Rastreando…")
        else:
            endereco = _com_esquema(self.ed_sitemap.text())
            if url_valida(endereco):
                QMessageBox.information(self, NOME, "Informe o endereço do sitemap ou do site.")
                return
            self.ed_sitemap.setText(endereco)
            self.modelo.limpar()
            self.trabalho.sitemap(endereco, opcoes)
            self._alvo = endereco
        self._salvar_config()
        self._rechecando = False
        self._proxima = None
        self.relogio_monitor.stop()
        self.lbl_proxima.setText("Checando…" if self.ck_monitor.isChecked() else "")
        self.progresso.setRange(0, 0)
        self.temporizador.start()
        self._atualizar_botoes()

    def rechecar(self):
        if self.trabalho.rodando:
            return
        problemas = self.modelo.problemas()
        if not problemas:
            QMessageBox.information(self, NOME, "Não há problemas para re-checar.")
            return
        self.trabalho.lista([(r.url, r.encontrado_em) for r in problemas], self.opcoes())
        self.lbl_fase.setText(f"Re-checando {len(problemas)}…")
        self._rechecando = True
        self.progresso.setRange(0, 0)
        self.temporizador.start()
        self._atualizar_botoes()

    def cancelar(self):
        if self.trabalho.rodando:
            self.trabalho.cancelar.set()
            self.lbl_fase.setText("Cancelando…")
        elif self._proxima is not None:
            self.ck_monitor.setChecked(False)  # Esc sem checagem rodando: para o monitoramento

    def _recolher(self):
        lote = []
        fila = self.trabalho.fila
        while fila:
            lote.append(fila.popleft())
        if lote:
            self.modelo.adicionar(lote)
        total = self.trabalho.total
        feitos = len(self.modelo.resultados)
        if total and not self._rechecando:
            self.progresso.setRange(0, max(total, feitos))
            self.progresso.setValue(feitos)
            self.progresso.setFormat(f"%v de {max(total, feitos)}" +
                                     (f"  ·  {self.trabalho.paginas} páginas abertas" if self.trabalho.paginas else ""))
        if lote:
            self._resumo()

    def _terminou(self, avisos: list, erro: str):
        self._recolher()
        self.temporizador.stop()
        cancelado = self.trabalho.cancelar.is_set()
        n = len(self.modelo.resultados)
        self.progresso.setRange(0, max(n, 1))
        self.progresso.setValue(n if n else 0)
        self.progresso.setFormat(f"{n} checadas")
        self.lbl_fase.setText("Cancelado" if cancelado else ("Erro" if erro else "Concluído"))
        self._resumo()
        self._atualizar_botoes()
        monitorando = self.ck_monitor.isChecked() and not self._rechecando
        if monitorando and cancelado:
            self.ck_monitor.setChecked(False)
            self.statusBar().showMessage("Monitoramento parado.", 8000)
        elif monitorando:
            if not erro:
                self._avisar(comparar(self._anteriores, list(self.modelo.resultados)))
            self._agendar()
        if self._automatico:
            # Checagem agendada: nada de caixa modal empilhando na tela.
            if erro or avisos:
                self.statusBar().showMessage(erro or " ".join(avisos), 15000)
        elif erro:
            QMessageBox.warning(self, NOME, erro)
        elif avisos:
            QMessageBox.information(self, NOME, "\n".join(avisos))

    def _resumo(self):
        c = self.modelo.contagem()
        partes = [f"{k}: {v}" for k, v in c.items() if v]
        visiveis = self.filtro.rowCount()
        total = len(self.modelo.resultados)
        texto = "  ·  ".join(partes)
        if visiveis != total:
            texto += f"   (mostrando {visiveis} de {total})"
        self.lbl_resumo.setText(texto)
        self._atualizar_botoes()

    def _atualizar_botoes(self):
        rodando = self.trabalho.rodando
        self.bt_validar.setEnabled(not rodando)
        self.bt_cancelar.setEnabled(rodando)
        self.bt_rechecar.setEnabled(not rodando and bool(self.modelo.problemas()))
        self.bt_exportar.setEnabled(not rodando and bool(self.modelo.resultados))

    def exportar(self):
        if not self.modelo.resultados:
            return
        so_visiveis = self.filtro.rowCount() != len(self.modelo.resultados)
        caminho, _ = QFileDialog.getSaveFileName(
            self, "Exportar resultados", str(Path(self.config.value("pasta", "")) / "validaurl.xlsx"),
            "Planilha Excel (*.xlsx);;CSV (*.csv);;JSON (*.json)")
        if not caminho:
            return
        self.config.setValue("pasta", str(Path(caminho).parent))
        if so_visiveis:
            resultados = [self.filtro.resultado(self.filtro.index(i, 0)) for i in range(self.filtro.rowCount())]
        else:
            resultados = list(self.modelo.resultados)
        try:
            exportar(resultados, caminho)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, NOME, f"Não consegui salvar:\n{exc}")
            return
        self.statusBar().showMessage(f"{len(resultados)} linhas exportadas para {caminho}", 8000)

    def _abrir_no_navegador(self, indice):
        r = self.filtro.resultado(indice)
        alvo = r.encontrado_em if indice.column() == COL_ORIGEM and r.encontrado_em else r.url
        QDesktopServices.openUrl(QUrl(alvo))

    def _menu_tabela(self, pos):
        indice = self.tabela.indexAt(pos)
        if not indice.isValid():
            return
        r = self.filtro.resultado(indice)
        menu = QMenu(self)
        menu.addAction("Abrir URL no navegador", lambda: QDesktopServices.openUrl(QUrl(r.url)))
        if r.encontrado_em:
            menu.addAction("Abrir página onde foi encontrado",
                           lambda: QDesktopServices.openUrl(QUrl(r.encontrado_em)))
        menu.addSeparator()
        menu.addAction("Copiar URL", lambda: QGuiApplication.clipboard().setText(r.url))
        if r.url_final:
            menu.addAction("Copiar URL final", lambda: QGuiApplication.clipboard().setText(r.url_final))
        selecionadas = {self.filtro.resultado(i).url for i in self.tabela.selectionModel().selectedRows()}
        if len(selecionadas) > 1:
            menu.addAction(f"Copiar {len(selecionadas)} URLs selecionadas",
                           lambda: QGuiApplication.clipboard().setText("\n".join(sorted(selecionadas))))
        menu.exec(self.tabela.viewport().mapToGlobal(pos))

    def sobre(self):
        QMessageBox.about(self, f"Sobre o {NOME}", (
            f"<b>{NOME} {VERSAO}</b><br><br>Confere se links respondem OK (200): lista, rastreio de site e "
            "sitemap.<br><br>Código aberto (MIT): "
            "<a href='https://github.com/RicardoBiazin/validaurl'>github.com/RicardoBiazin/validaurl</a>"))

    # Usado pelos testes de interface
    def esperar(self, ms: int = 30000) -> bool:
        from PySide6.QtCore import QCoreApplication, QElapsedTimer
        relogio = QElapsedTimer()
        relogio.start()
        while (self.trabalho.rodando or self.temporizador.isActive()) and relogio.elapsed() < ms:
            QCoreApplication.processEvents()
            self.trabalho._thread and self.trabalho._thread.join(0.02)
        QCoreApplication.processEvents()
        return not self.trabalho.rodando

