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
