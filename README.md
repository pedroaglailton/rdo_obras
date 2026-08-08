# RDO de Campo — IPQ Tecnologia

Sistema de registro diário de obra (RDO) pra técnicos em campo, com
sincronização opcional pra um servidor central e um dashboard pro gestor
acompanhar o que está acontecendo nas obras.

## Como as três partes se encaixam

```
  app-campo/rdo-campo.html          server/server.js          dashboard/dashboard.html
  (celular do técnico,      ──▶     (Node.js + SQLite)   ◀──   (navegador do gestor,
   100% offline)             sincroniza quando           consulta            precisa de internet)
                              tem sinal (HTTP)
```

- **`app-campo/rdo-campo.html`** — um único arquivo HTML. O técnico abre no
  celular (ou salva como atalho na tela inicial). Cadastra obras, preenche
  RDO, tira foto, tudo salvo num banco SQLite dentro do próprio celular
  (via sql.js/WASM), sem precisar de internet pra nada disso. Se você
  configurar a sincronização (aba **Dados**), ele manda os RDOs pro servidor
  sozinho quando detecta conexão — sem sinal, ele guarda pendente e tenta de
  novo depois, sem travar nem perder nada.

- **`server/server.js`** — backend Node.js que recebe a sincronização de
  todos os técnicos (endpoint `/api/sync`), recebe um "estou aqui agora" de
  quem está com o app aberto (`/api/heartbeat`), e serve os dados agregados
  pro dashboard (`/api/dashboard`). Guarda tudo num arquivo SQLite central.

- **`dashboard/dashboard.html`** — outro arquivo HTML único, mas esse já
  pressupõe internet (carrega o mapa via OpenStreetMap). O gestor abre,
  aponta pro endereço do servidor + a chave de API, e vê técnicos ativos,
  mapa, indicadores e o histórico de RDOs recebidos. Atualiza sozinho a
  cada 30s.

---

## Parte 1 — Rodando tudo local (pra testar antes de publicar)

### 1.1. Subir o servidor

Precisa de [Node.js](https://nodejs.org) instalado (qualquer versão 18+).

```bash
cd server
npm install
npm start
```

Na primeira vez que roda, ele gera uma chave de API sozinho, mostra no
terminal e salva em `server/api_key.txt`:

```
>> Nova API_KEY gerada e salva em api_key.txt ...
>> API_KEY ativa: 3dcbc3df92ec4f6e985f30d2c888beb16f23d916a9a66133
>> RDO Central rodando em http://localhost:3000
```

Guarda essa chave — é ela que o app de campo e o dashboard vão usar. Pra
confirmar que subiu certo:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"hora":"..."}
```

Quer rodar numa porta diferente? `PORT=8080 npm start`.

### 1.2. Abrir o app de campo

É só abrir `app-campo/rdo-campo.html` direto no navegador (duplo clique, ou
`Arquivo > Abrir` no Chrome). Funciona local sem precisar de servidor
nenhum — o banco fica salvo no navegador (IndexedDB).

Pra testar a sincronização com o servidor que você acabou de subir:
1. Cadastre uma obra e um RDO normalmente.
2. Aba **Dados** → seção **Sincronização** → preenche:
   - **Seu nome (técnico):** qualquer nome, ex: "Teste"
   - **Endereço do servidor:** `http://localhost:3000`
   - **Chave de API:** a chave que apareceu no terminal
3. **Salvar configuração** → **Sincronizar agora**.
4. Deve aparecer "Sincronizado: X RDO(s) enviado(s) ✓".

> Se estiver testando em outro dispositivo na mesma rede (ex: celular
> testando contra o servidor rodando no seu PC), troque `localhost` pelo IP
> da máquina na rede local (ex: `http://192.168.0.10:3000`) e libere a porta
> 3000 no firewall.

### 1.3. Abrir o dashboard

Abre `dashboard/dashboard.html` direto no navegador. No topo, preenche o
mesmo **Endereço do servidor** (`http://localhost:3000`) e a **Chave de
API**, clica **Conectar**. Se você sincronizou algum RDO no passo anterior,
ele já deve aparecer ali — cards de técnico, mapa (se o RDO teve
localização), indicadores e a tabela de RDOs recentes.

---

## Parte 2 — Publicando de verdade (GitHub + Render)

### 2.1. Subir o código pro GitHub

Se você já recebeu este projeto como pasta/zip com o git já inicializado e
o remote configurado, só falta:

```bash
cd rdo_obras
git push -u origin main
```

Se o GitHub pedir senha e recusar, use um **Personal Access Token** no lugar:
GitHub → **Settings** → **Developer settings** → **Personal access tokens**
→ **Generate new token (classic)**, marca o escopo `repo`, gera, e cola o
token quando o `git push` pedir senha.

Se estiver começando do zero:

```bash
cd rdo_obras
git init
git add .
git commit -m "RDO de Campo"
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
git branch -M main
git push -u origin main
```

### 2.2. Deploy do servidor no Render

O repositório já vem com um `render.yaml` na raiz — isso é um **Blueprint**,
o Render lê esse arquivo e configura o serviço sozinho.

