/* Servidor HTTP local para os testes (as Functions só chegam nele com o loopback liberado). */

import http from "node:http";
import zlib from "node:zlib";

export interface Local {
  base: string;
  webhooks: unknown[];
  fechar(): Promise<void>;
}

const html = (corpo: string) => `<!doctype html><html><body>${corpo}</body></html>`;

export async function servidorLocal(): Promise<Local> {
  const webhooks: unknown[] = [];
  const srv = http.createServer((req, res) => {
    const caminho = (req.url ?? "/").split("?")[0];
    const base = `http://${req.headers.host}`;
    const enviar = (status: number, corpo = "", tipo = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": tipo, ...extra });
      res.end(req.method === "HEAD" ? undefined : corpo);
    };
    if (req.method === "POST") {
      let corpo = "";
      req.on("data", (b) => (corpo += b));
      req.on("end", () => {
        if (caminho === "/webhook") {
          webhooks.push(JSON.parse(corpo));
          return enviar(204);
        }
        enviar(500, "erro");
      });
      return;
    }
    switch (caminho) {
      case "/ok": return enviar(200, html("ok"));
      case "/redir": return enviar(301, "", "text/html", { Location: "/ok" });
      case "/redir2": return enviar(302, "", "text/html", { Location: `${base}/redir` });
      case "/loop": return enviar(302, "", "text/html", { Location: "/loop2" });
      case "/loop2": return enviar(302, "", "text/html", { Location: "/loop" });
      case "/para-interno": return enviar(302, "", "text/html", { Location: "http://169.254.169.254/latest/meta-data/" });
      case "/500": return enviar(500, html("erro"));
      case "/head405": return req.method === "HEAD" ? enviar(405) : enviar(200, html("get"));
      case "/lento": return void setTimeout(() => enviar(200, "lento"), 3000);
      case "/gzip": {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        return res.end(zlib.gzipSync(html('<a href="/ok">ok</a>')));
      }
      case "/robots.txt":
        return enviar(200, `User-agent: *\nDisallow: /site/privado\nSitemap: ${base}/sitemap_index.xml\n`, "text/plain");
      case "/site/": return enviar(200, html('<a href="a">A</a> <a href="/site/b#x">B</a> <img src="/img.png"> ' +
        '<a href="/site/privado">p</a> <a href="mailto:a@b.c">m</a> <a href="http://127.0.0.2:1/fora">fora</a>'));
      case "/site/a": return enviar(200, html('<a href="/site/b">B</a> <a href="/site/c">C</a>'));
      case "/site/b": return enviar(200, html('<a href="/site/">volta</a> <a href="/500">erro</a>'));
      case "/site/privado": return enviar(200, html('<a href="/site/secreto">s</a>'));
      case "/img.png": return enviar(200, "PNG", "image/png");
      case "/sitemap.xml": return enviar(200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<url><loc>${base}/ok</loc></url><url><loc>${base}/500</loc></url><url><loc><![CDATA[${base}/redir]]></loc></url></urlset>`,
        "application/xml");
      case "/sitemap_index.xml": return enviar(200, `<sitemapindex><sitemap><loc>${base}/sitemap.xml</loc></sitemap>` +
        `<sitemap><loc>${base}/sitemap2.xml.gz</loc></sitemap></sitemapindex>`, "application/xml");
      case "/sitemap2.xml.gz": {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        return res.end(zlib.gzipSync(`<urlset><url><loc>${base}/head405</loc></url></urlset>`));
      }
      default: return enviar(404, html("não achei"));
    }
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const porta = (srv.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${porta}`,
    webhooks,
    fechar: () => new Promise<void>((ok) => {
      srv.closeAllConnections();
      srv.close(() => ok());
    }),
  };
}
