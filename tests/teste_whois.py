"""WHOIS (RDAP), DNS e geolocalização: tudo offline, com transporte falso do httpx."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from validaurl.whois import classificar_alvo, consultar, dados_doh, resumo_rdap_dominio  # noqa: E402

RDAP_DOMINIO = {
    "ldhName": "EXEMPLO.COM.BR",
    "status": ["client transfer prohibited"],
    "events": [
        {"eventAction": "registration", "eventDate": "2001-03-01T00:00:00Z"},
        {"eventAction": "expiration", "eventDate": "2030-03-01T00:00:00Z"},
        {"eventAction": "last changed", "eventDate": "2026-01-10T00:00:00Z"},
    ],
    "nameservers": [{"ldhName": "NS1.EXEMPLO.NET"}, {"ldhName": "ns2.exemplo.net"}],
    "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Registro Exemplo Ltda"]]]}],
}
RDAP_IP = {"name": "GOOGLE", "country": "US", "startAddress": "8.8.8.0", "endAddress": "8.8.8.255",
           "entities": [{"roles": ["registrant"], "vcardArray": ["vcard", [["fn", {}, "text", "Google LLC"]]]}]}
GEO_OK = {"status": "success", "country": "Brasil", "regionName": "São Paulo", "city": "São Paulo",
          "lat": -23.55, "lon": -46.63, "isp": "Provedor X", "org": "", "as": "AS1 Teste"}


def _transporte(seq_dns: dict[tuple[str, str], list[dict]]):
    """Respostas fixas por (nome, tipo) do DNS; RDAP e geolocalização por host."""
    def handler(request: httpx.Request) -> httpx.Response:
        host, caminho = request.url.host, request.url.path
        if host == "rdap.org" and caminho.startswith("/domain/exemplo.com.br"):
            return httpx.Response(200, json=RDAP_DOMINIO)
        if host == "rdap.org" and caminho.startswith("/ip/8.8.8.8"):
            return httpx.Response(200, json=RDAP_IP)
        if host == "rdap.org":
            return httpx.Response(404)
        if host == "cloudflare-dns.com":
            chave = (request.url.params["name"], request.url.params["type"])
            return httpx.Response(200, json={"Answer": seq_dns.get(chave, [])})
        if host == "ip-api.com":
            return httpx.Response(200, json=GEO_OK)
        return httpx.Response(500)
    return httpx.Client(transport=httpx.MockTransport(handler))


class TesteClassificar(unittest.TestCase):
    def test_dominio_e_ip(self):
        self.assertEqual(classificar_alvo("Exemplo.com.br"), ("dominio", "exemplo.com.br"))
        self.assertEqual(classificar_alvo("https://exemplo.com.br/pagina?x=1"), ("dominio", "exemplo.com.br"))
        self.assertEqual(classificar_alvo("8.8.8.8"), ("ip", "8.8.8.8"))
        self.assertEqual(classificar_alvo("  2001:4860:4860::8888 "), ("ip", "2001:4860:4860::8888"))

    def test_recusa(self):
        for ruim in ("", "   ", "localhost", "192.168.0.1", "127.0.0.1", "10.1.2.3", "nao é dominio", "a..b"):
            with self.assertRaises(ValueError, msg=ruim):
                classificar_alvo(ruim)


class TesteParsers(unittest.TestCase):
    def test_doh_filtra_tipo(self):
        resp = {"Answer": [{"type": 1, "data": "93.184.216.34"}, {"type": 5, "data": "cname.x."},
                           {"type": 16, "data": '"v=spf1 -all" "extra"'}]}
        self.assertEqual(dados_doh(resp, "A"), ["93.184.216.34"])
        self.assertEqual(dados_doh(resp, "TXT"), ["v=spf1 -all" + "extra"])
        self.assertEqual(dados_doh({}, "MX"), [])

    def test_rdap_dominio(self):
        r = resumo_rdap_dominio(RDAP_DOMINIO)
        self.assertEqual(r["dominio"], "EXEMPLO.COM.BR")
        self.assertEqual(r["registrador"], "Registro Exemplo Ltda")
        self.assertEqual(r["expira"], "2030-03-01T00:00:00Z")
        self.assertEqual(r["nameservers"], ["ns1.exemplo.net", "ns2.exemplo.net"])


class TesteConsulta(unittest.TestCase):
    def test_dominio_completo(self):
        dns = {("exemplo.com.br", "A"): [{"type": 1, "data": "8.8.8.8"}],
               ("exemplo.com.br", "MX"): [{"type": 15, "data": "10 mx.exemplo.com.br."}],
               ("8.8.8.8.in-addr.arpa", "PTR"): [{"type": 12, "data": "dns.google."}]}
        with _transporte(dns) as cli:
            rel = consultar("exemplo.com.br", cli)
        self.assertEqual(rel.tipo, "dominio")
        self.assertEqual(rel.dominio["registrador"], "Registro Exemplo Ltda")
        self.assertEqual(rel.dns["MX"], ["10 mx.exemplo.com.br."])
        self.assertEqual(rel.dns["AAAA"], [])
        self.assertEqual(len(rel.enderecos), 1)
        end = rel.enderecos[0]
        self.assertEqual((end["ip"], end["ptr"]), ("8.8.8.8", "dns.google"))
        self.assertEqual(end["geo"]["city"], "São Paulo")
        self.assertEqual(rel.avisos, [])

    def test_dominio_sem_rdap_e_sem_registro(self):
        with _transporte({}) as cli:
            rel = consultar("nao-existe.com.br", cli)
        self.assertIsNone(rel.dominio)
        self.assertTrue(any("RDAP" in a for a in rel.avisos))
        self.assertTrue(any("Nenhum endereço" in a for a in rel.avisos))

    def test_ip(self):
        with _transporte({}) as cli:
            rel = consultar("8.8.8.8", cli)
        self.assertEqual(rel.tipo, "ip")
        self.assertEqual(rel.ip["organizacao"], "Google LLC")
        self.assertEqual(rel.ip["faixa"], "8.8.8.0 – 8.8.8.255")
        self.assertEqual(rel.enderecos[0]["geo"]["lat"], -23.55)
        self.assertEqual(rel.enderecos[0]["ptr"], "")

    def test_ip_interno_nao_consulta(self):
        with _transporte({}) as cli:
            with self.assertRaises(ValueError):
                consultar("192.168.1.1", cli)


if __name__ == "__main__":
    unittest.main()
