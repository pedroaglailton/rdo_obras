# Histórico — 27/08/2026 — Multi-obra + Visual Dashboard/RDOs + Fix 02161

> Pasta: `D:\Nova pasta (2)\crm-obras` | Repo: `https://github.com/pedroaglailton/rdo_obras.git` | Branch: `main`

## 1) Contexto do pedido
- Usuário relatou: planilha `TJCE_Mesclado_Geolocalizacao.xlsx` (971 linhas, 901 SEM, 17/19/18/14/4 por equipe) vs banco vs aba **Por Equipe** com `SEM EQUIPE 0 membro(s) • 0 ativo(s) • 0 RDOs | 2 LOCAIS 0 CÂMERAS` (depois `02161 LOCAIS | 001645 CÂMERAS | 00161/02161 7%`).
- Pedido seguinte: corrigir adequação multi-obra, redesenhar abas **Dashboard** e **RDOs** com visual igual à aba **Atividades**, commitar e push.

## 2) Diagnóstico (evidências locais 26/08)
- `data/crm.db` (SQLite `db.js:22`): 235 ativos, `obra_id=2 TJ-CE 234 + obra_id=4 HGF-GPON 1` + 1 órfão. `SELECT regiao,COUNT(*),SUM(cameras) GROUP BY regiao` → `'' 161/1645`, `Equipe1 17/174`, `Equipe2 19/148`, `Equipe3 18/140`, `Equipe4 14/363`, `TERCEIRIZADA 4/28`, `EQUIPE5 2/0` (`server.js:753` dedupe `COMARCA|NOME_IMOVEL|ENDERECO` reduz 901 SEM → 161 únicos).
- `TJCE_Mesclado_Geolocalizacao.xlsx:Sheet1` 972 linhas (header + 971): `SEM 901, Equipe1 17, Equipe2 19, Equipe3 16, Equipe4 14, TERCEIRIZADA 4`.
- `Supabase` (prod) `check_pg.js` com `Pool` direto: 237 ativos, `'' 161/1645/1609/32/4/161`, `null 2/0`, `EQUIPE5 2/0` — idêntico ao local, prova que import é deduplicado.
- Bug 1 — `EQUIPE5` vs `EQUIPE 5`: `equipes` tem `EQUIPE 5` (com espaço, id6), `locais.regiao` tinha `EQUIPE5` (sem espaço) → `server.js:1114 por-equipe` agrupava por `regiao` cru, criava 2 chaves: `EQUIPE5 2 locais 0 membros` + `EQUIPE 5 0 locais 1 membro`.
- Bug 2 — `02161`: `Postgres COUNT(*)/SUM()` retorna `string` (`'161'`), `server.js:1166 porRegiaoNorm[n].total_locais += r.total_locais` fazia `0 + "161" = "0161"` e ` "02" + "161" = "02161"` (ordem `null` 2 antes de `''` 161) → API retornava `"02161"` e `7%` (161/2161).

## 3) Correções aplicadas

### 3.1 `server.js` — helpers e normalização (linha 288)
```js
function normEquipe(s){ return (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,''); }
```
Resolve `EQUIPE5==EQUIPE 5` (remove acento/espaço/caixa).

### 3.2 `GET /api/dashboard/por-equipe` (`server.js:1154-1215`) — F2 + normalização
- `SELECT regiao, COUNT(*)... GROUP BY regiao` + `if(!r.regiao) r.regiao='SEM EQUIPE'` + `Number()` cast para `total_locais/cameras/fixa/analitica/lpr/com_coord` (Postgres string → Number).
- Merge por chave `normEquipe(r.regiao)`: `porRegiaoNorm[n].total_locais += Number(r.total_locais)` — soma numérica, não concat.
- `equipesByNorm` mapeia equipes por `normEquipe(nome)`, usa nome oficial da equipe como label.
- `membrosMap/rdoMap/presMap` com `Number(m.c)` e `{total:Number(r.total),hoje:Number(r.hoje)}`.
- Resultado: `SEM EQUIPE 163 (161+2 null) | 1645 câm | 1609/32/4 | 163/163 100%` (antes 02161/7%).

### 3.3 `GET /api/equipe/:regiao/locais` (`server.js:605-644`)
- Detecta `isSem = normEquipe(reg)===normEquipe('SEM EQUIPE')` → query `TRIM(l.regiao)=''` .
- Se equipe encontrada por `normEquipe`, filtra `l.equipe_id=? OR UPPER(REPLACE(regiao...))=...` + fallback JS `filter(normEquipe(l.regiao)===norm)` — corrige legado.

