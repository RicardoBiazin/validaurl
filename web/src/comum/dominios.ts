/*
 * Vencimento de domínios: situação, sugestões de registro e regra de aviso.
 * Mesma lógica de validaurl/dominios.py. Sem nada de Node nem de DOM: roda no
 * servidor (Function) e no navegador.
 */

export const LIMITE_CRITICO = 15; // dias
export const LIMITE_ATENCAO = 60; // dias

export type Situacao = "vencido" | "critico" | "atencao" | "ok" | "desconhecido";

const GRAVIDADE: Record<Situacao, number> = { vencido: 0, critico: 1, atencao: 2, ok: 3, desconhecido: 4 };

export const ROTULOS: Record<Situacao, string> = {
  vencido: "Vencido",
  critico: "Vence em breve",
  atencao: "Atenção",
  ok: "OK",
  desconhecido: "Sem data",
};

export const CORES: Record<Situacao, string> = {
  vencido: "#f5c6cb",
  critico: "#f8d7da",
  atencao: "#fff4cc",
  ok: "#d9f2d9",
  desconhecido: "#e2e3e5",
};

export interface DominioVerificado {
  dominio: string;
  expira: string | null;
  registrador: string;
  status: string[];
  erro: string;
  verificado: string;
}

export interface DominioItem extends DominioVerificado {
  ultimoAviso: string;
}

const ONDE_BR: [string, string][] = [["Registro.br (lista de registradores credenciados)", "https://registro.br/"]];
const ONDE_GERAL: [string, string][] = [
  ["Cloudflare Registrar", "https://www.cloudflare.com/products/registrar/"],
  ["Namecheap", "https://www.namecheap.com/"],
  ["Porkbun", "https://porkbun.com/"],
];

/** (nome, endereço) de onde registrar ou renovar o domínio. */
export function sugestoesRegistro(dominio: string): [string, string][] {
  return [...(dominio.toLowerCase().endsWith(".br") ? ONDE_BR : ONDE_GERAL)];
}

/** Dias inteiros até o vencimento (negativo se já venceu); null se não há data válida. */
export function diasAte(expira: string | null, agora: number = Date.now()): number | null {
  if (!expira) return null;
  const t = Date.parse(expira);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - agora) / 86_400_000);
}

export function situacao(dias: number | null): Situacao {
  if (dias === null) return "desconhecido";
  if (dias < 0) return "vencido";
  if (dias <= LIMITE_CRITICO) return "critico";
  if (dias <= LIMITE_ATENCAO) return "atencao";
  return "ok";
}

/**
 * Marca em cada item a situação já avisada e devolve os que precisam de aviso agora.
 * Avisa quando a situação piora; quando renova (volta a "ok") zera a memória.
 */
export function atualizarAvisos(itens: DominioItem[], agora: number = Date.now()): DominioItem[] {
  const novos: DominioItem[] = [];
  for (const item of itens) {
    const atual = situacao(diasAte(item.expira, agora));
    if (atual === "desconhecido") continue;
    if (atual === "ok") {
      item.ultimoAviso = "ok";
      continue;
    }
    const ja = (item.ultimoAviso || "ok") as Situacao;
    if (GRAVIDADE[atual] < GRAVIDADE[ja]) {
      item.ultimoAviso = atual;
      novos.push(item);
    }
  }
  return novos;
}

export function textoAviso(item: DominioItem, agora: number = Date.now()): string {
  const dias = diasAte(item.expira, agora);
  let quando: string;
  if (dias === null) quando = "sem data de vencimento";
  else if (dias < 0) quando = `venceu há ${-dias} dia(s)`;
  else quando = `vence em ${dias} dia(s)`;
  const nomes = sugestoesRegistro(item.dominio).map(([n]) => n).join(" · ");
  return `${item.dominio}: ${quando}. Renovar ou registrar em: ${nomes}.`;
}
