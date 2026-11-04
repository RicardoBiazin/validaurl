/*
 * Aba Domínios: lista de domínios (guardada neste navegador), vencimento de cada um,
 * onde registrar ou renovar e avisos. Os avisos aparecem na página e, com permissão,
 * como notificação do navegador. Sem servidor agendado: só avisa com a página aberta.
 */

import {
  atualizarAvisos, CORES, diasAte, type DominioItem, type DominioVerificado, ROTULOS, situacao, sugestoesRegistro,
  textoAviso,
} from "./comum/dominios.ts";
import { api } from "./motor.ts";

const CHAVE = "vu_dominios";
const MAX_DOMINIOS = 20;
const INTERVALO_MS = 6 * 60 * 60 * 1000;
const ORDEM = ["vencido", "critico", "atencao", "ok", "desconhecido"];
const RE_DOMINIO = /^(?=.{4,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

let itens: DominioItem[] = carregar();
let verificando = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function carregar(): DominioItem[] {
  try {
    const dados = JSON.parse(localStorage.getItem(CHAVE) ?? "[]");
    return Array.isArray(dados) ? dados.filter((d) => d && typeof d.dominio === "string") : [];
  } catch {
    return [];
  }
}

function salvar() {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(itens));
  } catch { /* sem armazenamento: a lista vale só nesta aba */ }
}

function el(tag: string, texto = "", classe = ""): HTMLElement {
  const e = document.createElement(tag);
  if (texto) e.textContent = texto;
  if (classe) e.className = classe;
  return e;
}

function data(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("pt-BR");
}

function mostrarAviso(texto: string) {
  $("dominios-aviso").textContent = texto;
}

function cartao(item: DominioItem): HTMLElement {
  const dias = diasAte(item.expira);
  const sit = situacao(dias);
  const li = el("li", "", "cartao-dominio");
  li.style.background = CORES[sit];
  const quanto = dias === null ? "" : dias < 0 ? ` · venceu há ${-dias} dia(s)` : ` · ${dias} dia(s)`;
  const cab = el("div", "", "cab");
  cab.append(el("strong", item.dominio), el("span", ROTULOS[sit] + quanto));
  const info = el("div", `Vence em: ${data(item.expira) || item.erro || "—"} · Registrado com: ${item.registrador || "—"}`,
    "discreto");
  const onde = el("div", "", "discreto");
  onde.append("Onde registrar ou renovar: ");
  sugestoesRegistro(item.dominio).forEach(([nome, url], i) => {
    if (i) onde.append(" · ");
    const a = el("a", nome) as HTMLAnchorElement;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    onde.append(a);
  });
  const bt = el("button", "Remover", "botao secundario") as HTMLButtonElement;
  bt.addEventListener("click", () => remover(item.dominio));
  li.append(cab, info, onde, bt);
  return li;
}

function render() {
  const ordenados = [...itens].sort((a, b) => {
    const pa = ORDEM.indexOf(situacao(diasAte(a.expira)));
    const pb = ORDEM.indexOf(situacao(diasAte(b.expira)));
    return pa - pb || (diasAte(a.expira) ?? 1e9) - (diasAte(b.expira) ?? 1e9);
  });
  $("lista-dominios").replaceChildren(...ordenados.map(cartao));
  $("dominios-vazio").hidden = itens.length > 0;
  $<HTMLButtonElement>("bt-verificar-dominios").disabled = verificando || itens.length === 0;
}

function remover(dominio: string) {
  if (!confirm(`Tirar ${dominio} da lista?`)) return;
  itens = itens.filter((i) => i.dominio !== dominio);
  salvar();
  render();
}

function avisar(novos: DominioItem[]) {
  const textos = novos.map((i) => textoAviso(i));
  if (!textos.length) return;
  mostrarAviso(textos.join(" "));
  if ("Notification" in window && Notification.permission === "granted") {
    for (const t of textos) new Notification("ValidaURL: vencimento de domínio", { body: t });
  }
}

export async function verificarDominios() {
  if (verificando || !itens.length) return;
  verificando = true;
  render();
  mostrarAviso("Verificando vencimentos…");
  try {
    const { resultados } = await api<{ resultados: DominioVerificado[] }>("/api/dominios",
      { dominios: itens.map((i) => i.dominio) });
    const porDominio = new Map(resultados.map((r) => [r.dominio, r]));
    for (const item of itens) {
      const r = porDominio.get(item.dominio);
      if (r) Object.assign(item, { expira: r.expira, registrador: r.registrador, status: r.status, erro: r.erro,
        verificado: r.verificado });
    }
    const novos = atualizarAvisos(itens);
    salvar();
    mostrarAviso(`Verificado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`);
    avisar(novos);
  } catch (e) {
    mostrarAviso(`Não consegui verificar: ${(e as Error).message}`);
  } finally {
    verificando = false;
    render();
  }
}

function adicionar() {
  const ed = $<HTMLInputElement>("ed-dominio");
  const texto = ed.value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.+$/, "");
  if (!RE_DOMINIO.test(texto)) return mostrarAviso("Informe um domínio, por exemplo exemplo.com.br.");
  if (itens.some((i) => i.dominio === texto)) return mostrarAviso(`${texto} já está na lista.`);
  if (itens.length >= MAX_DOMINIOS) return mostrarAviso(`Limite de ${MAX_DOMINIOS} domínios na lista.`);
  itens.push({ dominio: texto, expira: null, registrador: "", status: [], erro: "", verificado: "", ultimoAviso: "" });
  ed.value = "";
  salvar();
  render();
  void verificarDominios();
}

async function pedirPermissao() {
  if (!("Notification" in window)) return mostrarAviso("Este navegador não mostra notificações.");
  const r = await Notification.requestPermission();
  mostrarAviso(r === "granted" ? "Avisos no navegador ativados (enquanto a página estiver aberta)."
    : "Permissão negada: os avisos continuam aparecendo nesta aba.");
}

export function iniciarDominios() {
  $("bt-adicionar-dominio").addEventListener("click", adicionar);
  $("ed-dominio").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") adicionar();
  });
  $("bt-verificar-dominios").addEventListener("click", () => void verificarDominios());
  $("bt-avisar-navegador").addEventListener("click", () => void pedirPermissao());
  render();
  if (itens.length) {
    void verificarDominios();
    setInterval(() => void verificarDominios(), INTERVALO_MS);
  }
}
