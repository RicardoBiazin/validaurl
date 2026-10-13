"""Senha do SMTP em disco protegida pela DPAPI do Windows (versão enxuta do
segredos.py do FTPZilla). A chave fica amarrada à conta do Windows: a
configuração copiada para outra máquina ou lida por outro usuário não entrega
a senha. Fora do Windows o valor fica em texto puro.
"""

from __future__ import annotations

import base64

PREFIXO = "dpapi:"


def _api():
    try:
        import ctypes
        from ctypes import wintypes

        class Blob(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        return ctypes, ctypes.windll.crypt32, ctypes.windll.kernel32, Blob
    except Exception:  # noqa: BLE001
        return None


def _executar(funcao: str, dados: bytes) -> bytes | None:
    api = _api()
    if api is None:
        return None
    ctypes, crypt, kernel, Blob = api
    buf = ctypes.create_string_buffer(dados, len(dados))
    entrada = Blob(len(dados), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    saida = Blob()
    if not getattr(crypt, funcao)(ctypes.byref(entrada), None, None, None, None, 0, ctypes.byref(saida)):
        return None
    try:
        return ctypes.string_at(saida.pbData, saida.cbData)
    finally:
        kernel.LocalFree(saida.pbData)


def proteger(valor: str) -> str:
    if not valor or valor.startswith(PREFIXO):
        return valor
    cifrado = _executar("CryptProtectData", valor.encode("utf-8"))
    return PREFIXO + base64.b64encode(cifrado).decode("ascii") if cifrado else valor


def revelar(valor: str) -> str:
    if not valor or not valor.startswith(PREFIXO):
        return valor or ""
    try:
        bruto = base64.b64decode(valor[len(PREFIXO):])
    except ValueError:
        return ""
    claro = _executar("CryptUnprotectData", bruto)
    return claro.decode("utf-8", "replace") if claro else ""
