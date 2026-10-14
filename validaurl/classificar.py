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


# Tipo de conteúdo (Content-Type, sem parâmetros) -> nome que aparece na tabela.
# O que não estiver aqui mostra o próprio tipo, para não esconder nada.
TIPOS = {
    "text/html": "HTML",
    "application/xhtml+xml": "HTML",
    "text/css": "CSS",
    "text/javascript": "JavaScript",
    "application/javascript": "JavaScript",
    "application/x-javascript": "JavaScript",
    "application/json": "JSON",
    "text/json": "JSON",
    "application/xml": "XML",
    "text/xml": "XML",
    "text/plain": "Texto",
    "text/markdown": "Markdown",
    "text/csv": "CSV",
    "application/pdf": "PDF",
    "application/msword": "Word (.doc)",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
    "application/vnd.ms-excel": "Excel (.xls)",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
    "application/vnd.ms-powerpoint": "PowerPoint (.ppt)",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint (.pptx)",
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "image/avif": "AVIF",
    "image/svg+xml": "SVG",
    "image/x-icon": "ICO",
    "image/vnd.microsoft.icon": "ICO",
    "video/mp4": "Vídeo MP4",
    "video/webm": "Vídeo WebM",
    "audio/mpeg": "Áudio MP3",
    "application/zip": "ZIP",
    "application/gzip": "GZIP",
    "application/x-gzip": "GZIP",
    "application/x-rar-compressed": "RAR",
    "application/x-7z-compressed": "7z",
    "application/octet-stream": "Binário",
    "application/x-msdownload": "Executável",
    "application/x-msdos-program": "Executável",
}


def rotulo_tipo(mime: str) -> str:
    """Nome legível do tipo de conteúdo ('' se o servidor não informou)."""
    if not mime:
        return ""
    return TIPOS.get(mime.strip().lower(), mime)
