import "./estilo.css";
import { baixar, paraCsv, urlsDoArquivo } from "./arquivos.ts";
import { CLASSE_CSS, ehProblema, type Resultado, rotuloTipo, TODAS } from "./comum/classificar.ts";
import { comEsquema, urlsDoTexto } from "./comum/entradas.ts";
import { normalizar } from "./comum/links.ts";
import { ErroApi, rastrear, urlsDoSitemap, validarLista } from "./motor.ts";
import { iniciarMonitores } from "./monitores.ts";

declare const __VERSAO__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FILTRO_TODAS = "Todas";
const FILTRO_PROBLEMAS = "Só problemas";

let abaAtual = "lista";
let resultados: Resultado[] = [];
const indice = new Map<string, number>();
let controle: AbortController | null = null;
let ordem: { col: keyof Resultado | "redirects"; asc: boolean } | null = null;
let total = 0;
let pendenteRender = false;

$("versao").textContent = __VERSAO__;

// ------------------------------------------------------------ abas
function trocarAba(aba: string) {
  abaAtual = aba;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".abas button")) {
    b.setAttribute("aria-selected", String(b.dataset.aba === aba));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".painel")) p.hidden = p.dataset.painel !== aba;
  $("area-checagem").hidden = aba === "monitores";
  try {
    localStorage.setItem("vu_aba", aba);
  } catch { /* sem armazenamento: tudo bem */ }
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".abas button")) {
  b.addEventListener("click", () => trocarAba(b.dataset.aba!));
}

// ------------------------------------------------------------ entrada
const txtLista = $<HTMLTextAreaElement>("txt-lista");
const contarLista = () => {
  const n = urlsDoTexto(txtLista.value).length;
  $("qtd-lista").textContent = `${n} URL${n === 1 ? "" : "s"}`;
};
let salvarRascunho = 0;
txtLista.addEventListener("input", () => {
  contarLista();
  clearTimeout(salvarRascunho);
  salvarRascunho = window.setTimeout(() => {
    try {
      localStorage.setItem("vu_lista", txtLista.value.slice(0, 1_000_000));
    } catch { /* cheio ou bloqueado: só não lembra */ }
  }, 400);
});
try {
  txtLista.value = localStorage.getItem("vu_lista") ?? "";
} catch { /* ignore */ }
$("bt-salvar-lista").addEventListener("click", () => {
  const urls = urlsDoTexto(txtLista.value);
  if (!urls.length) return alert("A lista está vazia.");
  baixar("urls.txt", urls.join("\r\n") + "\r\n", "text/plain;charset=utf-8");
});
$("bt-limpar-lista").addEventListener("click", () => {
  txtLista.value = "";
  txtLista.dispatchEvent(new Event("input"));
});
$<HTMLInputElement>("arquivo").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const arquivo = input.files?.[0];
  input.value = "";
  if (!arquivo) return;
  try {
    const urls = await urlsDoArquivo(arquivo);
    if (!urls.length) return alert("Nenhuma URL encontrada no arquivo.");
    txtLista.value = urls.join("\n");
    contarLista();
  } catch (e) {
    alert(`Não consegui ler o arquivo: ${(e as Error).message}`);
  }
});

// ------------------------------------------------------------ tabela
const cbFiltro = $<HTMLSelectElement>("cb-filtro");
for (const t of [FILTRO_TODAS, FILTRO_PROBLEMAS, ...TODAS]) cbFiltro.add(new Option(t, t));
const SEM_TIPO = "(sem tipo)";
const TODOS_TIPOS = "Todos os tipos";
const cbTipo = $<HTMLSelectElement>("cb-tipo");
cbTipo.add(new Option(TODOS_TIPOS, TODOS_TIPOS));
const edBusca = $<HTMLInputElement>("ed-busca");
cbFiltro.addEventListener("change", agendarRender);
cbTipo.addEventListener("change", agendarRender);
edBusca.addEventListener("input", agendarRender);

