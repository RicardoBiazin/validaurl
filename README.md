# ValidaURL

Confere se links respondem **OK (200)**. Há uma versão **desktop** (Windows, PySide6) e uma **web** (Netlify).

- **Lista de URLs**: cole o texto ou abra um arquivo TXT, CSV, XLSX ou HTML. A lista pode ser salva em arquivo, e o programa a grava sozinho enquanto você digita: ela volta na próxima vez, mesmo que o Windows desligue com ele aberto.
- **Rastrear site**: segue os links internos e checa tudo o que encontrar, inclusive imagens, CSS e JS. A coluna *Encontrado em* mostra em qual página está o link quebrado.
- **Sitemap**: aceita sitemap index e `.xml.gz`. Se você informar só o site, ele procura o sitemap no `robots.txt` e em `/sitemap.xml`.
- **Monitoramento**: repete a checagem a cada X minutos e avisa quando um link **passa a falhar** ou **volta ao normal**, por e-mail, webhook ou notificação.

Cada URL é checada assim:

1. Primeiro vai um HEAD. Se o HEAD falhar ou responder ≥ 400, a checagem repete com GET, porque muitos servidores tratam o HEAD errado.
2. A cadeia de redirects é seguida e registrada, com detecção de loop.
3. O User-Agent é de navegador.

| Categoria | Quando |
|---|---|
| OK | 2xx sem redirect |
| Redirecionado | 2xx depois de redirect(s) |
| Redirect (não seguido) | 3xx com "Seguir redirects" desligado |
| Erro 4xx / Erro 5xx | código final 4xx / 5xx |
| Falha | sem resposta: DNS, timeout, SSL, conexão recusada, loop de redirect |

## Desktop (Windows)

Baixe o `ValidaURL.exe` em [Releases](https://github.com/RicardoBiazin/validaurl/releases). Ele é portátil e dispensa instalação.

- **Repetir a cada X min**: se você fechar a janela, o programa vai para a bandeja e continua monitorando. Para sair de vez, use o menu do ícone na bandeja.
- **Avisos (e-mail, webhook, notificação)**:
  - **Notificação**: aparece na bandeja do Windows.
  - **E-mail**: vai pelo seu SMTP. No Gmail e no Outlook, use uma "senha de app". A senha fica gravada cifrada pela DPAPI do Windows.
  - **Webhook**: manda um JSON que já serve para Slack e Google Chat (`text`), Discord (`content`) e Teams, além dos dados estruturados.
- **Google Chat**: no espaço, abra *Apps e integrações → Webhooks → Adicionar webhook*, copie a URL (`https://chat.googleapis.com/v1/spaces/…`) e cole no campo Webhook. O ValidaURL manda só `{"text"}`, com o título em negrito, que é o formato que o Google Chat aceita. Para Discord e Slack, o formato também é ajustado sozinho.
- A exportação sai em XLSX (colorido), CSV (`;` com BOM, abre direto no Excel) ou JSON. Exporta só o que o filtro está mostrando.
- O divisor entre a lista e a tabela pode ser arrastado.

### Linha de comando

```
python -m validaurl urls.txt --saida resultado.xlsx
python -m validaurl --rastrear https://www.site.com.br --so-problemas
python -m validaurl --sitemap https://www.site.com.br/sitemap.xml --repetir 15 --webhook https://hooks.slack.com/...
```

O código de saída é `1` quando há algum problema, o que serve para Agendador de Tarefas e CI.

### Desenvolvimento

```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe app.py
.venv\Scripts\python.exe tests\rodar_todos.py   # suíte inteira, sem internet (servidores HTTP e SMTP locais)
build.bat                                       # suíte -> dist\ValidaURL.exe -> autoverificação do .exe
```

A versão fica em `validaurl/__init__.py`, `versao.txt`, `ValidaURL.manifest` e `web/package.json`. O teste confere que as quatro batem.

## Web

O endereço é https://validaurl.biazin.com.br. O navegador não consegue checar sites de terceiros por causa do CORS, então quem faz as requisições são as **Netlify Functions**. A fila de checagem fica no navegador, que manda lotes pequenos para as Functions.

- `/api/checar`: checa um lote de até 10 URLs.
- `/api/pagina`: devolve os links de uma página, as URLs de um sitemap ou as regras do robots.txt.
- `/api/monitores` e `/api/confirmar`: cuidam dos monitores e da confirmação de e-mail.
- A Function agendada `agendado` roda a cada 5 min e checa os monitores vencidos.

### Monitores (no servidor)

Os monitores ficam no Netlify Blobs e rodam mesmo com o navegador fechado. Não há login: quem cria o monitor recebe um **link secreto** (`#monitor=ID&chave=…`), e o servidor guarda só o SHA-256 da chave. Os avisos saem por:

- **e-mail**, pela API da Resend, com dupla confirmação e link de descadastro em todo e-mail;
- **webhook** (https);
- **notificação push** do navegador (Web Push/VAPID).

### Controle de uso indevido (robôs)

- **Portão anti-robô** (Edge Function): uma prova de trabalho (~1 s) troca a visita por um cookie assinado de 7 dias. Não usa serviço de terceiros.
- As **Functions** também conferem o cookie e a origem, e aceitam só POST do próprio site.
- **Limites por IP:**
  - 300 URLs/min em `/api/checar` e 120 páginas/min em `/api/pagina`;
  - `rateLimit` do Netlify em cada Function;
  - 5 monitores criados por dia por IP e 300 monitores no total;
  - até 25 URLs por monitor e intervalo mínimo de 5 min.
- **Contra SSRF:**
  - só http/https nas portas 80, 443, 8080 e 8443;
  - o IP é conferido **na conexão**, o que também barra DNS rebinding, e de novo a cada redirect;
  - ficam bloqueadas as redes privadas, loopback, link-local, metadados de nuvem e as faixas reservadas.
- O corpo das páginas nunca volta ao navegador, só o status e os links. O HTML é lido até 2 MB.
- `noindex`, `robots.txt` com `Disallow: /` e CSP restrita.

### Variáveis no Netlify

| Variável | Para quê |
|---|---|
| `PORTAO_SEGREDO` | obrigatória (32+ caracteres aleatórios). Sem ela, o site responde 500 de propósito |
| `RESEND_API_KEY`, `AVISO_REMETENTE` | e-mail dos monitores (opcional) |
| `VAPID_PUBLICA`, `VAPID_PRIVADA`, `VAPID_CONTATO` | notificação push (opcional): `npx web-push generate-vapid-keys` |

### Desenvolvimento

```
cd web
npm install
npm test                 # node --test: portão, SSRF, Functions, monitores (servidor HTTP local)
npm run typecheck
npm run build && netlify dev        # http://localhost:8888 (serve o build de verdade)
node scripts/fumaca.mjs --monitor   # Chrome headless contra o netlify dev
node scripts/fumaca.mjs --url=https://validaurl.biazin.com.br
netlify deploy --build --prod
```

## Licença

MIT.
