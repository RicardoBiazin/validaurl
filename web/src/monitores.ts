/*
 * Aba "Monitores": checagem automática no servidor a cada X minutos, com
 * avisos por e-mail, webhook e notificação do navegador (push).
 *
 * Sem login: cada monitor tem um link secreto (#monitor=ID&chave=K). Este
 * navegador guarda os links dos monitores que criou (localStorage); quem tiver
 * o link gerencia o monitor.
 */

import { CLASSE_CSS, ehProblema } from "./comum/classificar.ts";
import { comEsquema, urlsDoTexto } from "./comum/entradas.ts";
import { api } from "./motor.ts";

interface Salvo {
  id: string;
  chave: string;
  nome: string;
}

interface ResultadoCurto {
  url: string;
  status: number | null;
  categoria: string;
  erro: string;
  tempoMs: number;
  urlFinal: string;
}

interface MonitorPublico {
  id: string;
  nome: string;
  tipo: "lista" | "sitemap";
  urls: string[];
  sitemap: string;
  intervaloMin: number;
  ativo: boolean;
  criadoEm: string;
  proximaEm: number;
  ultimaEm: number;
  resultados: ResultadoCurto[];
  historico: { em: number; total: number; problemas: number }[];
  avisos: { email: { endereco: string; confirmado: boolean } | null; webhook: string; push: number;
    repetirProblemas: boolean; avisarRecuperacao: boolean };
  ultimoErroAviso: string;
}

interface Config {
  emailDisponivel: boolean;
  pushChave: string | null;
  limites: { maxUrls: number; intervalos: number[] };
}

type Filho = Node | string | null | undefined | false;

/** Cria elemento com texto seguro (nunca innerHTML com dado de fora). */
function h(tag: string, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...filhos: Filho[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    // CSP sem 'unsafe-inline': estilo pelo CSSOM, nunca pelo atributo.
    else if (k === "style" && typeof v === "string") el.style.cssText = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const f of filhos) if (f !== null && f !== undefined && f !== false) el.append(f);
  return el;
}

const CHAVE_LOCAL = "vu_monitores";

function salvos(): Salvo[] {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_LOCAL) ?? "[]");
  } catch {
    return [];
  }
}

function guardar(lista: Salvo[]): void {
  try {
    localStorage.setItem(CHAVE_LOCAL, JSON.stringify(lista));
  } catch { /* sem armazenamento: o link continua valendo */ }
}

function lembrar(s: Salvo): void {
  guardar([s, ...salvos().filter((x) => x.id !== s.id)]);
}

function esquecer(id: string): void {
  guardar(salvos().filter((x) => x.id !== id));
}

const linkSecreto = (s: Salvo) => `${location.origin}/#monitor=${encodeURIComponent(s.id)}&chave=${encodeURIComponent(s.chave)}`;
const quando = (ms: number) => ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
const rotuloIntervalo = (min: number) => min < 60 ? `${min} min` : min < 1440 ? `${min / 60} h` : "1 dia";

