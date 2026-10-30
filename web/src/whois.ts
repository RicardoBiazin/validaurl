/*
 * Aba WHOIS: consulta /api/whois, mostra o relatório e o mapa do servidor.
 * Todo texto que vem da rede entra por textContent (nunca innerHTML).
 * O mapa é Leaflet (cdnjs) com tiles do OpenStreetMap; carrega só ao usar.
 */

import type { Endereco, Relatorio } from "../servidor/whois.ts";
import { api } from "./motor.ts";

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4";
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

let enderecos: Endereco[] = [];
let leaflet: Promise<any> | null = null;
let mapa: any = null;
let camada: any = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, texto = "", classe = ""): HTMLElement {
  const e = document.createElement(tag);
  if (texto) e.textContent = texto;
  if (classe) e.className = classe;
  return e;
}

/** Data ISO do RDAP em formato brasileiro (o texto original se não for data). */
function data(valor: string | null): string {
  if (!valor) return "";
  const t = Date.parse(valor);
  return Number.isNaN(t) ? valor : new Date(t).toLocaleDateString("pt-BR");
}

function item(rotulo: string, valor: string): HTMLElement {
  const li = el("li");
  li.append(el("strong", `${rotulo}: `), document.createTextNode(valor || "—"));
  return li;
}

function onde(g: Endereco["geo"]): string {
  return [g?.city, g?.regionName, g?.country].filter(Boolean).join(", ");
}

export function renderizar(rel: Relatorio, alvo: HTMLElement) {
  alvo.replaceChildren(el("h3", rel.alvo));
  if (rel.dominio) {
    const d = rel.dominio;
    const ul = el("ul");
    ul.append(item("Registrador", d.registrador), item("Criado em", data(d.criado)), item("Expira em", data(d.expira)),
      item("Última alteração", data(d.atualizado)), item("Status", d.status.join("; ")),
      item("Servidores DNS", d.nameservers.join(", ")));
    alvo.append(el("h4", "Registro (WHOIS/RDAP)"), ul);
  }
  if (rel.ip) {
    const i = rel.ip;
    const ul = el("ul");
    ul.append(item("Nome", i.nome), item("Organização", i.organizacao), item("País", i.pais), item("Faixa", i.faixa));
    alvo.append(el("h4", "Rede (RDAP)"), ul);
  }
  if (Object.keys(rel.dns).length) {
    const ul = el("ul");
    for (const [tipo, valores] of Object.entries(rel.dns)) ul.append(item(tipo, valores.join(", ")));
    alvo.append(el("h4", "Registros DNS"), ul);
  }
  const ul = el("ul");
  for (const end of rel.enderecos) {
    const li = el("li", end.ip + (end.ptr ? ` → ${end.ptr}` : "") + " — " + (onde(end.geo) || "sem dados de localização"));
    if (end.geo) li.append(el("div", `ISP: ${end.geo.isp ?? "—"} · AS: ${end.geo.as ?? "—"}`, "discreto"));
    ul.append(li);
  }
  alvo.append(el("h4", "Endereços e localização"), ul);
  for (const aviso of rel.avisos) alvo.append(el("p", aviso, "discreto"));
}

function carregarLeaflet(): Promise<any> {
  leaflet ??= new Promise((ok, falha) => {
    const css = el("link") as HTMLLinkElement;
    css.rel = "stylesheet";
    css.href = `${LEAFLET}/leaflet.css`;
    document.head.append(css);
    const js = el("script") as HTMLScriptElement;
    js.src = `${LEAFLET}/leaflet.js`;
    js.onload = () => ok((window as unknown as { L: unknown }).L);
    js.onerror = () => {
      leaflet = null;
      falha(new Error("não consegui carregar o mapa (sem internet?)"));
    };
    document.head.append(js);
  });
  return leaflet;
}

async function mostrarNoMapa(lat: number, lon: number, rotulo: string) {
  const L = await carregarLeaflet();
  const div = $("mapa");
  div.hidden = false;
  if (!mapa) {
    mapa = L.map(div);
    L.tileLayer(TILES, {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>',
    }).addTo(mapa);
    camada = L.layerGroup().addTo(mapa);
  }
  camada.clearLayers();
  L.circleMarker([lat, lon], { radius: 9, color: "#1f6feb", fillOpacity: 0.6 }).bindTooltip(rotulo).addTo(camada);
  mapa.setView([lat, lon], 10);
  mapa.invalidateSize();
}

function atualizarMapa() {
  const indice = Number($<HTMLSelectElement>("cb-ip-whois").value);
  const g = enderecos[indice]?.geo;
  const ok = !!g && g.lat !== null && g.lon !== null;
  $<HTMLButtonElement>("bt-mapa-whois").disabled = !ok;
  $("lbl-coord-whois").textContent = ok ? `${g!.lat!.toFixed(4)}, ${g!.lon!.toFixed(4)}` : "sem localização";
}

function preencherIps() {
  const sel = $<HTMLSelectElement>("cb-ip-whois");
  sel.replaceChildren();
  enderecos.forEach((end, i) => {
    const onde1 = onde(end.geo);
    sel.append(new Option(end.ip + (onde1 ? ` — ${onde1}` : ""), String(i)));
  });
  atualizarMapa();
}

function mostrarSelecionado() {
  const indice = Number($<HTMLSelectElement>("cb-ip-whois").value);
  const g = enderecos[indice]?.geo;
  if (!g || g.lat === null || g.lon === null) return;
  mostrarNoMapa(g.lat, g.lon, enderecos[indice].ip).catch((e: Error) => {
    $("lbl-coord-whois").textContent = e.message;
  });
}

export async function consultarWhois() {
  const ed = $<HTMLInputElement>("ed-whois");
  const bt = $<HTMLButtonElement>("bt-whois");
  const saida = $("whois-resultado");
  if (!ed.value.trim()) {
    saida.textContent = "Informe um domínio (ex.: exemplo.com.br) ou um IP.";
    return;
  }
  bt.disabled = true;
  bt.textContent = "Consultando…";
  saida.textContent = "Consultando WHOIS, DNS e localização…";
  try {
    const rel = await api<Relatorio>("/api/whois", { alvo: ed.value.trim() });
    enderecos = rel.enderecos;
    renderizar(rel, saida);
    preencherIps();
    mostrarSelecionado();
  } catch (e) {
    enderecos = [];
    saida.textContent = `Não consegui consultar: ${(e as Error).message}`;
    preencherIps();
  } finally {
    bt.disabled = false;
    bt.textContent = "Consultar";
  }
}

export function iniciarWhois() {
  $("bt-whois").addEventListener("click", () => void consultarWhois());
  $("ed-whois").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void consultarWhois();
  });
  $("cb-ip-whois").addEventListener("change", () => {
    atualizarMapa();
    mostrarSelecionado();
  });
  $("bt-mapa-whois").addEventListener("click", mostrarSelecionado);
}
