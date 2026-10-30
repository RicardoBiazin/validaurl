import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { classificarAlvo, consultarWhois, dadosDoh, nomeReverso } from "../servidor/whois.ts";

const RDAP_DOMINIO = {
  ldhName: "EXEMPLO.COM.BR",
  status: ["client transfer prohibited"],
  events: [
    { eventAction: "registration", eventDate: "2001-03-01T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2030-03-01T00:00:00Z" },
    { eventAction: "last changed", eventDate: "2026-01-10T00:00:00Z" },
  ],
  nameservers: [{ ldhName: "NS1.EXEMPLO.NET" }],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Registro Exemplo Ltda"]]] }],
};
const RDAP_IP = { name: "GOOGLE", country: "US", startAddress: "8.8.8.0", endAddress: "8.8.8.255",
  entities: [{ roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Google LLC"]]] }] };
const GEO = { status: "success", country: "Brasil", regionName: "São Paulo", city: "São Paulo", lat: -23.55,
  lon: -46.63, isp: "Provedor X", org: "", as: "AS1 Teste" };

const original = globalThis.fetch;
const dns: Record<string, { type: number; data: string }[]> = {};

before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "rdap.org" && url.pathname === "/domain/exemplo.com.br") return Response.json(RDAP_DOMINIO);
    if (url.host === "rdap.org" && url.pathname === "/ip/8.8.8.8") return Response.json(RDAP_IP);
    if (url.host === "rdap.org") return new Response("não achei", { status: 404 });
    if (url.host === "cloudflare-dns.com") {
      return Response.json({ Answer: dns[`${url.searchParams.get("name")}|${url.searchParams.get("type")}`] ?? [] });
    }
    if (url.host === "ip-api.com") return Response.json(GEO);
    return new Response("", { status: 500 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = original;
});

test("classificação do alvo (igual ao desktop)", () => {
  assert.deepEqual(classificarAlvo("Exemplo.com.br"), { tipo: "dominio", alvo: "exemplo.com.br" });
  assert.deepEqual(classificarAlvo("https://exemplo.com.br/x?y=1"), { tipo: "dominio", alvo: "exemplo.com.br" });
  assert.deepEqual(classificarAlvo("8.8.8.8"), { tipo: "ip", alvo: "8.8.8.8" });
  for (const ruim of ["", "localhost", "192.168.0.1", "127.0.0.1", "10.1.2.3", "nao é dominio", "a..b"]) {
    assert.throws(() => classificarAlvo(ruim), Error, ruim);
  }
});

test("nome reverso para PTR (igual a ipaddress.reverse_pointer)", () => {
  assert.equal(nomeReverso("8.8.8.8"), "8.8.8.8.in-addr.arpa");
  // 2001:4860:4860::8888 -> nibbles invertidos
  const nibbles = ["8", "8", "8", "8", ...Array(17).fill("0"), "6", "8", "4", "0", "6", "8", "4", "1", "0", "0", "2"];
  assert.equal(nomeReverso("2001:4860:4860::8888"), nibbles.join(".") + ".ip6.arpa");
});

test("dadosDoh filtra o tipo pedido", () => {
  const resp = { Answer: [{ type: 1, data: "93.184.216.34" }, { type: 5, data: "cname.x." },
    { type: 16, data: '"v=spf1 -all"' }] };
  assert.deepEqual(dadosDoh(resp, "A"), ["93.184.216.34"]);
  assert.deepEqual(dadosDoh(resp, "TXT"), ["v=spf1 -all"]);
  assert.deepEqual(dadosDoh({}, "MX"), []);
});

test("consulta de domínio: RDAP, DNS, PTR e geolocalização", async () => {
  dns["exemplo.com.br|A"] = [{ type: 1, data: "8.8.8.8" }];
  dns["exemplo.com.br|MX"] = [{ type: 15, data: "10 mx.exemplo.com.br." }];
  dns["8.8.8.8.in-addr.arpa|PTR"] = [{ type: 12, data: "dns.google." }];
  const rel = await consultarWhois("exemplo.com.br");
  assert.equal(rel.tipo, "dominio");
  assert.equal(rel.dominio?.registrador, "Registro Exemplo Ltda");
  assert.equal(rel.dominio?.expira, "2030-03-01T00:00:00Z");
  assert.deepEqual(rel.dns.MX, ["10 mx.exemplo.com.br."]);
  assert.equal(rel.enderecos.length, 1);
  assert.deepEqual([rel.enderecos[0].ip, rel.enderecos[0].ptr], ["8.8.8.8", "dns.google"]);
  assert.equal(rel.enderecos[0].geo?.city, "São Paulo");
  assert.deepEqual(rel.avisos, []);
  for (const k of Object.keys(dns)) delete dns[k];
});

test("consulta de IP e domínio sem registro", async () => {
  const ip = await consultarWhois("8.8.8.8");
  assert.equal(ip.ip?.organizacao, "Google LLC");
  assert.equal(ip.ip?.faixa, "8.8.8.0 – 8.8.8.255");
  assert.equal(ip.enderecos[0].geo?.lat, -23.55);
  const sem = await consultarWhois("nao-existe.com.br");
  assert.equal(sem.dominio, null);
  assert.ok(sem.avisos.some((a) => a.includes("RDAP")));
  assert.ok(sem.avisos.some((a) => a.includes("Nenhum endereço")));
});