### 3.4 `initDb` backfill (`server.js:228-250`)
- Após `equipe_id` backfill, novo bloco normaliza `locais.regiao` para nome oficial da equipe:
```js
mapNorm[n]=equipe
if(eq && r.regiao!==eq.nome) UPDATE locais SET regiao=? WHERE regiao=?
UPDATE locais SET equipe_id=? WHERE regiao=? AND equipe_id IS NULL
```
- Também corrige `obra_id`/`local_id` já existente.

### 3.5 `GET /api/dashboard` (`server.js:1143-1151`)
- `Number((await db.prepare('SELECT COUNT(*) as c ...').get()).c)||0` para `totalObras/totalRdos/rdosHoje/totalUsuarios/totalEquipes` — evita `"01"` strings.

### 3.6 `public/index.html` — visual igual `Atividades` (`index.html:292`)
- **Dashboard** (`index.html:94-160`): header `border-left #0f3d4c` com badge `obras•equipes•usuários`, grid 4 cards coloridos (`#e3f2fd Obras / #e8f5e9 RDOs / #fff3e0 Equipes / #f3e5f5 Locais`) com `border-left`, `RDOs Recentes` em cards `border-left` por `atividade` cor (`Levantamento #0f3d4c` etc.) com avatar letra + `Ver →`.
- **RDOs** (`index.html:279-306`): header `border-left #0f3d4c` com `countRdos•hoje`, card `Buscar & Filtrar` com `obra/local/data/busca`, lista em cards `border-left` por atividade com `obra/cidade/horários/foto/parada`, `exportarRdosExcel()` `#1b5e20`.
- **Por Equipe** (`index.html:145-160`): header com badge + `select filtroPorEquipeObra` (`?obra_id=`) para isolar TJ-CE vs HGF-GPON, cards mantidos mas agora refletem merge normalizado.

## 4) Commits (git log --oneline)
```
ea37e49 fix: multi-obra normalizacao EQUIPE5==EQUIPE 5 + filtro obra em Por Equipe; feat: Dashboard e RDOs com visual profissional igual Atividades
e0e2105 fix: cast Postgres COUNT/SUM para Number em /api/dashboard e /api/dashboard/por-equipe (corrige 02161 string concat)
c9da8a2 feat: F3 multi-obra no app técnico ...
64a207c feat: vinculo obra-local dinamico ...
0b79d78 feat: F1 multi-obra ...
c65f2f6 feat: F0 multi-obra ...
```
Push: `ea37e49..e0e2105 main -> origin` (Render auto-deploy).

## 5) Estado atual do banco (27/08)
- Local `data/crm.db`: 235 → após fix `fix_db.js` 235 com `EQUIPE 5` 2 (corrigido de `EQUIPE5`), `SEM 161` (local) / `163` no prod (inclui 2 `NULL`).
- Prod `Supabase` (via `pg` Pool): 237 ativos, `SEM 163` após merge, `locais` 237 via `GET /api/locais`.
- `GET /api/dashboard/por-equipe` (prod) pós-fix: `SEM 163 | 1645 | 1609/32/4 | 163/163 100%` (verificado com `curl` + token `admin@ipq.com/admin123` em `https://crm-obras.onrender.com`).

## 6) Como reproduzir/verificar (para próxima IA)
```powershell
cd "D:\Nova pasta (2)\crm-obras"
node --check server.js
# local por-equipe (sem obra)
node -e "const db=require('./db');(async()=>{await new Promise(r=>setTimeout(r,800)); console.log(await db.prepare('SELECT regiao,COUNT(*) c FROM locais WHERE ativo=1 GROUP BY regiao').all())})()"
# prod por-equipe (com token)
node -e "fetch('https://crm-obras.onrender.com/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@ipq.com',senha:'admin123'})}).then(r=>r.json()).then(j=>fetch('https://crm-obras.onrender.com/api/dashboard/por-equipe',{headers:{Authorization:'Bearer '+j.token}}).then(r=>r.json()).then(console.log))"
```

## 7) Próximos passos (não feito)
- Dedupe import considerar `obra_id` para permitir mesmo endereço em obras distintas (hoje chave `COMARCA|NOME|ENDERECO` global).
- `obras.local_id` legado (1:1) → manter `NULL` para multi-obra e usar só `locais.obra_id` 1:N (HGF-GPON ainda tem `local_id=235`).
- Atribuir os 163 `SEM EQUIPE` via UI `Locais → Definir onde cada equipe vai trabalhar` (ainda pendente).

---
Gerado em 27/08/2026 para auditoria por outra IA. Arquivos alterados: `server.js:288,605-644,1143-1215` e `public/index.html:94-160,279-306,145-160`.
