# Histórico — 27/08/2026 (noite) — Unifica Materiais + Estoque em aba única

> Pasta: `D:\Nova pasta (2)\crm-obras` | Commit: `418087c` | Anterior: `5a9ba11`

## Pedido
- "vamos organizar a aba materias para que se use uma unica aba tente organizar estoque e materias juntos.."
- Antes havia 2 abas separadas: `Materiais` (catálogo lista.txt) e `Estoque` (por obra). Usuário quer única aba.

## Solução — visual único com sub-abas (criativo, igual Atividades)
- **Nav:** removido `<button data-view="estoque">` (`public/index.html:89`). Agora só `Materiais` (`public/index.html:89`).
- **View:** `view-materiais` única (`public/index.html:384`) com:
  - Header `border-left var(--accent)` → título `📦 Materiais & Estoque por Obra` + badge `itens • cat • alertas` + descrição `catálogo + controle por obra`
  - Sub-nav pills: `📦 Catálogo` (`btnMatCatalogo #0f3d4c`) e `📊 Estoque por Obra` (`btnMatEstoque #e1e5ea`) → `switchMateriaisTab(tab)` (`public/index.html:638`)
    - `materiais-sub-catalogo`: chips, busca, adicionar, lista organizada (mantido de antes)
    - `materiais-sub-estoque` (display:none inicial): obra select, import Materiais.xlsx, KPIs, alertas COMPRAR, add/edit, lista estimado vs consumo, ranking equipes/locais (todo conteúdo do antigo `view-estoque` movido)
- **JS:**
  - `loaders` (`public/index.html:630`): `materiais: carregarMateriaisUnificado` (remove `estoque: carregarEstoque`)
  - `switchMateriaisTab(tab)` alterna `display`, cores dos botões e `materiaisTabInfo`, chama `carregarEstoque()` quando `tab==='estoque'`
  - `carregarMateriaisUnificado()` chama `carregarMateriais()` + atualiza `estoqueBadgeMini` com `GET /api/obras/:id/materiais/consumo` (alertas da primeira obra) e sincroniza `countMateriais2/countCategorias2`
  - `carregarMateriais()` atualizado para também preencher `countMateriais2`/`countCategorias2` (`public/index.html:1518`)
- **Backend:** sem alteração (`obra_materiais` + endpoints mantidos). Apenas reorganização visual.

## Como usar (gestor)
1. `Painel → Materiais` → padrão abre **Catálogo** (busca rápida)
2. Clique **📊 Estoque por Obra** → selecione obra (ex: TJ-CE) → `Importar Materiais.xlsx` ou `Adicionar estimativa` → `↻ Atualizar` → KPIs/alertas/ranking

## Arquivos alterados
- `public/index.html:89,384-501,630,638,1518` — 139 ins / 93 del

## Próxima IA
- Se precisar voltar a 2 abas, basta desfazer `switchMateriaisTab` e recriar `view-estoque` + botão `data-view="estoque"` (ver commit `5a9ba11`).
- Todo estoque continua em `server.js:968` e `db.js:121` (`obra_materiais`).