export function iniciarMonitores(raiz: HTMLElement, abrirAba: () => void): void {
  let config: Config | null = null;

  async function obterConfig(): Promise<Config> {
    config ??= await api<Config>("/api/monitores", { acao: "config" });
    return config;
  }

  function mostrar(...filhos: Filho[]) {
    raiz.replaceChildren(...filhos.filter((f): f is Node | string => !!f));
  }

  function erroNaTela(e: unknown) {
    mostrar(h("p", { class: "erro-msg" }, (e as Error).message), h("button", { class: "botao secundario", onclick: listar },
      "Voltar"));
  }

  // ------------------------------------------------------------ lista
  async function listar() {
    history.replaceState(null, "", location.pathname + location.search);
    const meus = salvos();
    const grade = h("div", { class: "grade-monitores" });
    const campoLink = h("input", { type: "url", placeholder: "Cole aqui o link secreto de um monitor" }) as HTMLInputElement;
    mostrar(
      h("div", { class: "linha" },
        h("button", { class: "botao", onclick: () => formulario(null) }, "Novo monitor"),
        h("span", { class: "discreto" }, "O servidor checa sozinho, mesmo com o navegador fechado, e avisa quando algo muda.")),
      meus.length ? grade : h("p", { class: "discreto" }, "Nenhum monitor neste navegador ainda."),
      h("div", { class: "linha" }, campoLink,
        h("button", { class: "botao secundario", onclick: () => abrirPeloLink(campoLink.value) }, "Abrir")),
    );
    for (const s of meus) {
      const estado = h("div", { class: "estado discreto" }, "carregando…");
      grade.append(h("button", { class: "cartao-monitor", onclick: () => detalhe(s) }, h("strong", {}, s.nome), estado));
      api<{ monitor: MonitorPublico }>("/api/monitores", { acao: "ver", id: s.id, chave: s.chave }).then(({ monitor }) => {
        const problemas = monitor.resultados.filter((r) => ehProblema(r.categoria)).length;
        estado.replaceChildren(
          h("span", { class: `selo ${!monitor.ativo ? "parado" : problemas ? "ruim" : "ok"}` },
            !monitor.ativo ? "pausado" : problemas ? `${problemas} com problema` : monitor.ultimaEm ? "tudo OK" : "aguardando"),
          ` · a cada ${rotuloIntervalo(monitor.intervaloMin)} · última: ${quando(monitor.ultimaEm)}`);
      }).catch((e) => {
        estado.textContent = (e as Error).message;
        if ((e as { status?: number }).status === 404) {
          estado.append(" ", h("a", { href: "#", onclick: (ev) => {
            ev.preventDefault();
            esquecer(s.id);
            void listar();
          } }, "remover daqui"));
        }
      });
    }
  }

  function abrirPeloLink(texto: string) {
    const m = /monitor=([\w-]+)&chave=([\w-]+)/.exec(texto);
    if (!m) return alert("Link inválido. Ele tem o formato …/#monitor=ID&chave=CHAVE");
    void detalhe({ id: m[1], chave: m[2], nome: "Monitor" }, true);
  }

  // ------------------------------------------------------------ formulário
  async function formulario(existente: { salvo: Salvo; monitor: MonitorPublico } | null) {
    let cfg: Config;
    try {
      cfg = await obterConfig();
    } catch (e) {
      return erroNaTela(e);
    }
    const m = existente?.monitor;
    const nome = h("input", { type: "text", maxlength: "80", value: m?.nome ?? "", placeholder: "Ex.: Site da empresa" }) as HTMLInputElement;
    const tipo = h("select", {}) as HTMLSelectElement;
    tipo.add(new Option("Lista de URLs", "lista"));
    tipo.add(new Option("Sitemap", "sitemap"));
    tipo.value = m?.tipo ?? "lista";
    const urls = h("textarea", { rows: "8", spellcheck: "false",
      placeholder: `Até ${cfg.limites.maxUrls} URLs, uma por linha` }) as HTMLTextAreaElement;
    urls.value = m?.urls.join("\n") ?? "";
    const sitemap = h("input", { type: "url", value: m?.sitemap ?? "", placeholder: "https://www.seusite.com.br/sitemap.xml" }) as HTMLInputElement;
    const intervalo = h("select", {}) as HTMLSelectElement;
    for (const i of cfg.limites.intervalos) intervalo.add(new Option(`A cada ${rotuloIntervalo(i)}`, String(i)));
    intervalo.value = String(m?.intervaloMin ?? 15);
    const ativo = h("input", { type: "checkbox" }) as HTMLInputElement;
    ativo.checked = m?.ativo ?? true;
    const email = h("input", { type: "email", value: m?.avisos.email?.endereco ?? "", placeholder: "voce@empresa.com",
      disabled: !cfg.emailDisponivel }) as HTMLInputElement;
    const webhook = h("input", { type: "url", value: m?.avisos.webhook ?? "",
      placeholder: "https://hooks.slack.com/…  (Slack, Discord, Teams, Google Chat, n8n…)" }) as HTMLInputElement;
    const repetir = h("input", { type: "checkbox" }) as HTMLInputElement;
    repetir.checked = m?.avisos.repetirProblemas ?? false;
    const recup = h("input", { type: "checkbox" }) as HTMLInputElement;
    recup.checked = m?.avisos.avisarRecuperacao ?? true;
    const msg = h("p", { class: "erro-msg" });
    const blocoUrls = h("label", {}, "URLs", urls);
    const blocoSitemap = h("label", {}, `Sitemap (as primeiras ${cfg.limites.maxUrls} URLs são checadas)`, sitemap);
    const alternar = () => {
      blocoUrls.hidden = tipo.value !== "lista";
      blocoSitemap.hidden = tipo.value !== "sitemap";
    };
    tipo.addEventListener("change", alternar);
    alternar();
    const botao = h("button", { class: "botao", type: "submit" }, existente ? "Salvar" : "Criar monitor") as HTMLButtonElement;

    const form = h("form", { class: "form-monitor" },
      h("h2", {}, existente ? `Editar: ${m!.nome}` : "Novo monitor"),
      h("label", {}, "Nome", nome),
      h("label", {}, "O que checar", tipo),
      blocoUrls, blocoSitemap,
      h("label", {}, "Frequência", intervalo),
      h("label", {}, ativo, " Ativo (desmarque para pausar)"),
      h("fieldset", {}, h("legend", {}, "Avisos"),
        h("label", {}, "E-mail", email),
        cfg.emailDisponivel ? h("span", { class: "discreto" },
          "Você recebe um e-mail para confirmar. Sem confirmação, nada é enviado.")
          : h("span", { class: "discreto" }, "Avisos por e-mail ainda não estão ativos neste servidor."),
        h("label", {}, "Webhook (https)", webhook),
        h("span", { class: "discreto" }, "Notificação no navegador: ative na tela do monitor depois de criar."),
        h("label", {}, recup, " Avisar quando voltar ao normal"),
        h("label", {}, repetir, " Avisar em toda checagem enquanto houver problema (não só na mudança)")),
      msg,
      h("div", { class: "linha" }, botao,
        h("button", { class: "botao secundario", type: "button", onclick: () => existente ? detalhe(existente.salvo) : listar() },
          "Cancelar")),
    );
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      msg.textContent = "";
      const dados = {
        nome: nome.value, tipo: tipo.value, urls: urlsDoTexto(urls.value), sitemap: comEsquema(sitemap.value),
        intervaloMin: Number(intervalo.value), ativo: ativo.checked, email: email.value, webhook: webhook.value.trim(),
        repetirProblemas: repetir.checked, avisarRecuperacao: recup.checked,
      };
      botao.disabled = true;
      try {
        if (existente) {
          const r = await api<{ monitor: MonitorPublico; aviso: string }>("/api/monitores",
            { acao: "editar", id: existente.salvo.id, chave: existente.salvo.chave, monitor: dados });
          lembrar({ ...existente.salvo, nome: r.monitor.nome });
          if (r.aviso) alert(r.aviso);
          void detalhe({ ...existente.salvo, nome: r.monitor.nome });
        } else {
          const r = await api<{ id: string; chave: string; monitor: MonitorPublico; aviso: string }>("/api/monitores",
            { acao: "criar", monitor: dados });
          const s = { id: r.id, chave: r.chave, nome: r.monitor.nome };
          lembrar(s);
          if (r.aviso) alert(r.aviso);
          void detalhe(s, false, true);
        }
      } catch (e) {
        msg.textContent = (e as Error).message;
        botao.disabled = false;
      }
    });
    mostrar(form);
  }

  // ------------------------------------------------------------ detalhe
  async function detalhe(s: Salvo, importar = false, recemCriado = false) {
    abrirAba();
    history.replaceState(null, "", `#monitor=${encodeURIComponent(s.id)}`);
    mostrar(h("p", { class: "discreto" }, "Carregando…"));
    let monitor: MonitorPublico;
    try {
      monitor = (await api<{ monitor: MonitorPublico }>("/api/monitores",
        { acao: recemCriado ? "checar" : "ver", id: s.id, chave: s.chave })).monitor;
    } catch (e) {
      return erroNaTela(e);
    }
    s = { ...s, nome: monitor.nome };
    if (importar || salvos().some((x) => x.id === s.id)) lembrar(s);
    const msg = h("p", { class: "discreto" });
    const executarAcao = async (acao: string, extra: Record<string, unknown> = {}) => {
      msg.textContent = "Aguarde…";
      try {
        const r = await api<{ monitor?: MonitorPublico; erros?: string[]; email?: string | null }>("/api/monitores",
          { acao, id: s.id, chave: s.chave, ...extra });
        if (acao === "testar-avisos") {
          const partes = [r.erros?.length ? `Falhas: ${r.erros.join(" | ")}` : "Avisos de teste enviados."];
          if (r.email) partes.push(`E-mail: ${r.email}.`);
          msg.textContent = partes.join(" ");
          return;
        }
        void detalhe(s);
      } catch (e) {
        msg.textContent = (e as Error).message;
      }
    };
    const problemas = monitor.resultados.filter((r) => ehProblema(r.categoria));
    const hist = h("div", { class: "historico", title: "Últimas checagens (vermelho = com problema)" });
    const maior = Math.max(1, ...monitor.historico.map((x) => x.total));
    for (const x of monitor.historico.slice(-60)) {
      hist.append(h("span", { class: x.problemas ? "ruim" : "", style: `height:${Math.max(8, (x.total / maior) * 100)}%`,
        title: `${quando(x.em)}: ${x.problemas} de ${x.total} com problema` }));
    }
    const tabela = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "URL"), h("th", { class: "num" }, "Status"),
      h("th", {}, "Categoria"), h("th", { class: "num" }, "Tempo (ms)"), h("th", {}, "Erro"))));
    const corpo = h("tbody", {});
    for (const r of [...problemas, ...monitor.resultados.filter((x) => !ehProblema(x.categoria))]) {
      const a = h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.url);
      corpo.append(h("tr", { class: CLASSE_CSS[r.categoria] ?? "" }, h("td", { title: r.url }, a),
        h("td", { class: "num" }, r.status === null ? "" : String(r.status)), h("td", {}, r.categoria),
        h("td", { class: "num" }, String(r.tempoMs)), h("td", {}, r.erro)));
    }
    tabela.append(corpo);
    const email = monitor.avisos.email;
    const campoLink = h("input", { type: "text", readonly: true, value: linkSecreto(s), class: "link-secreto" }) as HTMLInputElement;
    mostrar(
      h("div", { class: "linha" }, h("button", { class: "botao secundario", onclick: listar }, "← Monitores")),
      h("h2", {}, monitor.nome, " ", h("span", { class: `selo ${!monitor.ativo ? "parado" : problemas.length ? "ruim" : "ok"}` },
        !monitor.ativo ? "pausado" : problemas.length ? `${problemas.length} com problema` : monitor.ultimaEm ? "tudo OK" : "aguardando")),
      h("p", { class: "discreto" },
        `${monitor.tipo === "lista" ? `${monitor.urls.length} URL(s)` : `Sitemap: ${monitor.sitemap}`} · ` +
        `a cada ${rotuloIntervalo(monitor.intervaloMin)} · última checagem: ${quando(monitor.ultimaEm)} · ` +
        `próxima: ${monitor.ativo ? quando(monitor.proximaEm) : "pausado"}`),
      h("p", { class: "discreto" }, "Avisos: ",
        email ? `e-mail ${email.endereco}${email.confirmado ? " (confirmado)" : " (aguardando confirmação — veja sua caixa de entrada)"}` : "sem e-mail",
        " · ", monitor.avisos.webhook ? "webhook ligado" : "sem webhook",
        " · ", monitor.avisos.push ? `notificação em ${monitor.avisos.push} navegador(es)` : "sem notificação"),
      monitor.ultimoErroAviso && h("p", { class: "erro-msg" }, `Último erro ao avisar: ${monitor.ultimoErroAviso}`),
      h("div", { class: "linha" },
        h("button", { class: "botao", onclick: () => executarAcao("checar") }, "Checar agora"),
        h("button", { class: "botao secundario", onclick: () => ativarPush(s, msg) }, "Notificar neste navegador"),
        h("button", { class: "botao secundario", onclick: () => executarAcao("testar-avisos") }, "Testar avisos"),
        h("button", { class: "botao secundario", onclick: () => formulario({ salvo: s, monitor }) }, "Editar"),
        h("button", { class: "botao perigo", onclick: async () => {
          if (!confirm(`Excluir o monitor "${monitor.nome}"? Não dá para desfazer.`)) return;
          try {
            await api("/api/monitores", { acao: "excluir", id: s.id, chave: s.chave });
            esquecer(s.id);
            void listar();
          } catch (e) {
            msg.textContent = (e as Error).message;
          }
        } }, "Excluir")),
      msg,
      monitor.historico.length > 1 && hist,
      h("div", { class: "tabela-rolagem" }, tabela),
      h("div", { class: "aviso", style: "margin-top:12px" },
        h("strong", {}, "Link secreto deste monitor"),
        h("p", { class: "discreto" }, "Quem tiver este link pode ver, editar e excluir o monitor. Guarde-o: ele é a única forma de abrir o monitor em outro navegador."),
        h("div", { class: "linha" }, campoLink, h("button", { class: "botao secundario", onclick: async () => {
          try {
            await navigator.clipboard.writeText(campoLink.value);
            msg.textContent = "Link copiado.";
          } catch {
            campoLink.select();
          }
        } }, "Copiar"))),
    );
  }

  async function ativarPush(s: Salvo, msg: HTMLElement) {
    try {
      const cfg = await obterConfig();
      if (!cfg.pushChave) throw new Error("Notificações ainda não estão ativas neste servidor.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Este navegador não suporta notificações push.");
      }
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Permissão de notificação negada.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const chave = Uint8Array.from(atob(cfg.pushChave.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const assinatura = (await reg.pushManager.getSubscription()) ??
        await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
      await api("/api/monitores", { acao: "push", id: s.id, chave: s.chave, assinatura: assinatura.toJSON() });
      msg.textContent = "Pronto: este navegador vai receber as notificações deste monitor.";
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
  }

  // ------------------------------------------------------------ início
  const tratarHash = () => {
    const m = /^#monitor=([\w-]+)(?:&chave=([\w-]+))?/.exec(location.hash);
    if (!m) return void listar();
    const local = salvos().find((x) => x.id === m[1]);
    if (m[2]) return void detalhe({ id: m[1], chave: m[2], nome: local?.nome ?? "Monitor" }, true);
    if (local) return void detalhe(local);
    void listar();
  };
  window.addEventListener("hashchange", () => location.hash.startsWith("#monitor=") && tratarHash());
  tratarHash();
}
