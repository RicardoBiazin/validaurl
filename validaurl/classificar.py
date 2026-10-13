"""Categorias de resultado, iguais no desktop e na web (web/src/classificar.ts)."""

OK = "OK"
REDIRECIONADO = "Redirecionado"
REDIRECT_NAO_SEGUIDO = "Redirect (não seguido)"
ERRO_CLIENTE = "Erro 4xx"
ERRO_SERVIDOR = "Erro 5xx"
FALHA = "Falha"
OUTRO = "Outro"

TODAS = (OK, REDIRECIONADO, REDIRECT_NAO_SEGUIDO, ERRO_CLIENTE, ERRO_SERVIDOR, FALHA, OUTRO)

# Cores claras de fundo (tabela do desktop e planilha exportada).
CORES = {
    OK: "#d9f2d9",
    REDIRECIONADO: "#fff4cc",
    REDIRECT_NAO_SEGUIDO: "#fff4cc",
    ERRO_CLIENTE: "#f8d7da",
    ERRO_SERVIDOR: "#f5c6cb",
    FALHA: "#e2e3e5",
    OUTRO: "#e8e8ff",
}


def classificar(status: int | None, redirecionamentos: int, seguiu: bool = True) -> str:
    """Categoria a partir do código FINAL e de quantos redirects houve."""
    if status is None:
        return FALHA
    if 200 <= status < 300:
        return REDIRECIONADO if redirecionamentos else OK
    if 300 <= status < 400:
        return OUTRO if seguiu else REDIRECT_NAO_SEGUIDO
    if 400 <= status < 500:
        return ERRO_CLIENTE
    if 500 <= status < 600:
        return ERRO_SERVIDOR
    return OUTRO


def eh_problema(categoria: str) -> bool:
    return categoria not in (OK, REDIRECIONADO)
