"""Diálogo de configuração dos avisos (notificação, e-mail SMTP e webhook)."""

from __future__ import annotations

import threading

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit,
    QMessageBox, QPushButton, QSpinBox, QVBoxLayout,
)

from ..avisos import ConfigAvisos, ConfigEmail, Mudancas, enviar_email, enviar_webhook, payload_webhook
from ..verificador import Resultado

SEGURANCAS = [("STARTTLS (porta 587)", "starttls"), ("SSL/TLS (porta 465)", "ssl"), ("Nenhuma (porta 25)", "nenhuma")]


class _Retorno(QObject):
    pronto = Signal(str, str)  # titulo, mensagem


class DialogoAvisos(QDialog):
    def __init__(self, cfg: ConfigAvisos, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Avisos do monitoramento")
        self.setMinimumWidth(520)
        self._retorno = _Retorno(self)
        self._retorno.pronto.connect(self._mostrar_teste)
        raiz = QVBoxLayout(self)

        raiz.addWidget(QLabel("Os avisos saem quando uma URL <b>passa a falhar</b> ou <b>volta ao normal</b> "
                              "numa checagem repetida (opção “Repetir a cada”)."))
        self.ck_notif = QCheckBox("Notificação do Windows (ícone na bandeja)")
        self.ck_notif.setChecked(cfg.notificacao)
        raiz.addWidget(self.ck_notif)
        self.ck_repetir = QCheckBox("Avisar em toda checagem enquanto houver problema (não só na mudança)")
        self.ck_repetir.setChecked(cfg.repetir_problemas)
        raiz.addWidget(self.ck_repetir)
        self.ck_recup = QCheckBox("Avisar quando voltar ao normal")
        self.ck_recup.setChecked(cfg.avisar_recuperacao)
        raiz.addWidget(self.ck_recup)

        grupo = QGroupBox("Webhook (Slack, Discord, Teams, Google Chat, n8n, Zapier…)")
        lay = QHBoxLayout(grupo)
        self.ed_webhook = QLineEdit(cfg.webhook)
        self.ed_webhook.setPlaceholderText("https://chat.googleapis.com/v1/spaces/…  (vazio = desligado)")
        self.ed_webhook.setToolTip("Google Chat: no espaço, Apps e integrações → Webhooks → Adicionar webhook.\n"
                                   "Também serve Slack, Discord, Teams (Power Automate), n8n, Zapier.")
        lay.addWidget(self.ed_webhook, 1)
        bt = QPushButton("Testar")
        bt.clicked.connect(self._testar_webhook)
        lay.addWidget(bt)
        raiz.addWidget(grupo)

        e = cfg.email
        grupo = QGroupBox("E-mail (SMTP)")
        grupo.setCheckable(True)
        grupo.setChecked(e.ativo)
        self.grupo_email = grupo
        form = QFormLayout(grupo)
        self.ed_servidor = QLineEdit(e.servidor)
        self.ed_servidor.setPlaceholderText("smtp.gmail.com")
        self.sp_porta = QSpinBox()
        self.sp_porta.setRange(1, 65535)
        self.sp_porta.setValue(e.porta)
        self.cb_seg = QComboBox()
        for rotulo, valor in SEGURANCAS:
            self.cb_seg.addItem(rotulo, valor)
        indice = self.cb_seg.findData(e.seguranca)
        self.cb_seg.setCurrentIndex(indice if indice >= 0 else 0)
        self.cb_seg.currentIndexChanged.connect(self._porta_padrao)
        linha = QHBoxLayout()
        linha.addWidget(self.ed_servidor, 1)
        linha.addWidget(QLabel("Porta:"))
        linha.addWidget(self.sp_porta)
        form.addRow("Servidor:", linha)
        form.addRow("Segurança:", self.cb_seg)
        self.ed_usuario = QLineEdit(e.usuario)
        form.addRow("Usuário:", self.ed_usuario)
        self.ed_senha = QLineEdit(e.senha)
        self.ed_senha.setEchoMode(QLineEdit.Password)
        self.ed_senha.setPlaceholderText("No Gmail/Outlook, use uma “senha de app”")
        form.addRow("Senha:", self.ed_senha)
        self.ed_remetente = QLineEdit(e.remetente)
        self.ed_remetente.setPlaceholderText("(vazio = o usuário)")
        form.addRow("Remetente:", self.ed_remetente)
        self.ed_destinos = QLineEdit(e.destinatarios)
        self.ed_destinos.setPlaceholderText("voce@empresa.com, outro@empresa.com")
        form.addRow("Enviar para:", self.ed_destinos)
        bt = QPushButton("Enviar e-mail de teste")
        bt.clicked.connect(self._testar_email)
        form.addRow("", bt)
        form.addRow(QLabel("A senha fica gravada cifrada pela proteção de dados do Windows (DPAPI)."))
        raiz.addWidget(grupo)

        botoes = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        botoes.accepted.connect(self.accept)
        botoes.rejected.connect(self.reject)
        raiz.addWidget(botoes)

    def _porta_padrao(self):
        self.sp_porta.setValue({"starttls": 587, "ssl": 465, "nenhuma": 25}[self.cb_seg.currentData()])

    def config(self) -> ConfigAvisos:
        return ConfigAvisos(
            notificacao=self.ck_notif.isChecked(),
            webhook=self.ed_webhook.text().strip(),
            repetir_problemas=self.ck_repetir.isChecked(),
            avisar_recuperacao=self.ck_recup.isChecked(),
            email=ConfigEmail(
                ativo=self.grupo_email.isChecked(), servidor=self.ed_servidor.text().strip(),
                porta=self.sp_porta.value(), seguranca=self.cb_seg.currentData(),
                usuario=self.ed_usuario.text().strip(), senha=self.ed_senha.text(),
                remetente=self.ed_remetente.text().strip(), destinatarios=self.ed_destinos.text().strip()),
        )

    # --- testes (em thread: SMTP e webhook podem demorar) ---------------------
    def _em_segundo_plano(self, titulo: str, funcao):
        def rodar():
            try:
                funcao()
                self._retorno.pronto.emit(titulo, "Enviado com sucesso.")
            except Exception as exc:  # noqa: BLE001
                self._retorno.pronto.emit(titulo, f"Falhou:\n{exc}")
        threading.Thread(target=rodar, daemon=True).start()

    def _mostrar_teste(self, titulo: str, msg: str):
        QMessageBox.information(self, titulo, msg)

    def _testar_email(self):
        cfg = self.config().email
        self._em_segundo_plano("Teste de e-mail", lambda: enviar_email(
            cfg, "[ValidaURL] Teste de aviso", "Se você recebeu isto, os avisos por e-mail estão funcionando."))

    def _testar_webhook(self):
        url = self.ed_webhook.text().strip()
        if not url:
            return
        exemplo = Resultado(url="https://exemplo.com/pagina-quebrada", status=404, categoria="Erro 4xx",
                            erro="Not Found")
        m = Mudancas([exemplo], [], [], 1)
        dados = payload_webhook(m, "teste", "[ValidaURL] Teste de webhook", "Mensagem de teste do ValidaURL.")
        self._em_segundo_plano("Teste de webhook", lambda: enviar_webhook(url, dados))
