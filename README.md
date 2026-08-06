# RDO de Campo — IPQ Tecnologia

Sistema de registro diário de obra (RDO) para técnicos em campo, com
sincronização opcional e dashboard de acompanhamento pro gestor.

## Estrutura do repositório

```
rdo_obras/
├── app-campo/
│   └── rdo-campo.html     ← app do técnico (abre no celular, 100% offline)
├── dashboard/
│   └── dashboard.html     ← dashboard do gestor (abre no navegador, precisa de internet)
├── server/
│   ├── server.js          ← backend (Node + Express + SQLite)
│   ├── package.json
│   └── README.md          ← instruções detalhadas de deploy (local, PM2, Render)
└── render.yaml             ← blueprint pra deploy automático no Render
```

## Como cada parte funciona

**`app-campo/rdo-campo.html`** — é só abrir esse arquivo no navegador do
celular do técnico (ou instalar como atalho na tela inicial). Funciona
100% offline: cadastra obras, preenche RDO, tira foto, tudo salvo num banco
SQLite local no próprio aparelho. Se configurado (aba **Dados** →
**Sincronização**) com o endereço do servidor e a chave de API, sincroniza
sozinho quando pega sinal — sem sinal, continua funcionando normal e
sincroniza depois.

**`server/`** — backend que recebe a sincronização de todos os técnicos e
serve os dados agregados pro dashboard. Veja `server/README.md` pra rodar
local ou fazer o deploy (inclui o passo a passo específico do Render).

**`dashboard/dashboard.html`** — abre no navegador (do escritório, com
internet), pede o endereço do servidor + a chave de API, e mostra técnicos
ativos, mapa, indicadores e o histórico de RDOs recebidos.

## Deploy rápido

1. Suba este repositório pro GitHub (branch `main`).
2. No Render: **New +** → **Blueprint** → conecta o repositório. Ele lê o
   `render.yaml` da raiz e sobe o serviço sozinho (o `rootDir: server`
   já aponta pra pasta certa).
3. Pega a URL gerada (ex: `https://rdo-central.onrender.com`) e a `API_KEY`
   (painel Render → Environment) e configura as duas no app de campo e no
   dashboard.
4. `dashboard/dashboard.html` pode ficar só no seu computador mesmo, ou você
   pode publicá-lo em algo simples como GitHub Pages — ele não precisa de
   servidor próprio, só faz chamadas pra API acima.

Detalhes de persistência de dados no plano Free do Render, HTTPS, PM2 etc.
estão em `server/README.md`.
