"""Monitoramento: comparação entre checagens, e-mail, webhook e a senha cifrada."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from servidor_teste import Manipulador, Servidor, SMTPFalso  # noqa: E402

from validaurl import segredos  # noqa: E402
from validaurl.avisos import (  # noqa: E402
    ConfigAvisos, adaptar_ao_destino, ConfigEmail, comparar, disparar, enviar_email, montar_texto, payload_webhook,
)
from validaurl.verificador import Resultado  # noqa: E402


def R(url, status, cat):
    return Resultado(url=url, status=status, categoria=cat)


class TesteComparar(unittest.TestCase):
    def test_mudancas(self):
        antes = [R("https://a.com", 200, "OK"), R("https://b.com", 404, "Erro 4xx"), R("https://c.com", 500, "Erro 5xx")]
        agora = [R("https://a.com/", 404, "Erro 4xx"), R("https://b.com", 200, "OK"), R("https://c.com", 500, "Erro 5xx"),
                 R("https://d.com", None, "Falha")]
        m = comparar(antes, agora)
        self.assertEqual([r.url for r in m.novos_problemas], ["https://a.com/", "https://d.com"])
        self.assertEqual([r.url for r in m.recuperados], ["https://b.com"])
        self.assertEqual([r.url for r in m.ainda_com_problema], ["https://c.com"])
        self.assertFalse(m.vazio())

    def test_primeira_checagem_e_sem_mudanca(self):
        atuais = [R("https://a.com", 200, "OK"), R("https://b.com", 404, "Erro 4xx")]
        self.assertEqual(len(comparar(None, atuais).novos_problemas), 1)
        m = comparar(atuais, atuais)
        self.assertTrue(m.vazio())
        self.assertFalse(m.vazio(repetir_problemas=True))
        ok = [R("https://a.com", 200, "OK")]
        self.assertTrue(comparar(None, ok).vazio())

    def test_texto(self):
        m = comparar(None, [R("https://b.com", 404, "Erro 4xx")])
        assunto, corpo = montar_texto(m, "site.com")
        self.assertIn("1 link(s) com problema em site.com", assunto)
        self.assertIn("[404] https://b.com", corpo)
        dados = payload_webhook(m, "site.com", assunto, corpo)
        self.assertIn("text", dados)
        self.assertIn("content", dados)
        self.assertEqual(dados["novos_problemas"][0]["status"], 404)


class TesteFormatoWebhook(unittest.TestCase):
    def test_por_servico(self):
        m = comparar(None, [R("https://b.com", 404, "Erro 4xx")])
        assunto, corpo = montar_texto(m, "site.com")
        dados = payload_webhook(m, "site.com", assunto, corpo)
        google = adaptar_ao_destino("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t", dados)
        self.assertEqual(list(google), ["text"])  # Google Chat recusa campo desconhecido
        self.assertTrue(google["text"].startswith(f"*{assunto}*\n"))
        self.assertIn("[404] https://b.com", google["text"])
        self.assertEqual(list(adaptar_ao_destino("https://discord.com/api/webhooks/1/x", dados)), ["content"])
        self.assertEqual(list(adaptar_ao_destino("https://hooks.slack.com/services/x", dados)), ["text"])
        self.assertIs(adaptar_ao_destino("https://n8n.empresa.com/webhook/x", dados), dados)
        longo = dict(dados, text="t\n" + "x" * 9000)
        self.assertLessEqual(len(adaptar_ao_destino("https://chat.googleapis.com/v1/spaces/A/messages", longo)["text"]), 4000)

class TesteEnvio(unittest.TestCase):
    def test_webhook_e_email(self):
        smtp = SMTPFalso()
        try:
            with Servidor() as srv:
                Manipulador.webhooks.clear()
                cfg = ConfigAvisos(webhook=srv.url("/webhook"), email=ConfigEmail(
                    ativo=True, servidor="127.0.0.1", porta=smtp.porta, seguranca="nenhuma",
                    usuario="eu", senha="x", destinatarios="a@b.com; c@d.com"))
                m = comparar(None, [R("https://b.com", 404, "Erro 4xx")])
                self.assertEqual(disparar(cfg, m, "site.com"), [])
                self.assertEqual(len(Manipulador.webhooks), 1)
                self.assertEqual(Manipulador.webhooks[0]["alvo"], "site.com")
                self.assertEqual(len(smtp.mensagens), 1)
                self.assertIn("To: a@b.com, c@d.com", smtp.mensagens[0])
                # sem mudança: nada sai
                self.assertEqual(disparar(cfg, comparar(m.novos_problemas, m.novos_problemas), "x"), [])
                self.assertEqual(len(Manipulador.webhooks), 1)
                # webhook quebrado vira erro, sem exceção
                cfg.webhook = srv.url("/webhook-quebrado")
                cfg.email.ativo = False
                erros = disparar(cfg, m, "site.com")
                self.assertEqual(len(erros), 1)
                self.assertIn("500", erros[0])
        finally:
            smtp.fechar()

    def test_email_sem_destino(self):
        with self.assertRaises(ValueError):
            enviar_email(ConfigEmail(servidor="x"), "a", "b")


class TesteSegredos(unittest.TestCase):
    def test_ida_e_volta(self):
        cifrado = segredos.proteger("senha secreta")
        if sys.platform == "win32":
            self.assertTrue(cifrado.startswith("dpapi:"))
            self.assertNotIn("secreta", cifrado)
        self.assertEqual(segredos.revelar(cifrado), "senha secreta")
        self.assertEqual(segredos.revelar("dpapi:lixo"), "")
        self.assertEqual(segredos.revelar(""), "")

    def test_config_serializada(self):
        cfg = ConfigAvisos(webhook="https://w", email=ConfigEmail(ativo=True, senha="s3nha", porta=465))
        d = cfg.como_dict(segredos.proteger)
        self.assertNotEqual(d["email"]["senha"], "s3nha")
        volta = ConfigAvisos.de_dict(d, segredos.revelar)
        self.assertEqual(volta, cfg)
        self.assertEqual(ConfigAvisos.de_dict({"campo_novo": 1}), ConfigAvisos())


if __name__ == "__main__":
    unittest.main()
