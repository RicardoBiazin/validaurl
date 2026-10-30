"""Janela PySide6 em modo offscreen, contra o servidor local."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import Qt, QSettings  # noqa: E402
from PySide6.QtWidgets import QApplication, QLabel, QMessageBox  # noqa: E402

from servidor_teste import Manipulador, Servidor  # noqa: E402

from validaurl import VERSAO  # noqa: E402
from validaurl import classificar as C  # noqa: E402
from validaurl.avisos import ConfigAvisos  # noqa: E402
from validaurl.interface.janela import ABA_LISTA, ABA_RASTREIO, ABA_SITEMAP, JanelaPrincipal  # noqa: E402
from validaurl.interface.modelo import FILTRO_PROBLEMAS  # noqa: E402

APP = QApplication.instance() or QApplication(sys.argv)


class TesteJanela(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._pasta_cfg = tempfile.TemporaryDirectory()
        cls._cfg_antes = os.environ.get("VALIDAURL_CONFIG")
        os.environ["VALIDAURL_CONFIG"] = os.path.join(cls._pasta_cfg.name, "config.ini")
        cls.srv = Servidor().__enter__()
        cls.mensagens = []
        for nome in ("information", "warning"):
            p = mock.patch.object(QMessageBox, nome, side_effect=lambda *a, **k: cls.mensagens.append(a[2]))
            p.start()
            cls.addClassCleanup(p.stop)

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__()
        if cls._cfg_antes is None:
            os.environ.pop("VALIDAURL_CONFIG", None)
        else:
            os.environ["VALIDAURL_CONFIG"] = cls._cfg_antes
        cls._pasta_cfg.cleanup()

    def test_nao_toca_no_registro(self):
        self.assertEqual(self.j.config.format(), QSettings.IniFormat)
        self.assertEqual(Path(self.j.config.fileName()).resolve().parent, Path(self._pasta_cfg.name).resolve())

    def setUp(self):
        self.mensagens.clear()
        self.j = JanelaPrincipal()
        self.j.sp_timeout.setValue(3)

    def tearDown(self):
        self.j.ck_monitor.setChecked(False)
        self.j.close()

    def test_titulo_versao(self):
        self.assertIn(VERSAO, self.j.windowTitle())

    def test_lista_filtro_rechecar(self):
        self.j.abas.setCurrentIndex(ABA_LISTA)
        self.j.txt_lista.setPlainText("\n".join(self.srv.url(p) for p in ("/ok", "/nada", "/redir", "/500")))
        self.assertEqual(self.j.lbl_qtd.text(), "4 URLs")
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        m = self.j.modelo
        self.assertEqual(len(m.resultados), 4)
        self.assertEqual(m.contagem(), {C.OK: 1, C.ERRO_CLIENTE: 1, C.REDIRECIONADO: 1, C.ERRO_SERVIDOR: 1})
        self.assertIn("Erro 4xx: 1", self.j.lbl_resumo.text())
        self.j.cb_filtro.setCurrentText(FILTRO_PROBLEMAS)
        self.assertEqual(self.j.filtro.rowCount(), 2)
        self.j.ed_busca.setText("500")
        self.assertEqual(self.j.filtro.rowCount(), 1)
        self.assertTrue(self.j.bt_rechecar.isEnabled())
        self.j.rechecar()
        self.assertTrue(self.j.esperar())
        self.assertEqual(len(m.resultados), 4)  # substituiu, não duplicou
        self.assertTrue(self.j.bt_exportar.isEnabled())

    def test_descricao_em_cada_aba(self):
        # Cada aba explica o que faz logo no topo.
        self.assertEqual(self.j.abas.count(), 4)
        for i in range(self.j.abas.count()):
            textos = [lbl.text() for lbl in self.j.abas.widget(i).findChildren(QLabel)]
            self.assertTrue(any(len(t) > 60 for t in textos), f"aba {self.j.abas.tabText(i)} sem descrição")

    def test_whois_mostra_resultado_e_escapa(self):
        from validaurl.whois import Relatorio
        rel = Relatorio("ip", "8.8.8.8",
                        ip={"nome": "GOOGLE", "pais": "US", "faixa": "8.8.8.0 – 8.8.8.255", "organizacao": "Google LLC"},
                        enderecos=[{"ip": "8.8.8.8", "ptr": "dns.google",
                                    "geo": {"country": "Brasil", "regionName": "SP", "city": "São Paulo",
                                            "lat": -23.5, "lon": -46.6, "isp": "X", "as": "AS1"}}],
                        avisos=["<script>alerta()</script>"])
        self.j._mostrar_whois(rel, "")
        self.assertEqual(self.j.cb_ip_whois.count(), 1)
        self.assertTrue(self.j.bt_mapa_whois.isEnabled())
        texto = self.j.txt_whois.toPlainText()
        self.assertIn("São Paulo", texto)
        self.assertIn("Google LLC", texto)
        self.assertIn("<script>alerta()</script>", texto, "texto vindo da rede aparece como texto")
        self.assertNotIn("<script>", self.j.txt_whois.toHtml().lower())
        self.j._mostrar_whois(None, "timeout")
        self.assertIn("timeout", self.j.txt_whois.toPlainText())
        self.assertTrue(self.j.bt_whois.isEnabled())

    def test_coluna_tipo(self):
        from validaurl.interface.modelo import COL_TIPO, COLUNAS
        self.assertEqual(COLUNAS[COL_TIPO], "Tipo")
        self.j.txt_lista.setPlainText(self.srv.url("/ok"))
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        m = self.j.modelo
        self.assertEqual(m.data(m.index(0, COL_TIPO)), "HTML")
        self.assertIn("text/html", m.data(m.index(0, COL_TIPO), Qt.ToolTipRole))
        # Filtro por tipo: a lista traz só os tipos que apareceram e o filtro esconde o resto.
        self.assertGreaterEqual(self.j.cb_tipo.findText("HTML"), 0)
        self.assertEqual(self.j.cb_tipo.findText("PDF"), -1, "PDF não apareceu nesta lista")
        self.j.cb_tipo.setCurrentText("HTML")
        self.assertEqual(self.j.filtro.rowCount(), 1)
        self.j.cb_tipo.setCurrentText("Todos os tipos")
        self.assertEqual(self.j.filtro.rowCount(), 1)

    def test_exportar_so_visiveis(self):
        self.j.txt_lista.setPlainText(f"{self.srv.url('/ok')}\n{self.srv.url('/nada')}")
        self.j.iniciar()
        self.j.esperar()
        self.j.cb_filtro.setCurrentText(FILTRO_PROBLEMAS)
        with tempfile.TemporaryDirectory() as d:
            alvo = str(Path(d) / "x.csv")
            with mock.patch("validaurl.interface.janela.QFileDialog.getSaveFileName", return_value=(alvo, "")):
                self.j.exportar()
            linhas = Path(alvo).read_text(encoding="utf-8-sig").strip().splitlines()
        self.assertEqual(len(linhas), 2)
        self.assertIn("/nada", linhas[1])

    def test_rastreio(self):
        self.j.abas.setCurrentIndex(ABA_RASTREIO)
        self.j.ed_site.setPlainText(self.srv.url("/site/"))
        self.j.ck_externos.setChecked(False)
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        urls = {r.url for r in self.j.modelo.resultados}
        self.assertIn(self.srv.url("/site/c"), urls)
        self.assertEqual(self.j.lbl_fase.text(), "Concluído")

    def test_sitemap_e_erro(self):
        self.j.abas.setCurrentIndex(ABA_SITEMAP)
        self.j.ed_sitemap.setText(self.srv.url("/sitemap.xml"))
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        self.assertEqual(len(self.j.modelo.resultados), 3)
        self.j.ed_sitemap.setText(self.srv.url("/sitemap-nao-tem.xml"))
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        self.assertTrue(any("sitemap" in m for m in self.mensagens))

    def test_entrada_vazia(self):
        self.j.abas.setCurrentIndex(ABA_LISTA)
        self.j.txt_lista.setPlainText("nada aqui")
        self.j.iniciar()
        self.assertFalse(self.j.trabalho.rodando)
        self.assertTrue(self.mensagens)

    def test_cancelar(self):
        self.j.txt_lista.setPlainText("\n".join(self.srv.url(f"/lento?{i}") for i in range(30)))
        self.j.sp_host.setValue(1)
        self.j.iniciar()
        self.j.cancelar()
        self.assertTrue(self.j.esperar(15000))
        self.assertEqual(self.j.lbl_fase.text(), "Cancelado")
        self.assertLess(len(self.j.modelo.resultados), 30)

    def test_monitoramento(self):
        Manipulador.webhooks.clear()
        self.j.cfg_avisos = ConfigAvisos(notificacao=False, webhook=self.srv.url("/webhook"))
        self.j.abas.setCurrentIndex(ABA_LISTA)
        self.j.txt_lista.setPlainText(f"{self.srv.url('/ok')}\n{self.srv.url('/nada')}")
        self.j.ck_monitor.setChecked(True)
        self.j.sp_minutos.setValue(5)
        self.j.iniciar()
        self.assertTrue(self.j.esperar())
        self.assertIsNotNone(self.j._proxima)
        self.assertIn("Próxima checagem", self.j.lbl_proxima.text())
        self._esperar_webhooks(1)
        self.assertEqual(len(Manipulador.webhooks[0]["novos_problemas"]), 1)
        # 2º ciclo (forçado) sem mudança: não avisa de novo; nenhum diálogo modal
        from datetime import datetime, timedelta
        self.j._proxima = datetime.now() - timedelta(seconds=1)
        self.j._tique_monitor()
        self.assertTrue(self.j.trabalho.rodando or self.j.temporizador.isActive())
        self.assertTrue(self.j.esperar())
        self.assertTrue(self.j._automatico)
        self.assertEqual(len(Manipulador.webhooks), 1)
        self.assertIsNotNone(self.j._proxima)
        # Esc parado: desliga o monitoramento
        self.j.cancelar()
        self.assertFalse(self.j.ck_monitor.isChecked())
        self.assertIsNone(self.j._proxima)
        self.assertEqual(self.mensagens, [])

    def test_salvar_lista_e_lembrar(self):
        self.j.txt_lista.setPlainText("https://a.com\nlixo\nwww.b.com.br/x\n")
        with tempfile.TemporaryDirectory() as d:
            for nome, esperado in (("l.txt", "https://a.com\nhttps://www.b.com.br/x\n"),
                                   ("l.csv", "URL\nhttps://a.com\nhttps://www.b.com.br/x\n")):
                alvo = str(Path(d) / nome)
                with mock.patch("validaurl.interface.janela.QFileDialog.getSaveFileName", return_value=(alvo, "")):
                    self.j.salvar_lista()
                self.assertEqual(Path(alvo).read_text(encoding="utf-8-sig"), esperado)
        self.j.close()  # grava a configuração
        outra = JanelaPrincipal()
        try:
            self.assertIn("www.b.com.br/x", outra.txt_lista.toPlainText())
            self.assertGreaterEqual(outra.divisor.count(), 2)
        finally:
            outra.close()

    def test_autosalva_sem_fechar(self):
        # Simula o processo morrendo: outra janela lê a config SEM esta ter fechado.
        self.j.txt_lista.setPlainText("https://autosalvo.com.br/x")
        self.assertTrue(self.j.autosalvar.isActive())
        from PySide6.QtCore import QElapsedTimer
        relogio = QElapsedTimer()
        relogio.start()
        while self.j.autosalvar.isActive() and relogio.elapsed() < 5000:
            APP.processEvents()
        outra = JanelaPrincipal()
        try:
            self.assertIn("autosalvo.com.br", outra.txt_lista.toPlainText())
            self.assertFalse(outra.autosalvar.isActive(), "carregar a config não dispara gravação")
        finally:
            outra.close()

    def test_lista_vazia_nao_salva(self):
        self.j.txt_lista.setPlainText("")
        with mock.patch("validaurl.interface.janela.QFileDialog.getSaveFileName") as dlg:
            self.j.salvar_lista()
        dlg.assert_not_called()
        self.assertTrue(self.mensagens)

    def _esperar_webhooks(self, n, ms=5000):
        from PySide6.QtCore import QElapsedTimer
        relogio = QElapsedTimer()
        relogio.start()
        while len(Manipulador.webhooks) < n and relogio.elapsed() < ms:
            APP.processEvents()
        self.assertEqual(len(Manipulador.webhooks), n)


if __name__ == "__main__":
    unittest.main()
