/* Leitura de TXT/CSV/HTML/XLSX no navegador e exportação CSV/JSON. */

import { unzipSync, strFromU8 } from "fflate";
import type { Resultado } from "./comum/classificar.ts";
import { deduplicar, urlsDoTexto } from "./comum/entradas.ts";
import { extrairLinks } from "./comum/links.ts";

/** Textos e hyperlinks de uma planilha .xlsx (strings compartilhadas, inline e links externos). */
export function textoDoXlsx(bytes: Uint8Array): string {
  const arquivos = unzipSync(bytes, {
    filter: (f) => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|worksheets\/_rels\/sheet\d+\.xml\.rels)$/.test(f.name),
  });
  const pedacos: string[] = [];
  const pegar = (xml: string, re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) pedacos.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  };
  for (const [nome, dados] of Object.entries(arquivos)) {
    const xml = strFromU8(dados);
    if (nome.endsWith(".rels")) pegar(xml, /Target="([^"]+)"[^>]*TargetMode="External"/g);
    else pegar(xml, /<t(?:\s[^>]*)?>([^<]*)<\/t>/g);
  }
  return pedacos.join("\n");
}

export async function urlsDoArquivo(arquivo: File): Promise<string[]> {
  const nome = arquivo.name.toLowerCase();
  if (/\.xlsx?m?$/.test(nome)) return urlsDoTexto(textoDoXlsx(new Uint8Array(await arquivo.arrayBuffer())));
  const texto = await arquivo.text();
  if (/\.html?$/.test(nome)) return deduplicar(extrairLinks(texto, "https://arquivo.local/").filter((u) => !u.startsWith("https://arquivo.local/")));
  // CSV/TSV: separadores viram quebra de linha e cada célula passa pelas mesmas regras.
  if (/\.(csv|tsv)$/.test(nome)) return urlsDoTexto(texto.replace(/[;\t|]/g, "\n").replace(/"/g, ""));
  return urlsDoTexto(texto);
}

const COLUNAS = ["URL", "Status", "Categoria", "URL final", "Redirects", "Tempo (ms)", "Erro", "Encontrado em"];

function celula(v: unknown): string {
  let s = String(v ?? "");
  // Fórmula embutida no CSV ("=HYPERLINK(...)") vinda de página de terceiros: neutralizar.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paraCsv(resultados: Resultado[]): string {
  const linhas = [COLUNAS.join(";")];
  for (const r of resultados) {
    linhas.push([r.url, r.status ?? "", r.categoria, r.urlFinal && r.urlFinal !== r.url ? r.urlFinal : "",
      r.redirects.map((x) => `${x.status} ${x.url}`).join(" → "), r.tempoMs, r.erro, r.encontradoEm].map(celula).join(";"));
  }
  return "﻿" + linhas.join("\r\n");
}

export function baixar(nome: string, conteudo: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
