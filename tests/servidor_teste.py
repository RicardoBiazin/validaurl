"""Servidor HTTP local para a suíte: nenhum teste depende da internet."""

from __future__ import annotations

import gzip
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _html(corpo: str) -> bytes:
    return f"<!doctype html><html><head><title>t</title></head><body>{corpo}</body></html>".encode()


class Manipulador(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    contagem: dict[str, int] = {}
    webhooks: list[dict] = []

    def log_message(self, *a):  # silêncio
        pass

    def _enviar(self, status: int, corpo: bytes = b"", tipo: str = "text/html; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corpo)

    def _redir(self, status: int, para: str):
        self._enviar(status, b"", extra={"Location": para})

    def do_HEAD(self):
        self._rota()

    def do_POST(self):
        import json
        corpo = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/webhook":
            Manipulador.webhooks.append(json.loads(corpo))
            return self._enviar(204)
        if self.path == "/webhook-quebrado":
            return self._enviar(500, b"erro")
        return self._enviar(404)

    def do_GET(self):
        self._rota()

    def _rota(self):
        p = self.path.split("?")[0]
        base = f"http://{self.headers['Host']}"
        Manipulador.contagem[p] = Manipulador.contagem.get(p, 0) + 1
        if p == "/ok":
            return self._enviar(200, _html("ok"))
        if p == "/redir":
            return self._redir(301, "/ok")
        if p == "/para-fora":
            # Outro nome de host (localhost): para o rastreio, é outro site.
            return self._redir(302, f"http://localhost:{self.server.server_address[1]}/ok")
        if p == "/redir2":
            return self._redir(302, f"{base}/redir")
        if p == "/redir-404":
            return self._redir(301, "/nao-existe")
        if p == "/loop":
            return self._redir(302, "/loop2")
        if p == "/loop2":
            return self._redir(302, "/loop")
        if p == "/500":
            return self._enviar(500, _html("erro"))
        if p == "/head405":
            if self.command == "HEAD":
                return self._enviar(405)
            return self._enviar(200, _html("so get"))
        if p == "/head-mente":
            if self.command == "HEAD":
                return self._enviar(404)
            return self._enviar(200, _html("get ok"))
        if p == "/lento":
            time.sleep(3)
            return self._enviar(200, _html("lento"))
        if p == "/robots.txt":
            return self._enviar(200, f"User-agent: *\nDisallow: /site/privado\nSitemap: {base}/sitemap_index.xml\n".encode(),
                                "text/plain")
        # --- site para o rastreio ---
        if p == "/site/":
            return self._enviar(200, _html(
                '<a href="a">A</a> <a href="/site/b#topo">B</a> <a href="mailto:x@y.z">mail</a>'
                '<img src="/img.png"> <a href="/site/privado">priv</a>'
                f'<a href="http://127.0.0.2:1/fora">externo</a> <a href="javascript:void(0)">js</a>'))
        if p == "/site/a":
            return self._enviar(200, _html('<a href="/site/b">B</a> <a href="/site/c">C quebrado</a>'
                                           '<a href="/site/fundo/1">fundo</a>'))
        if p == "/site/b":
            return self._enviar(200, _html('<a href="/site/">volta</a> <a href="/500">erro</a>'))
        if p == "/site/fundo/1":
            return self._enviar(200, _html('<a href="/site/fundo/2">2</a>'))
        if p == "/site/fundo/2":
            return self._enviar(200, _html('<a href="/site/fundo/3">3</a>'))
        if p == "/site/fundo/3":
            return self._enviar(200, _html("fim"))
        if p == "/site/privado":
            return self._enviar(200, _html('<a href="/site/so-pelo-privado">x</a>'))
        if p == "/img.png":
            return self._enviar(200, b"\x89PNG....", "image/png")
        # --- sitemaps ---
        if p == "/sitemap.xml":
            return self._enviar(200, (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                f'<url><loc>{base}/ok</loc></url><url><loc>{base}/500</loc></url>'
                f'<url><loc> {base}/redir </loc></url></urlset>').encode(), "application/xml")
        if p == "/sitemap_index.xml":
            return self._enviar(200, (
                '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                f'<sitemap><loc>{base}/sitemap.xml</loc></sitemap>'
                f'<sitemap><loc>{base}/sitemap2.xml.gz</loc></sitemap>'
                f'<sitemap><loc>{base}/sitemap-sumiu.xml</loc></sitemap></sitemapindex>').encode(), "application/xml")
        if p == "/sitemap2.xml.gz":
            xml = ('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                   f'<url><loc>{base}/head405</loc></url><url><loc>{base}/ok</loc></url></urlset>')
            return self._enviar(200, gzip.compress(xml.encode()), "application/gzip")
        if p == "/sitemap-bomba.xml":
            return self._enviar(200, b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><urlset>&a;</urlset>',
                                "application/xml")
        return self._enviar(404, _html("nao achei"))


class _HTTPSilencioso(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass  # cliente que desiste no meio (timeout de teste) não é erro


class Servidor:
    def __enter__(self):
        self.httpd = _HTTPSilencioso(("127.0.0.1", 0), Manipulador)
        self.httpd.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def url(self, caminho: str) -> str:
        return self.base + caminho

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()


class SMTPFalso:
    """SMTP mínimo (sem TLS) que guarda as mensagens recebidas."""

    def __init__(self):
        import socketserver

        self.mensagens: list[str] = []
        caixa = self.mensagens

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                def enviar(t):
                    self.wfile.write((t + "\r\n").encode())
                enviar("220 falso")
                dados = None
                while True:
                    linha = self.rfile.readline()
                    if not linha:
                        return
                    texto = linha.decode("utf-8", "replace").rstrip("\r\n")
                    if dados is not None:
                        if texto == ".":
                            caixa.append("\n".join(dados))
                            dados = None
                            enviar("250 ok")
                        else:
                            dados.append(texto)
                        continue
                    cmd = texto[:4].upper()
                    if cmd == "EHLO":
                        enviar("250-falso")
                        enviar("250 AUTH PLAIN LOGIN")
                    elif cmd == "AUTH":
                        enviar("235 ok")
                    elif cmd == "DATA":
                        dados = []
                        enviar("354 manda")
                    elif cmd == "QUIT":
                        enviar("221 tchau")
                        return
                    else:
                        enviar("250 ok")

        self._srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self._srv.daemon_threads = True
        self.porta = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def fechar(self):
        self._srv.shutdown()
        self._srv.server_close()
