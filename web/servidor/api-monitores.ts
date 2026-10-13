/*
 * Lógica de /api/monitores e /api/confirmar, separada da Function para os
 * testes rodarem com armazém em memória e avisos falsos.
 */

import { createHash, randomBytes } from "node:crypto";
import { consumir, erro, ipDe, json } from "./acesso.ts";
import {
  type Ambiente, type Armazem, avisar, chaveConfere, CRIACOES_POR_IP_DIA, emailDisponivel, enviarEmail, executar,
  INTERVALOS, MAX_MONITORES, MAX_PUSH, MAX_URLS, type Monitor, novaChave, novoId, hashChave, publico,
  type PushAssinatura, validar,
} from "./monitor.ts";

interface Pedido {
  acao?: unknown;
  id?: unknown;
  chave?: unknown;
  monitor?: Record<string, unknown>;
  assinatura?: unknown;
}

const chaveIpDia = (ip: string, agora: number) =>
  `ip/${createHash("sha256").update(ip).digest("hex").slice(0, 24)}/${new Date(agora).toISOString().slice(0, 10)}`;

async function carregar(loja: Armazem, p: Pedido): Promise<Monitor | Response> {
  if (typeof p.id !== "string" || !/^[\w-]{6,20}$/.test(p.id)) return erro("Monitor não encontrado.", 404);
  const m = (await loja.get(`monitor/${p.id}`)) as Monitor | null;
  if (!m || !chaveConfere(m, p.chave)) return erro("Monitor não encontrado ou chave errada.", 404);
  return m;
}

async function pedirConfirmacao(m: Monitor, a: Ambiente): Promise<string> {
  const e = m.avisos.email;
  if (!e || e.confirmado) return "";
  const link = `${a.baseUrl}/api/confirmar?id=${m.id}&token=${e.token}`;
  try {
    await enviarEmail(a, e.endereco, "[ValidaURL] Confirme os avisos por e-mail",
      `Alguém (esperamos que você) pediu avisos do monitor "${m.nome}" no ValidaURL para este e-mail.\n\n` +
      `Para confirmar, abra: ${link}\n\nSe não foi você, ignore esta mensagem: sem confirmação, nada é enviado.`);
    return "";
  } catch (e2) {
    return `Não consegui enviar o e-mail de confirmação: ${(e2 as Error).message}`;
  }
}

function aplicarEmail(m: Monitor, endereco: string): void {
  if (!endereco) {
    m.avisos.email = null;
  } else if (m.avisos.email?.endereco !== endereco) {
    m.avisos.email = { endereco, confirmado: false, token: randomBytes(18).toString("base64url") };
  }
}

