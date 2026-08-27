# Histórico — 27/08/2026 — Fix Invalid Date no Mapa 3D

> Imagem: `Capturar.JPG` (MAPA 3D — Equipes e Locais) popup `Davi | Equipe 4 • sem local | Invalid Date` (círculo vermelho)

## Causa
`public/index.html:1015` fazia:
```js
new Date(p.atualizado_em+'Z').toLocaleTimeString('pt-BR')
```
- **Postgres** (`TIMESTAMPTZ`) já retorna `2026-08-27T13:19:14.123Z` → `+'Z'` vira `...ZZ` → `Invalid Date`
- **SQLite** retorna `2026-08-27 13:19:14` sem TZ → precisa `+'Z'` para ser válido
- Quando `atualizado_em` é `null`, também gerava `Invalid Date`

## Fix (commit 4ce7d8c)
- Helper `fmtHora(ts)` (`public/index.html:638`):
```js
function fmtHora(ts){
  if(!ts) return '';
  let d=new Date(ts);
  if(isNaN(d)) d=new Date(String(ts).replace(' ', 'T')+'Z');
  if(isNaN(d)) return '';
  return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
```
- Troca no marker: `fmtHora(p.atualizado_em)` em vez de `new Date(...'Z')` (`public/index.html:1015`)

## Verificação
- `Capturar.JPG` não deve mais mostrar `Invalid Date`; popup fica vazio ou `13:19`
- `git log --oneline -1` → `4ce7d8c fix: MAPA 3D Invalid Date...`
- Push `4ce7d8c main->origin` → Render redeploy

---
Para próxima IA: se voltar a aparecer `Invalid Date`, verificar `fmtHora` e formato `atualizado_em` (Postgres vs SQLite).
