# Histórico — 27/08/2026 (tarde) — Estoque por Obra: Estimativa vs Consumo

> Pasta: `D:\Nova pasta (2)\crm-obras` | Repo: `https://github.com/pedroaglailton/rdo_obras.git`

## Pedido
- Analisar `Materiais.xlsx` (Planilha1 com 52 itens, quantidade solicitada, menor valor/fornecedor; Plan1 com 72 locais, 864 câmeras) e entender que cada obra tem estimativa própria.
- Criar lógica dinâmica para acompanhar uso por equipes/locais via RDOs e saber quando comprar mais.
- Usar criatividade para jeito dinâmico.

## Análise Materiais.xlsx
- **Planilha1** (53 linhas, header `Item` na linha 1): colunas `Descrição do material | Unidade | Quantidade solicitada | Carmehil Valor Unitário | ... | Menor valor Total | Fornecedor com menor preço`. Ex: `ABRAÇADEIRA DE NYLON 1500 UND`, `BUCHA Nº8 17712 UND`. É a BOM da ETAPA 1.
- **Plan1** (16 linhas): `1° ETAPA | 72 Locais | Média 12 câmeras/local | Câmeras 864 | Média infra por câmera 34560 | Materiais: Eletroduto 11520, Abraçadeira 46080...` — estimativa derivada por local.
- **lista.txt** (106 itens) é catálogo geral, já importado em `materiais` com `categoria` auto.

## Modelo criado (dinâmico e criativo)
- Nova tabela `obra_materiais` (1 obra → N materiais estimados):
```sql
obra_materiais(id, obra_id FK obras, material_nome TEXT, unidade, quantidade_estimada REAL, valor_unitario REAL, fornecedor, etapa, observacao, criado_em, UNIQUE(obra_id, material_nome))
```
- Consumo vem de `rdos.materiais_json` (array `{nome,qtd}` por RDO) filtrado por `obra_id`.
- **Cálculo por material estimado:**
  - `consumido = SUM(qtd)` onde `norm(nome) == norm(material_nome)`
  - `saldo = estimado - consumido`
  - `pct = consumido/estimado*100`
  - `mediaPorLocal = consumido / locaisConcluidos` (locais com ≥1 RDO)
  - `projecaoRestante = mediaPorLocal * locaisPendentes`
  - `necessidade = max(0, projecao - saldo)`
  - `status`: `estourado (>estimado) | critico (saldo≤0 ou pct≥90) | atencao (pct≥70) | comprar (necessidade>0) | ok | extra (consumido sem estimativa)`
  - `sugestaoCompra = ceil(max(necessidade, estimado*0.2 - saldo) + estimado*0.05)` (20% buffer +5% margem)
- **Extras:** materiais consumidos sem estimativa aparecem como `extra` com `precisaComprar=true`.
- **Ranking:** por equipe (soma qtd por `equipe_json` do RDO) e por local (`local` do RDO) — top 10.
- **Resumo obra:** `totalValorEstimado/Consumido/Saldo`, `pctMedio`, `alertas`, `totalLocais/concluidos/pendentes`, `rdosTotal`.

## Backend
- `server.js:95` `SQL_CREATE` adiciona `obra_materiais` + `idx_obra_materiais_obra`; `db.js:121` Postgres `CREATE TABLE obra_materiais ... UNIQUE(obra_id, material_nome)` + `RLS`.
- Endpoints (`server.js:968-1150`):
  - `GET /api/obras/:obra_id/materiais/estimativas` — lista
  - `POST /api/obras/:obra_id/materiais/estimativas` — upsert por `UPPER(material_nome)` (cria no catálogo `INSERT OR IGNORE`)
  - `PUT /api/obra-materiais/:id` / `DELETE /api/obra-materiais/:id`
  - `POST /api/obras/:obra_id/materiais/importar` — body `{linhas:[...]}` mapeia `Descrição do material/Unidade/Quantidade solicitada/Menor valor Total/Fornecedor` → `valor_unitario = valorTotal/qtd`
  - `GET /api/obras/:obra_id/materiais/consumo` — retorna `{resumo, itens, alertas, rankingEquipes, rankingLocais}` com lógica acima.

## Frontend — nova aba `Estoque` (visual igual `Atividades` `index.html:358`)
- Tab `public/index.html:89` `<button data-view="estoque">Estoque</button>` + `loaders estoque: carregarEstoque` (`index.html:615`).
- View `view-estoque` (`index.html:411-502`):
  - Header `border-left #0f3d4c` com `estoqueObra` select + badge `materiais•alertas•RDOs`
  - Card import `fileEstoque` (XLSX via `XLSX.read`) — detecta header `Descrição do material` (linha variável), cria `linhas` e `POST /importar`
  - KPIs 4 cards: `Valor Estimado | Consumido | Saldo | Alertas` + `locaisConcluidos/pendentes`
  - Alertas card `border-left #c62828` lista `!` com `sugestaoCompra` e valor
  - Card add/edit estimativa (material com datalist do catálogo, unidade, qtd, valor, fornecedor, etapa)
  - Lista `listaEstoque` com busca `buscaEstoque` + filtro `filtroStatusEstoque` (todos/ok/atencao/critico/estourado/extra/comprar), progress bar por `pct`, `porEquipe` chips, `porLocal`, botões Editar/Excluir
  - Ranking 2 colunas `rankingEquipes`/`rankingLocais`
- JS `public/index.html:1561-1784`: `carregarEstoque()`, `filtrarEstoque()`, `importarEstoque()` (XLSX header detection), `salvarEstimativa()`, `cancelarEstimativa()`, `editarEstimativa()`, `excluirEstimativa()`

## Teste local
- Script `test_estoque.js` criou `obra_materiais` (1500 abraçadeiras, 17712 buchas), RDO fake com 100 abraçadeiras → verificado `pct 7% saldo 1400`, `BUCHA 0%`. Limpeza com `cleanup_test.js` removeu. `node --check server.js` ok.

## Como usar (gestor)
1. Aba `Estoque` → selecione obra (ex: `TJ-CE`)
2. `Importar Estimativa` → selecione `Materiais.xlsx` → 52 materiais importados para obra
3. Técnicos registram RDOs com materiais (app `+RDO` → busca material → qtd)
4. Volte em `Estoque` → `↻ Atualizar` → veja KPIs, alertas `COMPRAR`, lista com `pct/saldo/projeção`, ranking por equipe/local
5. Edite estimativa ou adicione material avulso; exclua se necessário
6. Quando `saldo <20%` ou `projeção > saldo`, sistema sugere compra com quantidade e valor

## Arquivos alterados
- `server.js:95,143,968-1150` e `db.js:121-130`
- `public/index.html:89,411-502,615,1561-1784`

## Próximos (opcional)
- Integrar com `locais.etapa` para estimativa por etapa/local
- Gráfico burn-down por data (consumo acumulado vs tempo)
- Export Excel do estoque (estimativa vs consumo vs projeção)
- Notificação push quando `alertas>0`

---
Gerado para próxima IA auditar. Commits a seguir.
