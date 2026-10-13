"""Linha de comando: python -m validaurl [opções] (URLs | arquivo | --rastrear SITE | --sitemap URL)

Sai com código 1 se alguma URL tiver problema (útil em agendamento/CI).
Com --repetir N fica checando a cada N minutos (Ctrl+C para parar) e, com
--webhook, avisa quando algo muda.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import NOME, VERSAO
from .avisos import ConfigAvisos, comparar, disparar
from .classificar import eh_problema
from .entradas import deduplicar, urls_do_arquivo
from .exportar import exportar
from .lote import verificar_lote
from .rastreador import OpcoesRastreio, rastrear
from .sitemap import ErroSitemap, urls_do_sitemap
from .verificador import Opcoes, novo_cliente


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="validaurl", description="Confere se links respondem OK (200).")
    ap.add_argument("alvos", nargs="*", help="URLs ou arquivos .txt/.csv/.xlsx")
    ap.add_argument("--rastrear", metavar="SITE", help="rastreia o site e checa todos os links")
    ap.add_argument("--sitemap", metavar="URL", help="checa as URLs do sitemap (ou do site)")
    ap.add_argument("--saida", metavar="ARQ", help="exporta para .csv, .xlsx ou .json")
    ap.add_argument("--timeout", type=float, default=15)
    ap.add_argument("--concorrencia", type=int, default=16)
    ap.add_argument("--max-paginas", type=int, default=500)
    ap.add_argument("--so-problemas", action="store_true", help="imprime só as URLs com problema")
    ap.add_argument("--repetir", type=float, metavar="MIN", help="repete a checagem a cada MIN minutos")
    ap.add_argument("--webhook", metavar="URL", help="avisa por webhook (JSON) quando algo muda")
    ap.add_argument("--version", action="version", version=f"{NOME} {VERSAO}")
    a = ap.parse_args(argv)
    if not (a.alvos or a.rastrear or a.sitemap):
        ap.error("informe URLs, um arquivo, --rastrear ou --sitemap")

    if a.repetir is not None and a.repetir <= 0:
        ap.error("--repetir precisa ser maior que zero")
    cfg = ConfigAvisos(notificacao=False, webhook=a.webhook or "")
    alvo = a.rastrear or a.sitemap or (a.alvos[0] if len(a.alvos) == 1 else f"{len(a.alvos)} alvos")
    anteriores = None
    try:
        while True:
            codigo, anteriores = _uma_rodada(a, anteriores, cfg, alvo)
            if a.repetir is None:
                return codigo
            print(f"Próxima checagem em {a.repetir:g} min (Ctrl+C para parar).", file=sys.stderr, flush=True)
            time.sleep(a.repetir * 60)
    except KeyboardInterrupt:
        return 130


def _uma_rodada(a, anteriores, cfg: ConfigAvisos, alvo: str):
    opcoes = Opcoes(timeout=a.timeout, concorrencia=a.concorrencia)
    avisos: list[str] = []

    def imprimir(r):
        if a.so_problemas and not eh_problema(r.categoria):
            return
        status = r.status if r.status is not None else "---"
        print(f"{status}\t{r.categoria}\t{r.url}" + (f"\t{r.erro}" if r.erro else ""), flush=True)

    if a.rastrear:
        res = rastrear(a.rastrear, opcoes, OpcoesRastreio(max_paginas=a.max_paginas), ao_resultado=imprimir,
                       avisos=avisos)
    else:
        urls: list[str] = []
        if a.sitemap:
            try:
                with novo_cliente(opcoes) as cli:
                    urls += urls_do_sitemap(cli, a.sitemap, avisos)
            except ErroSitemap as exc:
                print(f"Erro no sitemap: {exc}", file=sys.stderr)
                return 2, anteriores
        for item in a.alvos:
            urls += urls_do_arquivo(item) if Path(item).is_file() else [item]
        res = verificar_lote(deduplicar(urls), opcoes, ao_resultado=imprimir)

    for aviso in avisos:
        print(f"Aviso: {aviso}", file=sys.stderr)
    if a.saida:
        exportar(res, a.saida)
    problemas = sum(eh_problema(r.categoria) for r in res)
    print(f"\n{len(res)} checadas, {problemas} com problema.", file=sys.stderr)
    if cfg.webhook:
        for erro in disparar(cfg, comparar(anteriores, res), alvo):
            print(f"Aviso não enviado: {erro}", file=sys.stderr)
    return (1 if problemas else 0), res


if __name__ == "__main__":
    sys.exit(main())
