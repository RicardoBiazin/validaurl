/* Categorias de resultado: as mesmas do desktop (validaurl/classificar.py). */

export const OK = "OK";
export const REDIRECIONADO = "Redirecionado";
export const REDIRECT_NAO_SEGUIDO = "Redirect (não seguido)";
export const ERRO_CLIENTE = "Erro 4xx";
export const ERRO_SERVIDOR = "Erro 5xx";
export const FALHA = "Falha";
export const OUTRO = "Outro";

export const TODAS = [OK, REDIRECIONADO, REDIRECT_NAO_SEGUIDO, ERRO_CLIENTE, ERRO_SERVIDOR, FALHA, OUTRO];

export const CLASSE_CSS: Record<string, string> = {
  [OK]: "ok",
  [REDIRECIONADO]: "redir",
  [REDIRECT_NAO_SEGUIDO]: "redir",
  [ERRO_CLIENTE]: "e4",
  [ERRO_SERVIDOR]: "e5",
  [FALHA]: "falha",
  [OUTRO]: "outro",
};

export function classificar(status: number | null, redirecionamentos: number, seguiu = true): string {
  if (status === null) return FALHA;
  if (status >= 200 && status < 300) return redirecionamentos ? REDIRECIONADO : OK;
  if (status >= 300 && status < 400) return seguiu ? OUTRO : REDIRECT_NAO_SEGUIDO;
  if (status >= 400 && status < 500) return ERRO_CLIENTE;
  if (status >= 500 && status < 600) return ERRO_SERVIDOR;
  return OUTRO;
}

export function ehProblema(categoria: string): boolean {
  return categoria !== OK && categoria !== REDIRECIONADO;
}

/** O que as Functions devolvem por URL. */
export interface Checagem {
  url: string;
  status: number | null;
  urlFinal: string;
  redirects: { status: number; url: string }[];
  tempoMs: number;
  erro: string;
  tipo: string;
  metodo: string;
}

export interface Resultado extends Checagem {
  categoria: string;
  encontradoEm: string;
}

/* Tipo de conteúdo (Content-Type, sem parâmetros) -> nome que aparece na tabela.
 * Mesma tabela do desktop (validaurl/classificar.py). O que não estiver aqui
 * mostra o próprio tipo, para não esconder nada. */
const TIPOS: Record<string, string> = {
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
};

/** Nome legível do tipo de conteúdo ('' se o servidor não informou). */
export function rotuloTipo(mime: string): string {
  if (!mime) return "";
  return TIPOS[mime.trim().toLowerCase()] ?? mime;
}
