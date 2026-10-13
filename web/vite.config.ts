import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pacote = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// O `vite preview` usa a MESMA CSP do netlify.toml, para pegar violação antes do deploy.
const netlify = readFileSync(new URL("./netlify.toml", import.meta.url), "utf8");
const csp = /Content-Security-Policy = "([^"]+)"/.exec(netlify)?.[1] ?? "";

export default defineConfig({
  define: { __VERSAO__: JSON.stringify(pacote.version) },
  preview: { headers: { "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff" } },
  build: { target: "es2022", outDir: "dist", sourcemap: false },
});
