/*
 * Controle de uso das Functions (contra robôs e abuso):
 *  1. passe do portão anti-robô (cookie assinado `vu_passe`) — o mesmo que a
 *     Edge Function confere; aqui é a segunda trava, para o caso de alguém
 *     chamar a Function por outro caminho;
 *  2. só POST do próprio site (Origin igual ao do pedido);
 *  3. limite por IP numa janela de 1 minuto (memória da instância; o Netlify
 *     ainda aplica o `rateLimit` declarado em cada Function).
 */

import { COOKIE, lerCookie, verificarPasse } from "../src/portao/nucleo.ts";

const CABECALHOS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export function json(dados: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(dados), { status, headers: { ...CABECALHOS, ...extra } });
}

export function erro(mensagem: string, status: number, extra: Record<string, string> = {}): Response {
  return json({ erro: mensagem }, status, extra);
}

export function ambienteDev(): boolean {
  return process.env.NETLIFY_DEV === "true" || process.env.CONTEXT === "dev";
}

export function ipDe(req: Request): string {
  return req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "desconhecido";
}

// ------------------------------------------------------------ limite por IP

const janelas = new Map<string, { inicio: number; usados: number }>();

/** Consome `custo` da cota de `limite` por minuto. false = estourou. */
export function consumir(chave: string, custo: number, limite: number, agora = Date.now()): boolean {
  if (janelas.size > 5000) {
    for (const [k, v] of janelas) if (agora - v.inicio > 60_000) janelas.delete(k);
  }
  let j = janelas.get(chave);
  if (!j || agora - j.inicio > 60_000) {
    j = { inicio: agora, usados: 0 };
    janelas.set(chave, j);
  }
  if (j.usados + custo > limite) return false;
  j.usados += custo;
  return true;
}

export function zerarLimites(): void {
  janelas.clear();
}

// ------------------------------------------------------------ porteiro

export interface Porteiro {
  metodos?: string[];
  /** Exigir o cookie do portão (padrão: sim). Links de e-mail não têm cookie. */
  passe?: boolean;
  /** Exigir Origin igual (padrão: sim para POST/PUT/DELETE). */
  mesmaOrigem?: boolean;
}

/** null = pode seguir; Response = recusa pronta. */
export async function porteiro(req: Request, p: Porteiro = {}): Promise<Response | null> {
  const metodos = p.metodos ?? ["POST"];
  if (!metodos.includes(req.method)) return erro("Método não permitido.", 405, { Allow: metodos.join(", ") });
  const url = new URL(req.url);
  const alterando = req.method !== "GET" && req.method !== "HEAD";
  if ((p.mesmaOrigem ?? alterando) && alterando) {
    const origem = req.headers.get("origin");
    if (!origem || origem !== url.origin) return erro("Origem inválida.", 403);
  }
  if (p.passe === false) return null;
  const segredo = process.env.PORTAO_SEGREDO ?? "";
  if (segredo.length < 16) {
    if (ambienteDev()) return null;
    return erro("Portão anti-robô sem configuração (PORTAO_SEGREDO).", 500);
  }
  const ok = await verificarPasse(segredo, lerCookie(req.headers.get("cookie"), COOKIE), req.headers.get("user-agent") ?? "");
  return ok ? null : erro("Acesso negado: abra o ValidaURL pelo navegador.", 403);
}

export async function lerJson<T>(req: Request, maxBytes = 64 * 1024): Promise<T | null> {
  try {
    const texto = await req.text();
    if (texto.length > maxBytes) return null;
    return JSON.parse(texto) as T;
  } catch {
    return null;
  }
}
