/*
 * Portao anti-robo do ValidaURL (Netlify Edge Function, Deno).
 *
 * Sem servico de terceiros (nada de reCAPTCHA/Cloudflare): quem chega sem o
 * cookie `vu_passe` valido recebe uma pagina que resolve uma prova de
 * trabalho (~1 s num PC) e troca a solucao pelo cookie, valido por 7 dias para
 * aquele navegador. Pedidos de arquivos (JS, wasm...) sem cookie levam 403.
 *
 * As Functions em /api/ tambem conferem o passe (defesa em profundidade).
 *
 * Segredo: variavel de ambiente PORTAO_SEGREDO (32+ bytes aleatorios).
 * Sem ela: em `netlify dev` o portao fica ABERTO (para desenvolver); em
 * qualquer deploy (producao, preview, branch) fica FECHADO com erro 500 --
 * falhar aberto em producao deixaria os robos passarem sem ninguem notar.
 */

import {
  BITS_PADRAO, cabecalhoCookie, COOKIE, criarDesafio, criarPasse, lerCookie, verificarDesafio, verificarPasse,
} from "../../src/portao/nucleo.ts";
import { CSS_DESAFIO, JS_DESAFIO, paginaDesafio } from "../../src/portao/pagina.ts";

// Tipos minimos do runtime do Netlify (evita depender de pacote externo).
interface Contexto {
  next(): Promise<Response>;
  deploy?: { context?: string };
}
declare const Netlify: { env: { get(nome: string): string | undefined } };

const DOMINIO_OFICIAL = "validaurl.biazin.com.br";
const DOMINIO_ANTIGO = "validaurl.netlify.app";

const LIVRES = /^\/(robots\.txt|favicon\.ico|manifest\.webmanifest|icons\/[\w.-]+)$/;

const CSP_PORTAO = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function resposta(corpo: BodyInit | null, status: number, tipo: string, extra: Record<string, string> = {}): Response {
  return new Response(corpo, {
    status,
    headers: {
      "Content-Type": tipo,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CSP_PORTAO,
      ...extra,
    },
  });
}

function querHtml(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const modo = req.headers.get("sec-fetch-mode");
  if (modo) return modo === "navigate";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

export default async function portao(req: Request, context: Contexto): Promise<Response> {
  const url = new URL(req.url);
  const caminho = url.pathname;

  // Endereco antigo -> oficial, ANTES do portao: senao quem chega pelo antigo
  // resolveria o desafio duas vezes (o cookie e' por dominio). So' o nome
  // exato: previas de deploy ("<id>--validaurl.netlify.app") continuam.
  if (url.hostname === DOMINIO_ANTIGO) {
    return Response.redirect(`https://${DOMINIO_OFICIAL}${caminho}${url.search}`, 301);
  }

  // Livres: o robots.txt (Disallow: /) precisa chegar a quem o respeita; o
  // icone e o manifesto sao pedidos pelo navegador SEM cookie (o manifesto vai
  // em modo CORS sem credenciais) e nao dao acesso a nada.
  if (LIVRES.test(caminho)) return context.next();

  const segredo = Netlify.env.get("PORTAO_SEGREDO") ?? "";
  if (segredo.length < 16) {
    if (context.deploy?.context === "dev") return context.next();
    return resposta("Portão anti-robô sem configuração: defina a variável PORTAO_SEGREDO no Netlify.", 500,
      "text/plain; charset=utf-8");
  }

  if (caminho === "/__portao/desafio.js") return resposta(JS_DESAFIO, 200, "text/javascript; charset=utf-8");
  if (caminho === "/__portao/estilo.css") return resposta(CSS_DESAFIO, 200, "text/css; charset=utf-8");

  const ua = req.headers.get("user-agent") ?? "";
  const seguro = url.protocol === "https:";

  if (caminho === "/__portao/verificar") {
    if (req.method !== "POST") return resposta("Método não permitido.", 405, "text/plain; charset=utf-8", { Allow: "POST" });
    // So' aceita do proprio site (o navegador sempre manda Origin num POST com fetch).
    const origem = req.headers.get("origin");
    if (origem && origem !== url.origin) return resposta("Origem inválida.", 403, "text/plain; charset=utf-8");
    let dados: { desafio?: unknown; nonce?: unknown };
    try {
      const texto = await req.text();
      if (texto.length > 1000) throw new Error("grande");
      dados = JSON.parse(texto);
    } catch {
      return resposta("Pedido inválido.", 400, "text/plain; charset=utf-8");
    }
    const r = await verificarDesafio(segredo, dados.desafio, dados.nonce, BITS_PADRAO);
    if (!r.ok) {
      // 409 = desafio vencido: a pagina recarrega e ganha outro.
      return resposta(JSON.stringify({ ok: false, motivo: r.motivo }), r.motivo === "expirado" ? 409 : 403,
        "application/json");
    }
    const passe = await criarPasse(segredo, ua);
    return resposta(JSON.stringify({ ok: true }), 200, "application/json", { "Set-Cookie": cabecalhoCookie(passe, seguro) });
  }

  if (await verificarPasse(segredo, lerCookie(req.headers.get("cookie"), COOKIE), ua)) {
    return context.next();
  }

  if (querHtml(req)) {
    const desafio = await criarDesafio(segredo);
    return resposta(req.method === "HEAD" ? null : paginaDesafio(desafio, BITS_PADRAO), 200, "text/html; charset=utf-8");
  }
  return resposta("Acesso negado: abra o ValidaURL pelo navegador.", 403, "text/plain; charset=utf-8");
}
