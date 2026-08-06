# RDO Central — servidor de sincronização e dashboard

## O que é
Servidor Node.js simples que recebe os RDOs sincronizados pelos apps de campo
(rdo-campo.html) e serve os dados agregados para o dashboard (dashboard.html).

Banco: SQLite em arquivo único (`rdo_central.sqlite`), sem precisar instalar
banco de dados separado no servidor.

## Como rodar

```bash
npm install
npm start
```

Na primeira execução, uma chave de API é gerada automaticamente e salva em
`api_key.txt` (e também impressa no terminal). Essa é a chave que cada técnico
configura no app de campo (aba Dados → Sincronização) e que você configura no
dashboard.

Por padrão sobe em `http://localhost:3000`. Para rodar numa porta diferente:

```bash
PORT=8080 npm start
```

## Deixar no ar de verdade (produção)

Rode atrás de um processo gerenciado (recomendado: `pm2`) e coloque um proxy
reverso com HTTPS na frente (Nginx/Caddy), porque o app de campo e o dashboard
vão enviar a chave de API pela rede — sem HTTPS ela trafega em texto puro.

```bash
npm i -g pm2
pm2 start server.js --name rdo-central
pm2 save
```

Exemplo de bloco Nginx (ajuste o domínio):

```
server {
    listen 443 ssl;
    server_name rdo.suaempresa.com.br;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

## Deploy no GitHub + Render

Esse servidor mora na pasta `/server` dentro do repositório maior
(`rdo_obras`) — o `git init`/`push` e o `render.yaml` (com
`rootDir: server` apontando pra essa pasta) ficam na **raiz do
repositório**, não aqui dentro. Veja o passo a passo em `../README.md`.

**Caminho mais rápido no Render — Blueprint:** **New +** → **Blueprint** →
conecta o repositório → ele lê o `render.yaml` da raiz e sobe o serviço
sozinho, já gerando a `API_KEY` como variável de ambiente.

**Manual, se preferir:** **New +** → **Web Service** → conecta o repositório
→ define **Root Directory** como `server` → Build Command `npm install` →
Start Command `npm start` → adiciona a env var `API_KEY` com um valor forte
(ex: gere com `openssl rand -hex 24`).

### ⚠️ Sobre persistência de dados no Render

Por padrão o `render.yaml` sobe no plano **Free**, sem disco persistente:
o arquivo `.sqlite` é apagado toda vez que o serviço reinicia ou você faz um
novo deploy. Bom pra testar o fluxo, mas **não** pra manter os RDOs de
verdade. Antes de colocar técnicos reais sincronizando, suba pra um plano
pago (Starter ou superior) e descomente o bloco `disk` no `render.yaml`
(junto com a env var `DB_PATH` associada) — aí os dados sobrevivem a
reinícios e deploys.

O plano Free também "dorme" depois de um tempo sem uso — a primeira
sincronização depois disso demora uns 30-50s pra responder (o serviço
"acorda"), o que é normal e não trava o app de campo, só demora um pouco
mais na primeira tentativa.

### Depois do deploy

Pegue a URL que o Render te dá (algo como `https://rdo-central.onrender.com`)
e a chave de API (em **Environment** no painel do Render, variável `API_KEY`).
Use as duas no app de campo (aba Dados → Sincronização) e no dashboard.

## Endpoints

- `POST /api/sync` — recebe obras + RDOs de um técnico (upsert por `uid`, não duplica)
- `POST /api/heartbeat` — status "estou aqui agora" (técnico, obra, local, atividade, lat/lon)
- `GET /api/dashboard` — dados agregados para o dashboard
- `GET /api/health` — healthcheck simples, sem autenticação

Todas as rotas `/api/sync`, `/api/heartbeat` e `/api/dashboard` exigem o
header `x-api-key` com a chave gerada.

## Fotos
As fotos NÃO são enviadas ao servidor (ficam só no celular, pra não pesar a
sincronização com sinal fraco). Só a contagem de fotos por RDO é enviada.
Se quiser consolidar as fotos de todos, continue usando a exportação
"Fotos (.zip)" local de cada app e o `.sqlite` completo via
"Banco completo (.sqlite)" + "Importar/Mesclar".
