# -*- mode: python ; coding: utf-8 -*-
"""Empacotamento do ValidaURL num .exe único (portátil).

    build.bat     (roda a suíte antes e a autoverificação do .exe depois)
"""

import pathlib

excludes = [
    "PySide6.QtQml", "PySide6.QtQuick", "PySide6.QtQuickWidgets", "PySide6.QtWebEngineCore",
    "PySide6.QtMultimedia", "PySide6.QtOpenGL", "PySide6.QtOpenGLWidgets", "PySide6.QtSql",
    "PySide6.QtTest", "PySide6.QtPdf", "PySide6.QtDesigner", "PySide6.QtHelp", "PySide6.QtUiTools",
    "PySide6.QtConcurrent", "PySide6.QtNetwork", "PySide6.QtSvg",
    "tkinter", "numpy", "pandas", "matplotlib", "PIL", "IPython", "pytest", "setuptools", "pip",
]
DLLS_DESNECESSARIAS = ["opengl32sw.dll", "Qt6Pdf.dll", "Qt6Quick.dll", "Qt6Qml.dll", "Qt6Network.dll"]

_icone = pathlib.Path("recursos/validaurl.ico")
if not _icone.is_file():
    raise SystemExit("[ValidaURL] recursos/validaurl.ico ausente: rode ferramentas\\gerar_icone.py")

import PySide6 as _PySide6
_traducoes = pathlib.Path(_PySide6.__file__).parent / "translations"
datas = [(str(_traducoes / f"{c}.qm"), "PySide6/translations")
         for c in ("qtbase_pt_BR", "qt_pt_BR") if (_traducoes / f"{c}.qm").is_file()]
datas += [(str(_icone), "recursos"), ("LICENSE", ".")]

a = Analysis(
    ["app.py"],
    datas=datas,
    hiddenimports=["certifi"],
    excludes=excludes,
    optimize=0,  # a autoverificação usa assert
)
_fora = {d.lower() for d in DLLS_DESNECESSARIAS}
a.binaries = [b for b in a.binaries if pathlib.Path(b[0]).name.lower() not in _fora]

pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="ValidaURL", debug=False, strip=False, upx=False, console=False, runtime_tmpdir=None,
    icon=str(_icone), version="versao.txt", manifest="ValidaURL.manifest",
)
