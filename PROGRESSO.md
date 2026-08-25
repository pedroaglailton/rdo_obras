# CRM Obras - Progresso da Sessao

## Resumo do Projeto
Sistema de gestao de obras para IPQ Tecnologia, com foco em RDO (Registro Diario de Obra) para o Tribunal de Justica do Ceara (TJ-CE).

## Stack Tecnica
- **Backend:** Node.js + Express + SQLite (better-sqlite3) + Socket.io
- **Frontend:** HTML/CSS/JS puro (sem framework)
- **Banco:** SQLite com 11 tabelas
- **Porta:** 8080

## Login Padrao
- **Email:** `admin@ipq.com`
- **Senha:** `admin123`

---

## Estrutura de Arquivos

```
D:\Nova pasta (2)\crm-obras\
├── server.js              (backend completo)
├── package.json
├── data/
│   └── crm.db            (banco SQLite)
├── uploads/               (fotos dos RDOs)
├── public/
│   ├── index.html         (painel do gestor)
│   ├── app.html           (app do tecnico)
│   ├── login.html         (login/cadastro)
│   ├── sw.js              (service worker PWA)
│   ├── manifest.json
│   └── favicon.ico
└── Imoveis_TJCE.xlsx      (planilha de imoveis)
```

---

## Tabelas do Banco (11 tabelas)

1. **usuarios** - id, nome, email, senha, perfil, equipe_id, ativo
2. **equipes** - id, nome, cor, ativo
3. **obras** - id, nome, local_id, comarca, prazo_dias, data_inicio, status, progresso, responsavel, descricao, ativo
4. **locais** - id, nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras, ativo
5. **etapas** - id, obra_id, nome, ordem, status, data_inicio, data_fim, observacoes
6. **materiais** - id, nome, categoria, ativo (UNIQUE constraint no nome)
7. **rdos** - id, obra_id, data, local, atividade, equipe_json, materiais_json, entrada_manha, saida_manha, entrada_tarde, saida_tarde, parou, motivo_parada, switch_instalado, nom_switch, local_switch, camera_instalada, nom_camera, local_camera, fotos_json, usuario_id, usuario_nome
8. **checkins** - id, obra_id, tecnico, tecnico_id, tipo, latitude, longitude
9. **chat_mensagens** - id, obra_id, remetente, remetente_id, mensagem
10. **alertas_sla** - id, obra_id, tipo, mensagem, lido
11. **presenca** - id, usuario_id, usuario_nome, equipe_id, latitude, longitude, obra_id, local_nome, atualizado_em

---

## Dados Importados

### Imoveis TJCE (232 registros do Excel)
- Arquivo: `Imoveis_TJCE.xlsx`
- Colunas: Name, Comarca, Nome do imovel, Tipo, Ocupacao, Endereco, Area construida, Longitude, Latitude, Google Maps Link, Street View Link, Cameras
- Importados para tabela `locais`

### Materiais (106 itens do lista.txt)
- Arquivo: `lista.txt`
- Materiais de infraestrutura de rede (cabos, conectores, racks, cameras, switches)
- Importados para tabela `materiais` com constraint UNIQUE no nome

---

## Endpoints da API

### Autenticacao
- `POST /api/login` - Login com email/senha
- `POST /api/cadastrar` - Cadastro publico
- `POST /api/usuarios` - Criar usuario (gestor)
- `GET /api/usuarios` - Listar usuarios (gestor)

### Obras
- `GET /api/obras` - Listar obras (JOIN com locais)
- `GET /api/obras/:id` - Detalhes da obra com etapas
- `POST /api/obras` - Criar obra (com local_id e comarca)
- `PUT /api/obras/:id` - Atualizar obra
- `DELETE /api/obras/:id` - Excluir obra (soft delete)
- `PUT /api/obras/:id/toggle` - Toggle status

### Etapas
- `GET /api/obras/:obra_id/etapas` - Listar etapas
- `POST /api/obras/:obra_id/etapas` - Criar etapa
- `PUT /api/etapas/:id` - Atualizar etapa
- `DELETE /api/etapas/:id` - Excluir etapa

### Locais
- `GET /api/locais` - Listar locais (filtra por obra_id via comarca, comarca, busca)
- `GET /api/locais/comarcas` - Listar comarcas distintas
- `POST /api/locais` - Criar local
- `PUT /api/locais/:id` - Atualizar local
- `DELETE /api/locais/:id` - Excluir local

### Materiais
- `GET /api/materiais` - Listar/buscar materiais
- `POST /api/materiais` - Criar material
- `DELETE /api/materiais/:id` - Excluir material

### RDOs
- `GET /api/rdos` - Listar RDOs (JOIN com obras e locais para coordenadas)
- `GET /api/rdos/:id` - Detalhes do RDO
- `POST /api/rdos` - Criar RDO
- `PUT /api/rdos/:id` - Atualizar RDO
- `DELETE /api/rdos/:id` - Excluir RDO