export async function tratarMonitores(req: Request, p: Pedido, loja: Armazem, a: Ambiente, agora = Date.now()):
  Promise<Response> {
  const ip = ipDe(req);
  switch (p.acao) {
    case "config":
      return json({ emailDisponivel: emailDisponivel(a), pushChave: a.vapid?.publica ?? null,
        limites: { maxUrls: MAX_URLS, intervalos: INTERVALOS } });

    case "criar": {
      const v = validar(p.monitor ?? {});
      if (typeof v === "string") return erro(v, 400);
      if (v.email && !emailDisponivel(a)) return erro("Avisos por e-mail ainda não estão disponíveis neste servidor.", 400);
      const kIp = chaveIpDia(ip, agora);
      const usados = Number(await loja.get(kIp)) || 0;
      if (usados >= CRIACOES_POR_IP_DIA) return erro("Limite de monitores criados hoje por esta conexão.", 429);
      if ((await loja.list("monitor/")).length >= MAX_MONITORES) return erro("O serviço atingiu o limite de monitores.", 503);
      const chave = novaChave();
      const m: Monitor = {
        id: novoId(), chaveHash: hashChave(chave), nome: v.nome, tipo: v.tipo, urls: v.urls, sitemap: v.sitemap,
        intervaloMin: v.intervaloMin, ativo: v.ativo, criadoEm: new Date(agora).toISOString(), proximaEm: agora,
        ultimaEm: 0, resultados: [], historico: [],
        avisos: { email: null, webhook: v.webhook, push: [], repetirProblemas: v.repetirProblemas,
          avisarRecuperacao: v.avisarRecuperacao },
        ultimoErroAviso: "",
      };
      aplicarEmail(m, v.email);
      // Sem checar aqui (a Function tem 10 s): o navegador pede "checar" logo
      // em seguida, e a agenda pega o monitor na próxima rodada de qualquer jeito.
      const aviso = await pedirConfirmacao(m, a);
      await loja.set(`monitor/${m.id}`, m);
      await loja.set(kIp, usados + 1);
      return json({ id: m.id, chave, monitor: publico(m), aviso }, 201);
    }

    case "ver": {
      const m = await carregar(loja, p);
      return m instanceof Response ? m : json({ monitor: publico(m) });
    }

    case "editar": {
      const m = await carregar(loja, p);
      if (m instanceof Response) return m;
      const v = validar(p.monitor ?? {});
      if (typeof v === "string") return erro(v, 400);
      if (v.email && !emailDisponivel(a)) return erro("Avisos por e-mail ainda não estão disponíveis neste servidor.", 400);
      const mudouAlvo = v.tipo !== m.tipo || v.sitemap !== m.sitemap || v.urls.join("\n") !== m.urls.join("\n");
      Object.assign(m, { nome: v.nome, tipo: v.tipo, urls: v.urls, sitemap: v.sitemap, intervaloMin: v.intervaloMin,
        ativo: v.ativo });
      m.avisos.webhook = v.webhook;
      m.avisos.repetirProblemas = v.repetirProblemas;
      m.avisos.avisarRecuperacao = v.avisarRecuperacao;
      aplicarEmail(m, v.email);
      if (mudouAlvo) {
        m.resultados = [];
        m.ultimaEm = 0;
      }
      m.proximaEm = Math.min(m.proximaEm, (m.ultimaEm || agora) + m.intervaloMin * 60_000);
      const aviso = await pedirConfirmacao(m, a);
      await loja.set(`monitor/${m.id}`, m);
      return json({ monitor: publico(m), aviso });
    }

    case "excluir": {
      const m = await carregar(loja, p);
      if (m instanceof Response) return m;
      await loja.delete(`monitor/${m.id}`);
      return json({ ok: true });
    }

    case "checar": {
      const m = await carregar(loja, p);
      if (m instanceof Response) return m;
      if (!consumir(`checar-monitor:${m.id}`, 1, 2, agora)) {
        return erro("Este monitor acabou de ser checado. Espere um minuto.", 429, { "Retry-After": "60" });
      }
      const { mudancas } = await executar(m, agora, 3500, MAX_URLS);
      await avisar(m, mudancas, a);
      await loja.set(`monitor/${m.id}`, m);
      return json({ monitor: publico(m) });
    }

    case "testar-avisos": {
      const m = await carregar(loja, p);
      if (m instanceof Response) return m;
      if (!consumir(`testar:${m.id}`, 1, 3, agora)) return erro("Calma: no máximo 3 testes por minuto.", 429);
      const exemplo = { url: "https://exemplo.com/pagina-de-teste", status: 404, categoria: "Erro 4xx",
        erro: "Not Found (teste)", tempoMs: 0, urlFinal: "" };
      const erros = await avisar({ ...m, ultimaEm: agora }, { novos: [exemplo], recuperados: [], ainda: [], total: 1 }, a,
        true);
      return json({ erros, email: m.avisos.email ? (m.avisos.email.confirmado ? "enviado" : "aguardando confirmação") : null });
    }

    case "push": {
      const m = await carregar(loja, p);
      if (m instanceof Response) return m;
      const s = p.assinatura as PushAssinatura;
      if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || s.endpoint.length > 1000 ||
        typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") {
        return erro("Assinatura de notificação inválida.", 400);
      }
      const limpa = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) } };
      m.avisos.push = [...m.avisos.push.filter((x) => x.endpoint !== limpa.endpoint), limpa].slice(-MAX_PUSH);
      await loja.set(`monitor/${m.id}`, m);
      return json({ monitor: publico(m) });
    }

    default:
      return erro("Ação desconhecida.", 400);
  }
}

const pagina = (titulo: string, texto: string, status = 200) => new Response(
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${titulo} — ValidaURL</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">` +
  `<h1>${titulo}</h1><p>${texto}</p><p><a href="/">Abrir o ValidaURL</a></p></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Robots-Tag": "noindex" } },
);

/** GET /api/confirmar?id&token[&sair=1] — link do e-mail (sem cookie do portão). */
export async function tratarConfirmacao(req: Request, loja: Armazem): Promise<Response> {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const token = u.searchParams.get("token") ?? "";
  const m = /^[\w-]{6,20}$/.test(id) ? ((await loja.get(`monitor/${id}`)) as Monitor | null) : null;
  const e = m?.avisos.email;
  const a = Buffer.from(token);
  const b = Buffer.from(e?.token ?? "");
  if (!m || !e || a.length !== b.length || !a.equals(b)) {
    return pagina("Link inválido", "Este link não vale mais (o monitor foi apagado ou o e-mail mudou).", 404);
  }
  if (u.searchParams.get("sair") === "1") {
    m.avisos.email = null;
    await loja.set(`monitor/${m.id}`, m);
    return pagina("Pronto", "Você não vai mais receber avisos por e-mail deste monitor.");
  }
  e.confirmado = true;
  await loja.set(`monitor/${m.id}`, m);
  return pagina("E-mail confirmado", `Os avisos do monitor “${m.nome.replace(/[<>&"]/g, "")}” vão chegar neste e-mail.`);
}
