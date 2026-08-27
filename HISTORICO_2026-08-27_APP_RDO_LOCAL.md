# Histórico — 27/08/2026 — App RDO: local e cidade não preenchiam

> Imagem: usuário relatou "quando seleciono uma das obras que a equipe foi selecionada para executar os trabalhos, quando clico no local abre o preenchimento da rdo , so que fica o local e a cidade no form"

## Causa (`public/app.html:502,659,843`)
- `selecionarLocalEquipe(nome)` fazia `obraSel.dispatchEvent(change)` (async) e depois `setTimeout 300ms` para `f_local.value=nome` → race: `f_obra` handler ainda buscando `api('/api/equipe/.../locais')`, `<select>` ainda com `Carregando...`, `f_local` não tinha a opção → ficava vazio.
- `f_obra` handler só guardava `window._equipeLocaisCache` para TJ-CE com equipe, não guardava `window._obraLocaisCache` para outras obras → cache para `f_local` falhava.
- `f_local` handler fazia `api('/api/locais?busca=')` toda vez, lento e não usava cache → `f_cidade` ficava `` se API demorasse ou retornasse homônimos.

## Fix (commit 3f1b6df)
- `selecionarLocalEquipe` virou `async` com poll `while(tent<30) { await 120ms; hasOpt? }` até `<select>` ter a opção, seta `f_cidade` direto de `loc.comarca` do cache (`_equipeLocaisCache` ou `_obraLocaisCache` ou `loc`), fallback via `api('/api/locais?busca=')` se não no cache.
- `f_obra` handler: `window._obraLocaisCache = locais; if(isTJCE) window._equipeLocaisCache = locais;` (sempre guarda `obra` cache)
- `f_local` handler: tenta cache primeiro (`_obraLocaisCache` → `_equipeLocaisCache`), só fallback API, trata `__ver_todos/__outro` early return, garante `f_cidade` preenchida.

## Verificação
- App → Inicio → `Meus locais` → clicar em local → abre `+RDO` com `Obra` selecionada, `Local` preenchido e `Cidade` (comarca) preenchida.
- Testado para TJ-CE (via `equipe/:regiao/locais`) e HGF-GPON (via `obra_id`).

## Arquivos
- `public/app.html:502,659,843` — 54 ins / 19 del
- Commit `3f1b6df` → push `main->origin` → Render redeploy (app PWA)
