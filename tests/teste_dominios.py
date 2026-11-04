"""Vencimento de domínios: situação, aviso só na piora, sugestões e consulta RDAP (offline)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from validaurl.dominios import (  # noqa: E402
    atualizar_avisos, dias_ate, situacao, sugestoes_registro, texto_aviso, verificar,
)

AGORA = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def em(dias: float) -> str:
    return (AGORA + timedelta(days=dias)).isoformat()


def item(dominio: str, dias: float | None, ultimo: str = "") -> dict:
    return {"dominio": dominio, "expira": em(dias) if dias is not None else None, "ultimo_aviso": ultimo}


class TesteSituacao(unittest.TestCase):
    def test_limites(self):
        self.assertEqual(dias_ate(em(10), AGORA), 10)
        self.assertEqual(situacao(-1), "vencido")
        self.assertEqual(situacao(0), "critico")
        self.assertEqual(situacao(15), "critico")
        self.assertEqual(situacao(16), "atencao")
        self.assertEqual(situacao(60), "atencao")
        self.assertEqual(situacao(61), "ok")
        self.assertEqual(situacao(None), "desconhecido")

    def test_data_invalida_e_sem_fuso(self):
        self.assertIsNone(dias_ate("nao-e-data", AGORA))
        self.assertEqual(dias_ate("2026-11-14T00:00:00", AGORA), 9)

    def test_sugestoes(self):
        self.assertEqual(sugestoes_registro("exemplo.com.br")[0][1], "https://registro.br/")
        nomes = [n for n, _ in sugestoes_registro("exemplo.com")]
        self.assertIn("Cloudflare Registrar", nomes)
        self.assertNotIn("Registro.br (lista de registradores credenciados)", nomes)


class TesteAvisos(unittest.TestCase):
    def test_avisa_so_na_piora(self):
        itens = [item("a.com.br", 40)]  # atenção
        self.assertEqual([i["dominio"] for i in atualizar_avisos(itens, AGORA)], ["a.com.br"])
        self.assertEqual(atualizar_avisos(itens, AGORA), [], "mesma situação não repete")
        itens[0]["expira"] = em(5)  # agora crítico: piorou
        self.assertEqual(len(atualizar_avisos(itens, AGORA)), 1)
        itens[0]["expira"] = em(-2)  # vencido: piorou de novo
        self.assertEqual(len(atualizar_avisos(itens, AGORA)), 1)
        self.assertEqual(atualizar_avisos(itens, AGORA), [])

    def test_renovado_zera_memoria(self):
        itens = [item("a.com", 5)]
        atualizar_avisos(itens, AGORA)
        itens[0]["expira"] = em(365)  # renovou
        self.assertEqual(atualizar_avisos(itens, AGORA), [])
        self.assertEqual(itens[0]["ultimo_aviso"], "ok")
        itens[0]["expira"] = em(20)  # voltou a ficar perto: avisa de novo
        self.assertEqual(len(atualizar_avisos(itens, AGORA)), 1)

    def test_sem_data_nao_avisa(self):
        self.assertEqual(atualizar_avisos([item("a.com", None)], AGORA), [])

    def test_texto_do_aviso(self):
        t = texto_aviso(item("exemplo.com.br", 3), AGORA)
        self.assertIn("exemplo.com.br", t)
        self.assertIn("vence em 3 dia(s)", t)
        self.assertIn("Registro.br", t)
        self.assertIn("venceu há 2 dia(s)", texto_aviso(item("x.com", -2), AGORA))


def _cliente(status: int, corpo: dict | None):
    def handler(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status)
        return httpx.Response(200, json=corpo)
    return httpx.Client(transport=httpx.MockTransport(handler))


RDAP = {"ldhName": "EXEMPLO.COM.BR", "status": ["active"],
        "events": [{"eventAction": "expiration", "eventDate": em(30)}],
        "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Registro X"]]]}]}


class TesteVerificar(unittest.TestCase):
    def test_consulta_rdap(self):
        with _cliente(200, RDAP) as cli:
            r = verificar("Exemplo.com.br", cli, AGORA)
        self.assertEqual(r["dominio"], "exemplo.com.br")
        self.assertEqual(r["registrador"], "Registro X")
        self.assertEqual(situacao(dias_ate(r["expira"], AGORA)), "atencao")
        self.assertEqual(r["erro"], "")

    def test_rdap_falhou(self):
        with _cliente(404, None) as cli:
            r = verificar("nao-existe.com.br", cli, AGORA)
        self.assertIsNone(r["expira"])
        self.assertIn("RDAP indisponível", r["erro"])

    def test_ip_nao_e_dominio(self):
        with _cliente(200, RDAP) as cli:
            with self.assertRaises(ValueError):
                verificar("8.8.8.8", cli, AGORA)


if __name__ == "__main__":
    unittest.main()
