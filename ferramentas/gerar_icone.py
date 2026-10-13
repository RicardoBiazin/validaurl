"""Gera recursos/validaurl.ico (e web/public/favicon.svg) a partir de desenho em código.

    .venv\\Scripts\\python.exe ferramentas\\gerar_icone.py
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPointF, QRectF, Qt  # noqa: E402
from PySide6.QtGui import QColor, QGuiApplication, QImage, QPainter, QPainterPath, QPen  # noqa: E402

RAIZ = Path(__file__).resolve().parents[1]

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect x="2" y="2" width="60" height="60" rx="14" fill="#1f6feb"/>
<path d="M17 33 l10 10 l20 -22" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def desenhar(tam: int) -> QImage:
    img = QImage(tam, tam, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    e = tam / 64
    p.setBrush(QColor("#1f6feb"))
    p.setPen(Qt.NoPen)
    p.drawRoundedRect(QRectF(2 * e, 2 * e, 60 * e, 60 * e), 14 * e, 14 * e)
    caminho = QPainterPath(QPointF(17 * e, 33 * e))
    caminho.lineTo(27 * e, 43 * e)
    caminho.lineTo(47 * e, 21 * e)
    p.setPen(QPen(QColor("white"), 7 * e, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
    p.setBrush(Qt.NoBrush)
    p.drawPath(caminho)
    p.end()
    return img


def main() -> int:
    QGuiApplication(sys.argv)
    destino = RAIZ / "recursos" / "validaurl.ico"
    destino.parent.mkdir(exist_ok=True)
    # O plugin ICO do Qt grava só uma imagem: 256 px, que o Windows reduz bem.
    if not desenhar(256).save(str(destino), "ICO"):
        print("ERRO: o Qt não gravou o .ico (plugin imageformats/qico ausente?)")
        return 1
    publico = RAIZ / "web" / "public"
    if publico.parent.is_dir():
        publico.mkdir(exist_ok=True)
        (publico / "favicon.svg").write_text(SVG, encoding="utf-8")
    print(destino)
    return 0


if __name__ == "__main__":
    sys.exit(main())