### Equipes
- `GET /api/equipes` - Listar equipes com membros
- `GET /api/equipes/public` - Listar equipes (publico)
- `POST /api/equipes` - Criar equipe com membros
- `PUT /api/equipes/:id` - Atualizar equipe
- `DELETE /api/equipes/:id` - Excluir equipe

### Presenca/Localizacao
- `POST /api/presenca` - Atualizar posicao do tecnico
- `GET /api/presenca` - Listar tecnicos ativos
- `GET /api/minha-equipe` - Obter equipe do tecnico logado

### Upload
- `POST /api/upload` - Upload de fotos (multipart)

### Dashboard
- `GET /api/dashboard` - Stats do gestor

---

## Painel do Gestor (`/`)

### Abas Disponiveis
1. **Dashboard** - Stats (Obras, RDOs, Hoje, Usuarios)
2. **Obras** - CRUD obras com select de locais, etapas com progresso
3. **RDOs** - Lista de RDOs com detalhes
4. **Locais** - Vincular local a obra, filtro por comarca, busca
5. **Atividades** - CRUD de atividades
6. **Materiais** - Busca e catalogo
7. **Equipes** - CRUD equipes com membros (checkboxes)
8. **Usuarios** - CRUD usuarios

### Funcionalidades
- Dark mode (toggle no header)
- Export RDOs (JSON, CSV)
- Modal de detalhes do RDO
- Modal de etapas com progresso
- Select de locais filtrado por comarca

---

## App do Tecnico (`/app`)

### Abas Disponiveis
1. **Inicio** - Equipe, mapa com GPS, tecnicos ativos
2. **+ RDO** - Criar RDO com busca de materiais
3. **RDOs** - Historico com export JSON/CSV/Excel
4. **Mapa** - Mapa completo com RDOs historicos

### Funcionalidades
- Dark mode (toggle no header)
- GPS em tempo real com watchPosition
- Reverse geocoding (endereco automatico)
- Mapa com Leaflet mostrando:
  - Posicao do tecnico (azul pulsante)
  - Outros tecnicos (laranja)
  - RDOs historicos (verde/vermelho)
- Equipe auto-preenchida ao criar RDO
- Busca de materiais com addEventListener (funciona com caracteres especiais)
- Text-transform: uppercase nos inputs
- Export Excel com XLSX library

### Logica de Locais no RDO
1. Tecnico seleciona a **Obra**
2. Sistema busca a **comarca** da obra
3. Dropdown de **Locais** filtra pela comarca
4. Aparecem todos os foruns da mesma comarca

---

## Problemas Corrigidos nesta Sessao

1. **server.js vazio** - Restaurado do backup
2. **Bug SQL `);` solto** - Removido
3. **`validarCorpo` usava `res`** - Funcao removida (validacao inline)
4. **Materiais duplicados** - Limpados 212 duplicados, adicionado UNIQUE constraint
5. **onclick inline quebrava** - Substituido por addEventListener
6. **Equipe nao preenchia** - Adicionado carregarMinhaEquipe()
7. **Inputs maiusculas** - Adicionado text-transform: uppercase
8. **RDOs sem coordenadas** - Query LIKE para match flexivel de locais
9. **Comarca nao salva** - Adicionado coluna comarca em obras, salvamento automatico

---

## Arquivos Importados

### rdo-campo.html (referencia de design)
- Local: `D:\Nova pasta (2)\rdo-campo.html`
- Template PWA completo com GPS, mapa, checklist
- Usado como referencia para melhorias do app

### Imoveis_TJCE.xlsx (dados)
- Local: `D:\Nova pasta (2)\Imoveis_TJCE.xlsx`
- 232 imoveis do TJ-CE com coordenadas GPS
- Importados para tabela `locais`

### lista.txt (materiais)
- Local: `D:\Nova pasta (2)\lista.txt`
- 106 materiais de infraestrutura de rede
- Importados para tabela `materiais`

---

## Proximos Passos Sugeridos

1. **Vincular locais as obras** - Definir quais foruns pertencem a cada obra
2. **Check-in/check-out** - Implementar registro de presenca nos locais
3. **Relatorios PDF** - Gerar PDF dos RDOs
4. **Notificacoes push** - Alertas de SLA e mensagens
5. **PWA completo** - Service worker com cache offline
6. **Backup automatico** - Export periodico do banco

---

## Comandos Uteis

### Iniciar servidor
```powershell
cd "D:\Nova pasta (2)\crm-obras"
npm start
```

### Parar servidor
```powershell
powershell -command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
```

### Verificar sintaxe
```powershell
node --check server.js
```

### Testar banco
```powershell
node -e "const db = require('better-sqlite3')('data/crm.db'); console.log(db.prepare('SELECT COUNT(*) as c FROM locais').get());"
```

---

**Ultima atualizacao:** 17/08/2026
**Status:** Sistema funcional com todas as features implementadas
