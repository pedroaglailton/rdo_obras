# server/ — backend do RDO de Campo

Guia completo (local + Render) está no **README.md da raiz do repositório**.
Este arquivo é só uma referência rápida de quem já está familiarizado.

```bash
npm install
npm start          # sobe em http://localhost:3000
PORT=8080 npm start # porta customizada
```

Gera `API_KEY` sozinho na primeira execução (salva em `api_key.txt`) se a
variável de ambiente `API_KEY` não estiver definida.

Deploy: veja `../README.md`, seção "Parte 2 — Publicando de verdade
(GitHub + Render)".
