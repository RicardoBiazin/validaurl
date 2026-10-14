import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { classificar, ehProblema, rotuloTipo } from "../src/comum/classificar.ts";
import { comEsquema, urlsDoTexto } from "../src/comum/entradas.ts";
import { ehRecurso, extrairLinks, mesmoSite, normalizar, regrasRobots, robotsPermite } from "../src/comum/links.ts";
import { paraCsv, textoDoXlsx } from "../src/arquivos.ts";

test("classificação igual à do desktop", () => {
  assert.equal(classificar(200, 0), "OK");
  assert.equal(classificar(200, 2), "Redirecionado");
  assert.equal(classificar(301, 0, false), "Redirect (não seguido)");
  assert.equal(classificar(404, 0), "Erro 4xx");
  assert.equal(classificar(503, 0), "Erro 5xx");
  assert.equal(classificar(null, 0), "Falha");
  assert.equal(ehProblema("Redirecionado"), false);
  assert.equal(ehProblema("Erro 4xx"), true);
});

test("extração de links", () => {
  const html = '<base href="https://x.com/dir/"><a href="p1">1</a><a href="/p2#f">2</a><a href="p1#z">dup</a>' +
    '<a href="mailto:a@b.c">m</a><a href="javascript:x()">j</a><img src="i.png" srcset="i2.png 2x, i3.png 3x">' +
    '<link rel="preconnect" href="https://cdn.x.com"><link rel="stylesheet" href="s.css">' +
    '<a href="ftp://x.com/f">ftp</a><a href="#topo">topo</a><!-- <a href="/comentado"> -->' +
    '<script>var s = "<a href=\'/dentro-do-script\'>";</script><a href="/q?a=1&amp;b=2">amp</a>';
  assert.deepEqual(extrairLinks(html, "https://x.com/"), [
    "https://x.com/dir/p1", "https://x.com/p2", "https://x.com/dir/i.png", "https://x.com/dir/i2.png",
    "https://x.com/dir/i3.png", "https://x.com/dir/s.css", "https://x.com/q?a=1&b=2"]);
});

test("normalização e mesmo site", () => {
  assert.equal(normalizar("HTTPS://X.com:443?b=2&a=1#f"), "https://x.com/?a=1&b=2");
  assert.ok(mesmoSite("https://www.x.com/a", "https://x.com"));
  assert.ok(!mesmoSite("https://blog.x.com/a", "https://x.com"));
  assert.ok(mesmoSite("https://blog.x.com/a", "https://x.com", true));
  assert.ok(!mesmoSite("https://xx.com/a", "https://x.com", true));
  assert.ok(ehRecurso("https://x.com/a/foto.JPG"));
  assert.ok(!ehRecurso("https://x.com/a/pagina"));
});

test("URLs de texto livre (mesmas regras do desktop)", () => {
  const texto = "veja https://a.com/x, e (https://b.com/y).\nwww.c.com.br/pagina\nd.org\nemail@e.com\nhttps://a.com/x\n" +
    "https://pt.wikipedia.org/wiki/Java_(linguagem)\ntexto qualquer\n";
  assert.deepEqual(urlsDoTexto(texto), ["https://a.com/x", "https://b.com/y", "https://www.c.com.br/pagina", "https://d.org",
    "https://pt.wikipedia.org/wiki/Java_(linguagem)"]);
  assert.equal(comEsquema("site.com"), "https://site.com");
  assert.equal(comEsquema("http://site.com"), "http://site.com");
});

test("robots.txt", () => {
  const r = regrasRobots("User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /privado\nAllow: /privado/livre\n" +
    "Disallow: /*.pdf$\nSitemap: https://x.com/s.xml\n");
  assert.deepEqual(r.sitemaps, ["https://x.com/s.xml"]);
  assert.ok(robotsPermite(r, "https://x.com/"));
  assert.ok(!robotsPermite(r, "https://x.com/privado/a"));
  assert.ok(robotsPermite(r, "https://x.com/privado/livre/a"));
  assert.ok(!robotsPermite(r, "https://x.com/doc/a.pdf"));
  assert.ok(robotsPermite(r, "https://x.com/doc/a.pdf?x=1"));
});

test("planilha .xlsx lida no navegador (textos e hyperlinks)", () => {
  const zip = zipSync({
    "xl/sharedStrings.xml": strToU8('<sst><si><t>Site</t></si><si><t>https://x.com/1?a=1&amp;b=2</t></si><si><t xml:space="preserve">clique</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row><c t="inlineStr"><is><t>www.y.com.br</t></is></c></row></sheetData></worksheet>'),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8('<Relationships><Relationship Id="r1" Target="https://z.com/link" TargetMode="External"/></Relationships>'),
  });
  assert.deepEqual(urlsDoTexto(textoDoXlsx(zip)).sort(),
    ["https://www.y.com.br", "https://x.com/1?a=1&b=2", "https://z.com/link"].sort());
});

test("CSV com BOM, ';' e sem fórmula injetada", () => {
  const csv = paraCsv([{ url: "=HYPERLINK(\"http://mal\")", status: 404, categoria: "Erro 4xx", urlFinal: "", redirects: [],
    tempoMs: 3, erro: "Not; Found", tipo: "", metodo: "GET", encontradoEm: "" }]);
  assert.ok(csv.startsWith("﻿URL;Status;Categoria;Tipo;"));
  assert.match(csv, /\n"'=HYPERLINK\(""http:\/\/mal""\)";404/);
  assert.match(csv, /"Not; Found"/);
});

test("tipo de conteúdo com nome legível (igual ao desktop)", () => {
  assert.equal(rotuloTipo("text/html"), "HTML");
  assert.equal(rotuloTipo("application/pdf"), "PDF");
  assert.equal(rotuloTipo("image/png"), "PNG");
  assert.equal(rotuloTipo("TEXT/HTML"), "HTML", "sem diferenciar maiúsculas");
  assert.equal(rotuloTipo(""), "", "servidor que não informou o tipo fica vazio");
  assert.equal(rotuloTipo("application/x-algo-novo"), "application/x-algo-novo", "desconhecido mostra o original");
  const csv = paraCsv([{ url: "https://x.com/a.pdf", status: 200, categoria: "OK", urlFinal: "", redirects: [],
    tempoMs: 5, erro: "", tipo: "application/pdf", metodo: "HEAD", encontradoEm: "" }]);
  assert.match(csv, /;OK;PDF;/);
});