/** A lista do filtro de tipo traz só os tipos que já apareceram; a escolha atual é mantida. */
function atualizarOpcoesTipo() {
  const tipos = [...new Set(resultados.map((r) => rotuloTipo(r.tipo) || SEM_TIPO))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const opcoes = [TODOS_TIPOS, ...tipos];
  const atuais = [...cbTipo.options].map((o) => o.value);
  if (opcoes.length === atuais.length && opcoes.every((v, i) => v === atuais[i])) return;
  const escolha = cbTipo.value;
  cbTipo.replaceChildren(...opcoes.map((t) => new Option(t, t)));
  cbTipo.value = opcoes.includes(escolha) ? escolha : TODOS_TIPOS;
}

function visiveis(): Resultado[] {
  const cat = cbFiltro.value;
  const tipo = cbTipo.value;
  const busca = edBusca.value.trim().toLowerCase();
  let lista = resultados.filter((r) => {
    if (cat === FILTRO_PROBLEMAS && !ehProblema(r.categoria)) return false;
    if (cat !== FILTRO_TODAS && cat !== FILTRO_PROBLEMAS && r.categoria !== cat) return false;
    if (tipo !== TODOS_TIPOS && (rotuloTipo(r.tipo) || SEM_TIPO) !== tipo) return false;
    if (busca) return [r.url, r.urlFinal, r.erro, r.encontradoEm, String(r.status ?? "")].join(" ").toLowerCase().includes(busca);
    return true;
  });
  if (ordem) {
    const { col, asc } = ordem;
    const valor = (r: Resultado) => col === "redirects" ? r.redirects.length : col === "status" ? (r.status ?? -1) : r[col];
    lista = [...lista].sort((a, b) => {
      const x = valor(a), y = valor(b);
      return (x! < y! ? -1 : x! > y! ? 1 : 0) * (asc ? 1 : -1);
    });
  }
  return lista;
}

function celulaLink(url: string): HTMLTableCellElement {
  const td = document.createElement("td");
  if (url) {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    td.title = url;
    td.append(a);
  }
  return td;
}

function celulaTexto(texto: string, classe = ""): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = texto;
  if (classe) td.className = classe;
  if (texto.length > 40) td.title = texto;
  return td;
}

/** Coluna Tipo: nome legível; o Content-Type original fica no balão de ajuda. */
function tipoCelula(r: Resultado): HTMLTableCellElement {
  const td = celulaTexto(rotuloTipo(r.tipo));
  if (r.tipo) td.title = `Content-Type: ${r.tipo}`;
  return td;
}

function render() {
  pendenteRender = false;
  atualizarOpcoesTipo();
  const corpo = document.querySelector("#tabela tbody")!;
  const lista = visiveis();
  const fragmento = document.createDocumentFragment();
  for (const r of lista.slice(0, 5000)) {
    const tr = document.createElement("tr");
    tr.className = CLASSE_CSS[r.categoria] ?? "";
    const redir = celulaTexto(r.redirects.length ? String(r.redirects.length) : "", "num");
    if (r.redirects.length) redir.title = r.redirects.map((x) => `${x.status} ${x.url}`).join("\n") + `\n→ ${r.status} ${r.urlFinal}`;
    tr.append(celulaLink(r.url), celulaTexto(r.status === null ? "" : String(r.status), "num"), celulaTexto(r.categoria), tipoCelula(r),
      celulaLink(r.urlFinal && r.urlFinal !== r.url ? r.urlFinal : ""), redir, celulaTexto(String(r.tempoMs), "num"),
      celulaTexto(r.erro), celulaLink(r.encontradoEm));
    fragmento.append(tr);
  }
  corpo.replaceChildren(fragmento);
  const contagem = new Map<string, number>();
  for (const r of resultados) contagem.set(r.categoria, (contagem.get(r.categoria) ?? 0) + 1);
  let resumo = [...contagem].map(([k, v]) => `${k}: ${v}`).join("  ·  ");
  if (lista.length !== resultados.length) resumo += `   (mostrando ${Math.min(lista.length, 5000)} de ${resultados.length})`;
  else if (lista.length > 5000) resumo += "   (mostrando as 5000 primeiras; use o filtro ou exporte)";
  $("resumo").textContent = resumo;
  atualizarBotoes();
}

function agendarRender() {
  if (!pendenteRender) {
    pendenteRender = true;
    requestAnimationFrame(render);
  }
}

for (const th of document.querySelectorAll<HTMLTableCellElement>("#tabela th")) {
  th.addEventListener("click", () => {
    const col = th.dataset.col as keyof Resultado;
    ordem = ordem?.col === col ? { col, asc: !ordem.asc } : { col, asc: true };
    for (const o of document.querySelectorAll("#tabela th")) o.removeAttribute("aria-sort");
    th.setAttribute("aria-sort", ordem.asc ? "ascending" : "descending");
    render();
  });
}

function adicionar(r: Resultado) {
  const k = normalizar(r.url);
  const i = indice.get(k);
  if (i !== undefined) {
    if (!r.encontradoEm) r.encontradoEm = resultados[i].encontradoEm;
    resultados[i] = r;
  } else {
    indice.set(k, resultados.length);
    resultados.push(r);
  }
  progresso(resultados.length, total);
  agendarRender();
}

function limpar() {
  resultados = [];
  indice.clear();
  total = 0;
  render();
}

function progresso(feitos: number, de: number, extra = "") {
  const barra = $("barra");
  if (!de) {
    barra.className = "indeterminado";
    barra.style.width = "";
  } else {
    barra.className = "";
    barra.style.width = `${Math.min(100, (feitos / Math.max(de, feitos)) * 100)}%`;
  }
  $("txt-progresso").textContent = de ? `${feitos} de ${Math.max(de, feitos)}${extra}` : extra;
}

function atualizarBotoes() {
  const rodando = controle !== null;
  $<HTMLButtonElement>("bt-validar").disabled = rodando;
  $<HTMLButtonElement>("bt-cancelar").disabled = !rodando;
  $<HTMLButtonElement>("bt-rechecar").disabled = rodando || !resultados.some((r) => ehProblema(r.categoria));
  $<HTMLButtonElement>("bt-csv").disabled = rodando || !resultados.length;
  $<HTMLButtonElement>("bt-json").disabled = rodando || !resultados.length;
}

