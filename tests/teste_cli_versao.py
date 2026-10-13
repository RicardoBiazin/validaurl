"""Linha de comando, autoverificação e consistência da versão."""

import io
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

from servidor_teste import Servidor  # noqa: E402

from validaurl import VERSAO  # noqa: E402
from validaurl.__main__ import main  # noqa: E402


class TesteCLI(unittest.TestCase):
    def rodar(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            codigo = main(list(args))
        return codigo, out.getvalue(), err.getvalue()

    def test_lista_e_saida(self):
        with Servidor() as srv:
            codigo, out, err = self.rodar(srv.url("/ok"), srv.url("/nada"), "--timeout", "3")
            self.assertEqual(codigo, 1)
            self.assertIn("404", out)
            self.assertIn("2 checadas, 1 com problema", err)
            codigo, out, _ = self.rodar(srv.url("/ok"), "--so-problemas")
            self.assertEqual((codigo, out.strip()), (0, ""))

    def test_sitemap(self):
        with Servidor() as srv:
            codigo, out, _ = self.rodar("--sitemap", srv.url("/sitemap.xml"))
        self.assertEqual(codigo, 1)
        self.assertEqual(len(out.strip().splitlines()), 3)


class TesteVersao(unittest.TestCase):
    def test_versao_consistente(self):
        self.assertRegex(VERSAO, r"^\d+\.\d+\.\d+$")
        tupla = "(" + ", ".join(VERSAO.split(".")) + ", 0)"
        versao_txt = (RAIZ / "versao.txt").read_text(encoding="utf-8")
        self.assertEqual(versao_txt.count(tupla), 2, "filevers/prodvers")
        self.assertEqual(len(re.findall(rf"'{re.escape(VERSAO)}'", versao_txt)), 2, "FileVersion/ProductVersion")
        manifesto = (RAIZ / "ValidaURL.manifest").read_text(encoding="utf-8")
        self.assertIn(f'version="{VERSAO}.0"', manifesto)
        pacote = (RAIZ / "web" / "package.json")
        if pacote.exists():
            self.assertIn(f'"version": "{VERSAO}"', pacote.read_text(encoding="utf-8"))

    def test_autoverificacao(self):
        import app
        self.assertEqual(app.autoverificacao(), 0)


if __name__ == "__main__":
    unittest.main()
