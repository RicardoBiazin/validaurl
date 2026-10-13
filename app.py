"""Ponto de entrada do ValidaURL (desktop).

    python app.py                    abre a janela
    python app.py --autoverificacao  confere que o executável empacotado funciona (usado pelo build.bat)
"""

from __future__ import annotations

import os
import sys
import tempfile
import traceback
from pathlib import Path


def autoverificacao() -> int:
    """Sobe um servidor local, checa 2 URLs pelo núcleo e abre a janela fora da tela."""
    log = Path(tempfile.gettempdir()) / "validaurl_autoverificacao.log"
    try:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        pasta_cfg = tempfile.mkdtemp(prefix="validaurl_auto_")
        os.environ["VALIDAURL_CONFIG"] = os.path.join(pasta_cfg, "config.ini")
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        from PySide6.QtWidgets import QApplication

        from validaurl import VERSAO
        from validaurl.exportar import exportar
        from validaurl.lote import verificar_lote
        from validaurl.interface.janela import JanelaPrincipal

        class H(BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.send_response(200 if self.path == "/ok" else 404)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_HEAD

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        res = verificar_lote([base + "/ok", base + "/x"])
        srv.shutdown()
        assert [r.status for r in res] == [200, 404], [r.status for r in res]

        # O pacote de certificados precisa ter vindo junto (senão todo https falha).
        import ssl

        import certifi
        assert Path(certifi.where()).is_file(), certifi.where()
        ssl.create_default_context(cafile=certifi.where())

        with tempfile.TemporaryDirectory() as d:
            exportar(res, Path(d) / "r.xlsx")
            exportar(res, Path(d) / "r.csv")

        app = QApplication.instance() or QApplication(sys.argv)
        janela = JanelaPrincipal()
        janela.show()
        app.processEvents()
        janela.close()
        log.write_text(f"OK {VERSAO}\n", encoding="utf-8")
        return 0
    except Exception:  # noqa: BLE001
        log.write_text(traceback.format_exc(), encoding="utf-8")
        return 1


def _traduzir(app) -> None:
    """Botões padrão do Qt ("Salvar", "Cancelar"…) em português."""
    from PySide6.QtCore import QLibraryInfo, QLocale, QTranslator

    pastas = [QLibraryInfo.path(QLibraryInfo.TranslationsPath)]
    if hasattr(sys, "_MEIPASS"):
        pastas.insert(0, str(Path(sys._MEIPASS) / "PySide6" / "translations"))
    app._tradutores = []
    for nome in ("qtbase_pt_BR", "qt_pt_BR"):
        for pasta in pastas:
            t = QTranslator(app)
            if t.load(QLocale("pt_BR"), nome.rsplit("_pt_BR", 1)[0], "_", pasta) or t.load(nome, pasta):
                app.installTranslator(t)
                app._tradutores.append(t)
                break


def main() -> int:
    if "--autoverificacao" in sys.argv:
        return autoverificacao()

    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from validaurl import NOME
    from validaurl.interface.janela import JanelaPrincipal

    app = QApplication(sys.argv)
    app.setApplicationName(NOME)
    _traduzir(app)
    icone = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "recursos" / "validaurl.ico"
    if icone.exists():
        app.setWindowIcon(QIcon(str(icone)))
    janela = JanelaPrincipal()
    janela.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