// ------------------------------------------------------------ execução
async function executar(tarefa: (sinal: AbortSignal, avisos: string[]) => Promise<void>) {
  controle = new AbortController();
  const avisos: string[] = [];
  atualizarBotoes();
  progresso(0, total, total ? "" : "Começando…");
  try {
    await tarefa(controle.signal, avisos);
    const cancelado = controle.signal.aborted;
    $("barra").className = "";
    $("barra").style.width = "100%";
    $("txt-progresso").textContent = `${resultados.length} checadas${cancelado ? " (cancelado)" : ""}`;
    if (avisos.length) alert(avisos.join("\n"));
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      $("txt-progresso").textContent = "Erro";
      alert(e instanceof ErroApi && e.status === 403 ? "Sessão expirada: recarregue a página." : (e as Error).message);
    }
  } finally {
    controle = null;
    render();
  }
}

function opcoes() {
  return { seguirRedirects: $<HTMLInputElement>("ck-redirect").checked, soGet: $<HTMLInputElement>("ck-get").checked };
}

function validar() {
  if (controle) return;
  if (abaAtual === "lista") {
    const urls = urlsDoTexto(txtLista.value);
    if (!urls.length) return alert("Cole ou abra uma lista com pelo menos uma URL.");
    limpar();
    total = urls.length;
    void executar((sinal) => validarLista(urls.map((url) => ({ url })), opcoes(), adicionar, sinal));
  } else if (abaAtual === "rastreio") {
    // Um endereço por linha: cada um é checado e tem os links internos seguidos.
    const ed = $<HTMLTextAreaElement>("ed-site");
    const sites = ed.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map(comEsquema);
    if (!sites.length) return alert("Informe pelo menos um endereço do site.");
    for (const site of sites) {
      try {
        new URL(site);
      } catch {
        return alert(`Endereço inválido: ${site}`);
      }
    }
    ed.value = sites.join("\n");
    limpar();
    const op = {
      ...opcoes(),
      maxPaginas: Math.min(1000, Math.max(1, Number($<HTMLInputElement>("sp-paginas").value) || 200)),
      profundidade: Math.min(50, Math.max(0, Number($<HTMLInputElement>("sp-prof").value) || 0)),
      subdominios: $<HTMLInputElement>("ck-subdom").checked,
      externos: $<HTMLInputElement>("ck-externos").checked,
      robots: $<HTMLInputElement>("ck-robots").checked,
    };
    void executar((sinal, avisos) => rastrear(sites, op, adicionar, (p) => {
      total = p.agendados;
      progresso(resultados.length, total, `  ·  ${p.paginas} páginas abertas`);
    }, avisos, sinal));
  } else if (abaAtual === "sitemap") {
    const ed = $<HTMLInputElement>("ed-sitemap");
    const endereco = comEsquema(ed.value);
    try {
      new URL(endereco);
    } catch {
      return alert("Informe o endereço do sitemap ou do site.");
    }
    ed.value = endereco;
    limpar();
    void executar(async (sinal, avisos) => {
      $("txt-progresso").textContent = "Lendo o sitemap…";
      const urls = await urlsDoSitemap(endereco, avisos, sinal);
      if (!urls.length) {
        avisos.push("O sitemap não tem nenhuma URL.");
        return;
      }
      total = urls.length;
      await validarLista(urls.map((url) => ({ url, encontradoEm: endereco })), opcoes(), adicionar, sinal);
    });
  }
}

$("bt-validar").addEventListener("click", validar);
$("bt-cancelar").addEventListener("click", () => controle?.abort());
$("bt-rechecar").addEventListener("click", () => {
  const problemas = resultados.filter((r) => ehProblema(r.categoria));
  if (!problemas.length || controle) return;
  total = 0;
  void executar((sinal) => validarLista(problemas.map((r) => ({ url: r.url, encontradoEm: r.encontradoEm })), opcoes(),
    adicionar, sinal));
});
$("bt-csv").addEventListener("click", () => baixar("validaurl.csv", paraCsv(visiveis()), "text/csv;charset=utf-8"));
$("bt-json").addEventListener("click", () => baixar("validaurl.json",
  JSON.stringify({ geradoPor: `ValidaURL web ${__VERSAO__}`, resultados: visiveis() }, null, 2), "application/json"));
for (const id of ["ed-sitemap"]) {
  $(id).addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && validar());
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && abaAtual !== "monitores") validar();
  if (e.key === "Escape") controle?.abort();
});

// ------------------------------------------------------------ início
iniciarMonitores($("monitores"), () => trocarAba("monitores"));
let abaSalva = "lista";
try {
  abaSalva = localStorage.getItem("vu_aba") ?? "lista";
} catch { /* ignore */ }
trocarAba(location.hash.startsWith("#monitor") ? "monitores" : abaSalva);
contarLista();
render();