1. Entra em render.com, cria conta/faz login.
2. **New +** → **Blueprint**.
3. Conecta sua conta do GitHub (se ainda não tiver conectado) e seleciona o
   repositório.
4. O Render mostra o serviço `rdo-central` que o `render.yaml` descreve —
   confirma e clica em **Apply**.
5. Ele builda (`npm install`) e sobe (`npm start`) sozinho. Isso leva 1-3
   minutos na primeira vez.

O `render.yaml` já configura a env var `API_KEY` como **gerada
automaticamente pelo próprio Render** — você não precisa criar essa chave
na mão. Pra ver qual foi gerada: no painel do serviço → aba **Environment**.

**Se preferir configurar manualmente** (sem usar o Blueprint):
**New +** → **Web Service** → conecta o repositório → em **Root Directory**
coloca `server` → **Build Command**: `npm install` → **Start Command**:
`npm start` → adiciona a env var `API_KEY` com um valor forte (gere um com
`openssl rand -hex 24`, por exemplo).

### 2.3. ⚠️ Persistência de dados no Render

Por padrão, o `render.yaml` sobe no plano **Free** — nesse plano o Render
**não** oferece disco persistente. Isso quer dizer que o arquivo
`rdo_central.sqlite` some toda vez que o serviço reinicia ou você faz um
novo deploy. Serve bem pra testar o fluxo, mas **não** pra manter os RDOs
de verdade.

Antes de colocar técnicos reais sincronizando, suba pra um plano pago
(**Starter** ou superior) e descomente o bloco `disk` que já está no
`render.yaml` (comentado), junto com a env var `DB_PATH` associada:

```yaml
    disk:
      name: rdo-data
      mountPath: /var/data
      sizeGB: 1
    envVars:
      - key: DB_PATH
        value: /var/data/rdo_central.sqlite
```

Depois de editar, comita e dá push de novo — o Render redeploya sozinho.

### 2.4. Sobre o plano Free "dormir"

Serviços gratuitos no Render entram em modo de espera depois de um tempo
sem receber requisição. A primeira sincronização depois disso demora uns
30-50 segundos pra responder (é o serviço "acordando") — isso é normal, não
trava o app de campo, só atrasa um pouco a primeira tentativa do dia.

### 2.5. Configurar o app de campo e o dashboard pra apontar pro Render

Depois que o deploy terminar, o Render te dá uma URL, algo como:

```
https://rdo-central.onrender.com
```

E a chave fica em **Environment** → `API_KEY` no painel do serviço.

- No **app de campo** (`rdo-campo.html`, aba Dados → Sincronização): cola
  essa URL em "Endereço do servidor" e a chave em "Chave de API". Repete
  essa configuração em cada celular de cada técnico (uma vez só por
  aparelho).
- No **dashboard** (`dashboard.html`): mesma coisa, no topo da página.

### 2.6. Onde deixar o app de campo e o dashboard

Esses dois são só arquivos HTML estáticos — não precisam do Render, só o
`server/` precisa. Algumas opções simples:
- Manter local mesmo (abrir o arquivo direto) — funciona perfeitamente.
- Publicar como **GitHub Pages** (Settings → Pages → escolhe a branch) —
  aí todo mundo acessa por um link, sem precisar mandar o arquivo por
  WhatsApp toda vez que você atualizar algo.
- Hospedar junto com qualquer site estático que a IPQ já tenha.

---

## Referência rápida dos endpoints da API

| Rota | Método | Auth | O que faz |
|---|---|---|---|
| `/api/health` | GET | não | healthcheck simples |
| `/api/sync` | POST | `x-api-key` | recebe obras + RDOs de um técnico (upsert por `uid`, não duplica) |
| `/api/heartbeat` | POST | `x-api-key` | status "estou aqui agora" (técnico, obra, local, atividade, lat/lon) |
| `/api/dashboard` | GET | `x-api-key` | dados agregados que o dashboard consome |

## Sobre as fotos

As fotos **não** são enviadas ao servidor — ficam só no celular do técnico,
pra não pesar a sincronização quando o sinal é fraco (só a *contagem* de
fotos por RDO viaja). Pra consolidar as fotos de todos os técnicos, use a
exportação **Fotos (.zip)** local de cada app, ou o **Banco completo
(.sqlite)** de cada um + **Importar/Mesclar** num só.

## Solução de problemas

- **"Falha ao sincronizar" no app de campo** → confere se o endereço do
  servidor está certo (sem barra no final), se a chave bate com a que está
  em Environment no Render, e se o serviço não está "dormindo" (dá uma
  esperada de 1 minuto e tenta de novo).
- **Dashboard não carrega nada** → mesma checagem de URL/chave; abre o
  Console do navegador (F12) pra ver o erro exato.
- **401 (chave inválida)** em qualquer chamada → a chave configurada no
  app/dashboard não bate com a `API_KEY` atual do servidor. Copia de novo
  do painel do Render.
- **Dados sumiram depois de um deploy no Render** → você está no plano Free
  sem disco persistente — veja a seção 2.3.
