const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
// deploy trigger 2026-08-26 - força Render a reimplantar aba Atividades
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Evita crash silencioso que derruba o proxy (502) — loga e mantém processo
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.TOKEN_SECRET || 'ipq-obras-2024';
// Estoque GERAL (central): pseudo-equipe que guarda o saldo geral antes de distribuir
const NOME_GERAL = '📦 ESTOQUE GERAL';
async function getGeralId() {
  let g = await db.prepare('SELECT id FROM equipes WHERE nome=?').get(NOME_GERAL);
  if (!g) {
    try { g = { id: (await db.prepare('INSERT INTO equipes (nome,cor,eh_geral) VALUES (?,?,1)').run(NOME_GERAL, '#455a64')).lastInsertRowid }; }
    catch (e) { g = await db.prepare('SELECT id FROM equipes WHERE nome=?').get(NOME_GERAL); }
  }
  return g ? g.id : null;
}
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ============================================================
// DATABASE
// ============================================================
const SQL_CREATE = [
  `CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE,
    senha TEXT,
    perfil TEXT DEFAULT 'tecnico',
    equipe_id INTEGER,
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS equipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cor TEXT DEFAULT '#1565c0',
    eh_geral INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS obras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    local_id INTEGER,
    prazo_dias INTEGER DEFAULT 30,
    data_inicio TEXT,
    status TEXT DEFAULT 'planejamento',
    progresso INTEGER DEFAULT 0,
    responsavel TEXT,
    descricao TEXT,
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (local_id) REFERENCES locais(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS locais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    comarca TEXT,
    nome_imovel TEXT,
    tipo TEXT,
    ocupacao TEXT,
    endereco TEXT,
    area TEXT,
    longitude TEXT,
    latitude TEXT,
    google_maps_link TEXT,
    street_view_link TEXT,
    cameras INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL,
    equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS etapas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER NOT NULL,
    local_id INTEGER REFERENCES locais(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    ordem INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pendente',
    data_inicio TEXT,
    data_fim TEXT,
    observacoes TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (obra_id) REFERENCES obras(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS atividades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    ativo INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS materiais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    categoria TEXT DEFAULT 'Geral',
    unidade TEXT DEFAULT 'UND',
    quantidade_minima REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS rdos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER,
    data TEXT,
    local TEXT,
    local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL,
    atividade TEXT,
    equipe_json TEXT DEFAULT '[]',
    materiais_json TEXT DEFAULT '[]',
    entrada_manha TEXT,
    saida_manha TEXT,
    entrada_tarde TEXT,
    saida_tarde TEXT,
    parou TEXT DEFAULT 'nao',
    motivo_parada TEXT,
    switch_instalado TEXT DEFAULT 'nao',
    nom_switch TEXT,
    local_switch TEXT,
    camera_instalada TEXT DEFAULT 'nao',
    nom_camera TEXT,
    local_camera TEXT,
    fotos_json TEXT DEFAULT '[]',
    usuario_id INTEGER,
    usuario_nome TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    ativo INTEGER DEFAULT 1,
    atualizado_em TEXT,
    atualizado_por TEXT,
    excluido_em TEXT,
    excluido_por TEXT,
    motivo_exclusao TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rdo_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rdo_id INTEGER NOT NULL,
    acao TEXT NOT NULL,
    usuario_id INTEGER,
    usuario_nome TEXT,
    motivo TEXT DEFAULT '',
    dados_antes TEXT DEFAULT '',
    dados_depois TEXT DEFAULT '',
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rdo_aud_rdo ON rdo_auditoria(rdo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rdos_ativo ON rdos(ativo)`,
  `CREATE INDEX IF NOT EXISTS idx_rdos_data ON rdos(data)`,
  `CREATE INDEX IF NOT EXISTS idx_rdos_usuario ON rdos(usuario_id)`,
  `CREATE TABLE IF NOT EXISTS presenca (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    usuario_nome TEXT,
    equipe_id INTEGER,
    latitude REAL,
    longitude REAL,
    obra_id INTEGER,
    local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL,
    local_nome TEXT,
    atualizado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS obra_materiais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
    material_nome TEXT NOT NULL,
    unidade TEXT DEFAULT 'UND',
    quantidade_estimada REAL DEFAULT 0,
    valor_unitario REAL DEFAULT 0,
    fornecedor TEXT,
    etapa TEXT DEFAULT 'ETAPA 1',
    observacao TEXT,
    criado_em TEXT DEFAULT (datetime('now')),
    local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL,
    equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_obra_materiais_obra ON obra_materiais(obra_id)`,
  `CREATE TABLE IF NOT EXISTS estoque_equipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
    quantidade_atual REAL DEFAULT 0,
    atualizado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(equipe_id, material_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_estoque_equipes_eq ON estoque_equipes(equipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_estoque_equipes_mat ON estoque_equipes(material_id)`,
  `CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    quantidade REAL NOT NULL,
    saldo_apos REAL,
    origem TEXT DEFAULT '',
    usuario_id INTEGER,
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_est_mov_eqmat ON estoque_movimentacoes(equipe_id, material_id)`,
  // Estoque físico por LOCAL: o local recebe material (da equipe ou direto) e o RDO
  // consome dele junto com o da equipe. Trilha separada para não misturar com equipe.
  `CREATE TABLE IF NOT EXISTS estoque_locais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
    quantidade_atual REAL DEFAULT 0,
    atualizado_em TEXT DEFAULT (datetime('now')),
    UNIQUE(local_id, material_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_estoque_locais_local ON estoque_locais(local_id)`,
  `CREATE INDEX IF NOT EXISTS idx_estoque_locais_mat ON estoque_locais(material_id)`,
  `CREATE TABLE IF NOT EXISTS estoque_local_movimentacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    quantidade REAL NOT NULL,
    saldo_apos REAL,
    origem TEXT DEFAULT '',
    usuario_id INTEGER,
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_est_locmov_locmat ON estoque_local_movimentacoes(local_id, material_id)`,
  // Compras por OBRA: o que foi efetivamente comprado para a obra (base do
  // comparativo comprado x consumido). Estimativa = plano; compra = dinheiro.
  `CREATE TABLE IF NOT EXISTS obra_compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE,
    material_nome TEXT NOT NULL,
    unidade TEXT DEFAULT 'UND',
    quantidade REAL DEFAULT 0,
    valor_unitario REAL DEFAULT 0,
    fornecedor TEXT DEFAULT '',
    data_compra TEXT DEFAULT '',
    observacao TEXT DEFAULT '',
    criado_por TEXT DEFAULT '',
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_obra_compras_obra ON obra_compras(obra_id)`,
  // Checklist de conferência por ponto (CCTV/infra) + planta do local
  `CREATE TABLE IF NOT EXISTS local_pontos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
    obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL,
    tipo TEXT DEFAULT 'camera',
    codigo TEXT NOT NULL,
    descricao TEXT DEFAULT '',
    status TEXT DEFAULT 'a_instalar',
    rdo_id INTEGER REFERENCES rdos(id) ON DELETE SET NULL,
    observacao TEXT DEFAULT '',
    atualizado_por TEXT DEFAULT '',
    criado_em TEXT DEFAULT (datetime('now')),
    atualizado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_pontos_local ON local_pontos(local_id)`,
  `CREATE INDEX IF NOT EXISTS idx_local_pontos_obra ON local_pontos(obra_id)`,
  // Plantas por PAVIMENTO: um local pode ter Térreo, 1º andar, subsolo...
  `CREATE TABLE IF NOT EXISTS local_plantas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL DEFAULT 'Geral',
    url TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_plantas_local ON local_plantas(local_id)`
];
// DB init - hibrido SQLite / Postgres (Supabase)
async function initDb(){
  if (db.isPostgres) {
    await db.init();
    // Garante colunas para multi-obra e per-local (F0) - Postgres
    try { await db.exec('ALTER TABLE etapas ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE CASCADE'); console.log('[migracao] etapas.local_id Postgres'); } catch(e){}
    try { await db.exec('ALTER TABLE locais ADD COLUMN IF NOT EXISTS obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL'); console.log('[migracao] locais.obra_id Postgres'); } catch(e){}
    try { await db.exec('ALTER TABLE locais ADD COLUMN IF NOT EXISTS equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL'); console.log('[migracao] locais.equipe_id Postgres'); } catch(e){}
    try { await db.exec('ALTER TABLE rdos ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL'); console.log('[migracao] rdos.local_id Postgres'); } catch(e){}
    // Auditoria RDO (obra gigante: soft-delete + trilha quem editou/apagou + motivo)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS rdo_auditoria (id SERIAL PRIMARY KEY, rdo_id INTEGER NOT NULL, acao TEXT NOT NULL, usuario_id INTEGER, usuario_nome TEXT, motivo TEXT DEFAULT '', dados_antes TEXT DEFAULT '', dados_depois TEXT DEFAULT '', criado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdo_aud_rdo ON rdo_auditoria(rdo_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdos_ativo ON rdos(ativo)'); } catch(e){}
    for (const c of ['ativo INTEGER DEFAULT 1','atualizado_em TEXT','atualizado_por TEXT','excluido_em TEXT','excluido_por TEXT','motivo_exclusao TEXT']) {
      const col = c.split(' ')[0];
      try { await db.exec(`ALTER TABLE rdos ADD COLUMN IF NOT EXISTS ${col} ${c.slice(col.length).trim()}`); } catch(e){}
    }
    try { await db.exec('UPDATE rdos SET ativo=1 WHERE ativo IS NULL'); } catch(e){}
    try { await db.exec('ALTER TABLE presenca ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL'); console.log('[migracao] presenca.local_id Postgres'); } catch(e){}
    // Estoque por local/equipe: escopo opcional na estimativa (NULL = obra toda)
    try { await db.exec('ALTER TABLE obra_materiais ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL'); } catch(e){}
    try { await db.exec('ALTER TABLE obra_materiais ADD COLUMN IF NOT EXISTS equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL'); } catch(e){}
    try { await db.exec('ALTER TABLE equipes ADD COLUMN IF NOT EXISTS eh_geral INTEGER DEFAULT 0'); } catch(e){}
    try {
      const g = await db.prepare('SELECT id FROM equipes WHERE nome=?').get('📦 ESTOQUE GERAL');
      if (!g) await db.prepare('INSERT INTO equipes (nome,cor,eh_geral) VALUES (?,?,1)').run('📦 ESTOQUE GERAL', '#455a64');
      else await db.prepare('UPDATE equipes SET eh_geral=1 WHERE id=?').run(g.id);
    } catch(e){}
    try { await db.exec('ALTER TABLE materiais ADD COLUMN IF NOT EXISTS unidade TEXT DEFAULT \'UND\''); } catch(e){}
    try { await db.exec('ALTER TABLE materiais ADD COLUMN IF NOT EXISTS quantidade_minima DOUBLE PRECISION DEFAULT 0'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_equipes (id SERIAL PRIMARY KEY, equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, quantidade_atual DOUBLE PRECISION DEFAULT 0, atualizado_em TIMESTAMPTZ DEFAULT NOW(), UNIQUE(equipe_id, material_id))`); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_movimentacoes (id SERIAL PRIMARY KEY, equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, tipo TEXT NOT NULL, quantidade DOUBLE PRECISION NOT NULL, saldo_apos DOUBLE PRECISION, origem TEXT DEFAULT '', usuario_id INTEGER, criado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    // Estoque físico por LOCAL (bancos já criados: CREATE IF NOT EXISTS é idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_locais (id SERIAL PRIMARY KEY, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, quantidade_atual DOUBLE PRECISION DEFAULT 0, atualizado_em TIMESTAMPTZ DEFAULT NOW(), UNIQUE(local_id, material_id))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_locais_local ON estoque_locais(local_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_locais_mat ON estoque_locais(material_id)'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_local_movimentacoes (id SERIAL PRIMARY KEY, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, tipo TEXT NOT NULL, quantidade DOUBLE PRECISION NOT NULL, saldo_apos DOUBLE PRECISION, origem TEXT DEFAULT '', usuario_id INTEGER, criado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_est_locmov_locmat ON estoque_local_movimentacoes(local_id, material_id)'); } catch(e){}
    // Compras por OBRA (bancos já criados: CREATE IF NOT EXISTS é idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS obra_compras (id SERIAL PRIMARY KEY, obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE, material_nome TEXT NOT NULL, unidade TEXT DEFAULT 'UND', quantidade DOUBLE PRECISION DEFAULT 0, valor_unitario DOUBLE PRECISION DEFAULT 0, fornecedor TEXT DEFAULT '', data_compra TEXT DEFAULT '', observacao TEXT DEFAULT '', criado_por TEXT DEFAULT '', criado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_obra_compras_obra ON obra_compras(obra_id)'); } catch(e){}
    // Checklist de pontos + planta (Postgres; bancos já criados: idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS local_pontos (id SERIAL PRIMARY KEY, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL, tipo TEXT DEFAULT 'camera', codigo TEXT NOT NULL, descricao TEXT DEFAULT '', status TEXT DEFAULT 'a_instalar', rdo_id INTEGER REFERENCES rdos(id) ON DELETE SET NULL, observacao TEXT DEFAULT '', atualizado_por TEXT DEFAULT '', criado_em TIMESTAMPTZ DEFAULT NOW(), atualizado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_pontos_local ON local_pontos(local_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_pontos_obra ON local_pontos(obra_id)'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS local_plantas (id SERIAL PRIMARY KEY, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, titulo TEXT NOT NULL DEFAULT 'Geral', url TEXT NOT NULL, criado_em TIMESTAMPTZ DEFAULT NOW())`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_plantas_local ON local_plantas(local_id)'); } catch(e){}
    try { await db.exec('ALTER TABLE locais ADD COLUMN IF NOT EXISTS planta_url TEXT'); } catch(e){}
    try { await db.exec('ALTER TABLE obra_materiais DROP CONSTRAINT IF EXISTS obra_materiais_obra_id_material_nome_key'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_obra_mat_escopo ON obra_materiais(obra_id, local_id, equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_obra ON locais(obra_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_equipe ON locais(equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdos_local_id ON rdos(local_id)'); } catch(e){}
  } else {
    for (const sql of SQL_CREATE) await db.exec(sql);
    async function ensureColumn(table, col, def) {
      const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).map(c=>c.name);
      if (!cols.includes(col)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        console.log(`[migracao] ${table}.${col} adicionado`);
      }
    }
    await ensureColumn('locais', 'status_projeto', 'TEXT');
    await ensureColumn('locais', 'etapa', 'TEXT');
    await ensureColumn('locais', 'cam_fixa', 'INTEGER DEFAULT 0');
    await ensureColumn('locais', 'cam_analitica', 'INTEGER DEFAULT 0');
    await ensureColumn('locais', 'cam_lpr', 'INTEGER DEFAULT 0');
    await ensureColumn('locais', 'regiao', 'TEXT');
    await ensureColumn('locais', 'cronograma', 'TEXT');
    await ensureColumn('locais', 'terceirizada', 'INTEGER DEFAULT 0');
    await ensureColumn('obras', 'comarca', 'TEXT');
    await ensureColumn('etapas', 'local_id', 'INTEGER REFERENCES locais(id) ON DELETE CASCADE');
    await ensureColumn('locais', 'obra_id', 'INTEGER REFERENCES obras(id) ON DELETE SET NULL');
    await ensureColumn('locais', 'equipe_id', 'INTEGER REFERENCES equipes(id) ON DELETE SET NULL');
    await ensureColumn('rdos', 'local_id', 'INTEGER REFERENCES locais(id) ON DELETE SET NULL');
    await ensureColumn('rdos', 'ativo', 'INTEGER DEFAULT 1');
    await ensureColumn('rdos', 'atualizado_em', 'TEXT');
    await ensureColumn('rdos', 'atualizado_por', 'TEXT');
    await ensureColumn('rdos', 'excluido_em', 'TEXT');
    await ensureColumn('rdos', 'excluido_por', 'TEXT');
    await ensureColumn('rdos', 'motivo_exclusao', 'TEXT');
    await ensureColumn('presenca', 'local_id', 'INTEGER REFERENCES locais(id) ON DELETE SET NULL');
    await ensureColumn('materiais', 'unidade', "TEXT DEFAULT 'UND'");
    await ensureColumn('materiais', 'quantidade_minima', 'REAL DEFAULT 0');
    await ensureColumn('equipes', 'eh_geral', 'INTEGER DEFAULT 0');
    // Estoque geral (central): pseudo-equipe que guarda o saldo geral
    try {
      const g = await db.prepare('SELECT id FROM equipes WHERE nome=?').get(NOME_GERAL);
      if (!g) await db.prepare('INSERT INTO equipes (nome,cor,eh_geral) VALUES (?,?,1)').run(NOME_GERAL, '#455a64');
      else await db.prepare('UPDATE equipes SET eh_geral=1, ativo=1 WHERE id=?').run(g.id);
    } catch (e) { console.log('[migracao] geral', e.message); }
    // Estoque por local/equipe: rebuild remove UNIQUE(obra,nome) que impedia repetir o material em escopos
    try {
      const omCols = (await db.prepare('PRAGMA table_info(obra_materiais)').all()).map(c => c.name);
      if (!omCols.includes('local_id') || !omCols.includes('equipe_id')) {
        await db.exec(`CREATE TABLE IF NOT EXISTS obra_materiais_new (id INTEGER PRIMARY KEY AUTOINCREMENT, obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE, material_nome TEXT NOT NULL, unidade TEXT DEFAULT 'UND', quantidade_estimada REAL DEFAULT 0, valor_unitario REAL DEFAULT 0, fornecedor TEXT, etapa TEXT DEFAULT 'ETAPA 1', observacao TEXT, criado_em TEXT DEFAULT (datetime('now')), local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL, equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL)`);
        await db.exec(`INSERT OR IGNORE INTO obra_materiais_new (id, obra_id, material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao, criado_em) SELECT id, obra_id, material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao, criado_em FROM obra_materiais`);
        await db.exec('DROP TABLE obra_materiais');
        await db.exec('ALTER TABLE obra_materiais_new RENAME TO obra_materiais');
        console.log('[migracao] obra_materiais escopo local/equipe');
      }
    } catch (e) { console.log('[migracao] obra_materiais escopo', e.message); }
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_obra_mat_escopo ON obra_materiais(obra_id, local_id, equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdo_aud_rdo ON rdo_auditoria(rdo_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdos_ativo ON rdos(ativo)'); } catch(e){}
    try { await db.exec('UPDATE rdos SET ativo=1 WHERE ativo IS NULL'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_obra ON locais(obra_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_equipe ON locais(equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdos_local_id ON rdos(local_id)'); } catch(e){}
    // Estoque por equipe (minimo global em materiais.quantidade_minima)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_equipes (id INTEGER PRIMARY KEY AUTOINCREMENT, equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, quantidade_atual REAL DEFAULT 0, atualizado_em TEXT DEFAULT (datetime('now')), UNIQUE(equipe_id, material_id))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_equipes_eq ON estoque_equipes(equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_equipes_mat ON estoque_equipes(material_id)'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_movimentacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, equipe_id INTEGER NOT NULL REFERENCES equipes(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, tipo TEXT NOT NULL, quantidade REAL NOT NULL, saldo_apos REAL, origem TEXT DEFAULT '', usuario_id INTEGER, criado_em TEXT DEFAULT (datetime('now')))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_est_mov_eqmat ON estoque_movimentacoes(equipe_id, material_id)'); } catch(e){}
    // Estoque físico por LOCAL (bancos já criados: CREATE IF NOT EXISTS é idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_locais (id INTEGER PRIMARY KEY AUTOINCREMENT, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, quantidade_atual REAL DEFAULT 0, atualizado_em TEXT DEFAULT (datetime('now')), UNIQUE(local_id, material_id))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_locais_local ON estoque_locais(local_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_estoque_locais_mat ON estoque_locais(material_id)'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS estoque_local_movimentacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE, tipo TEXT NOT NULL, quantidade REAL NOT NULL, saldo_apos REAL, origem TEXT DEFAULT '', usuario_id INTEGER, criado_em TEXT DEFAULT (datetime('now')))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_est_locmov_locmat ON estoque_local_movimentacoes(local_id, material_id)'); } catch(e){}
    // Compras por OBRA (bancos já criados: CREATE IF NOT EXISTS é idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS obra_compras (id INTEGER PRIMARY KEY AUTOINCREMENT, obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE, material_nome TEXT NOT NULL, unidade TEXT DEFAULT 'UND', quantidade REAL DEFAULT 0, valor_unitario REAL DEFAULT 0, fornecedor TEXT DEFAULT '', data_compra TEXT DEFAULT '', observacao TEXT DEFAULT '', criado_por TEXT DEFAULT '', criado_em TEXT DEFAULT (datetime('now')))`); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_obra_compras_obra ON obra_compras(obra_id)'); } catch(e){}
    // Checklist de pontos + planta (SQLite; bancos já criados: idempotente)
    try { await db.exec(`CREATE TABLE IF NOT EXISTS local_pontos (id INTEGER PRIMARY KEY AUTOINCREMENT, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL, tipo TEXT DEFAULT 'camera', codigo TEXT NOT NULL, descricao TEXT DEFAULT '', status TEXT DEFAULT 'a_instalar', rdo_id INTEGER REFERENCES rdos(id) ON DELETE SET NULL, observacao TEXT DEFAULT '', atualizado_por TEXT DEFAULT '', criado_em TEXT DEFAULT (datetime('now')), atualizado_em TEXT DEFAULT (datetime('now')))`) ; } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_pontos_local ON local_pontos(local_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_pontos_obra ON local_pontos(obra_id)'); } catch(e){}
    try { await db.exec(`CREATE TABLE IF NOT EXISTS local_plantas (id INTEGER PRIMARY KEY AUTOINCREMENT, local_id INTEGER NOT NULL REFERENCES locais(id) ON DELETE CASCADE, titulo TEXT NOT NULL DEFAULT 'Geral', url TEXT NOT NULL, criado_em TEXT DEFAULT (datetime('now')))`) ; } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_local_plantas_local ON local_plantas(local_id)'); } catch(e){}
    await ensureColumn('locais', 'planta_url', 'TEXT');
  }
  // Admin padrao (async para ambos)
  const admin = await db.prepare('SELECT id FROM usuarios WHERE email=?').get('admin@ipq.com');
  if (!admin) {
    await db.prepare('INSERT INTO usuarios (nome,email,senha,perfil) VALUES (?,?,?,?)')
      .run('Administrador', 'admin@ipq.com', hash('admin123'), 'gestor');
    console.log('[db] admin criado');
  }
  // Obra global TJ-CE — modo obra única (todos os locais pertencem a ela, sem vincular 1 a 1)
  // Nenhuma mudança de schema: apenas garante 1 registro global com local_id NULL
  const tjce = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(nome,' ',''))=UPPER(?) AND ativo=1").get('TJ-CE');
  // também tenta sem hífen para compatibilidade
  const tjce2 = tjce || await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''), ' ',''))=UPPER(?) AND ativo=1").get('TJCE');
  if (!tjce && !tjce2) {
    await db.prepare("INSERT INTO obras (nome, local_id, comarca, status, progresso, descricao) VALUES (?,?,?,?,?,?)")
      .run('TJ-CE', null, '', 'em_andamento', 0, 'Obra global - todos os locais TJCE');
    console.log('[db] obra TJ-CE criada (global, sem local_id)');
  }
  // Template de etapas para TJ-CE (base para progresso per-local dinâmico via RDO)
  const tjceFinal = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
  if (tjceFinal) {
    const tmplCount = (await db.prepare('SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0)').get(tjceFinal.id)).c;
    if (tmplCount === 0) {
      const nomes = ['Levantamento','Infraestrutura','Cabeamento','Instalação e Testes'];
      for (let i=0;i<nomes.length;i++) {
        await db.prepare('INSERT INTO etapas (obra_id, local_id, nome, ordem, status) VALUES (?,?,?,?,?)').run(tjceFinal.id, null, nomes[i], i+1, 'pendente');
      }
      console.log('[db] template etapas TJ-CE criado (4)');
    }
    // Garante atividades correspondentes para o select de RDO (app)
    const nomesAtiv = ['Levantamento','Infraestrutura','Cabeamento','Instalação e Testes'];
    for (const n of nomesAtiv) {
      const ex = await db.prepare('SELECT id FROM atividades WHERE nome=?').get(n);
      if (!ex) await db.prepare('INSERT INTO atividades (nome, ativo) VALUES (?,1)').run(n);
      else await db.prepare('UPDATE atividades SET ativo=1 WHERE nome=?').run(n);
    }
  }
  // Backfill F0: popula obra_id/equipe_id em locais e local_id em rdos (idempotente, preserva TJ-CE)
  if (tjceFinal) {
    try {
      const c1 = (await db.prepare('SELECT COUNT(*) as c FROM locais WHERE obra_id IS NULL AND ativo=1').get()).c;
      if (c1>0) {
        await db.prepare('UPDATE locais SET obra_id=? WHERE obra_id IS NULL AND ativo=1').run(tjceFinal.id);
        console.log(`[migracao] locais.obra_id backfill ${c1} TJ-CE`);
      }
    } catch(e){ console.log('[migracao] obra_id', e.message); }
    try {
      const regs = await db.prepare("SELECT DISTINCT regiao FROM locais WHERE regiao IS NOT NULL AND regiao<>'' AND (equipe_id IS NULL OR equipe_id=0)").all();
      for (const r of regs) {
        const eq = await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1').get(r.regiao);
        if (eq) await db.prepare('UPDATE locais SET equipe_id=? WHERE regiao=? AND (equipe_id IS NULL OR equipe_id=0)').run(eq.id, r.regiao);
      }
      console.log('[migracao] locais.equipe_id backfill');
    } catch(e){ console.log('[migracao] equipe_id', e.message); }
    // Corrige regiao legado com variação de espaço/caixa (EQUIPE5 -> EQUIPE 5) usando normalização
    try {
      const equipesNorm = await db.prepare('SELECT id,nome FROM equipes WHERE ativo=1').all();
      const mapNorm = {};
      for(const e of equipesNorm){ const n=e.nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,''); if(!mapNorm[n]) mapNorm[n]=e; }
      const regs2 = await db.prepare("SELECT DISTINCT regiao FROM locais WHERE regiao IS NOT NULL AND regiao<>''").all();
      for(const r of regs2){
        const n=(r.regiao||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,'');
        const eq=mapNorm[n];
        if(eq && r.regiao!==eq.nome){
          await db.prepare('UPDATE locais SET regiao=? WHERE regiao=?').run(eq.nome, r.regiao);
          console.log(`[migracao] regiao normalizada ${r.regiao} -> ${eq.nome}`);
        }
        if(eq) await db.prepare('UPDATE locais SET equipe_id=? WHERE regiao=? AND (equipe_id IS NULL OR equipe_id=0)').run(eq.id, eq.nome);
      }
    } catch(e){ console.log('[migracao] regiao norm', e.message); }
    try {
      const c3 = (await db.prepare('SELECT COUNT(*) as c FROM rdos WHERE local_id IS NULL AND local IS NOT NULL').get()).c;
      if (c3>0) {
        // compatível SQLite e Postgres (subquery) - LIMIT 1 evita múltiplas linhas se houver homônimos
        if (db.isPostgres) {
          await db.exec(`UPDATE rdos SET local_id=(SELECT id FROM locais WHERE locais.nome=rdos.local LIMIT 1) WHERE local_id IS NULL AND local IS NOT NULL`);
        } else {
          await db.exec(`UPDATE rdos SET local_id=(SELECT id FROM locais WHERE locais.nome=rdos.local LIMIT 1) WHERE local_id IS NULL AND local IS NOT NULL`);
        }
        console.log(`[migracao] rdos.local_id backfill ${c3}`);
      }
    } catch(e){ console.log('[migracao] rdos.local_id', e.message); }
  }
}
const dbReady = initDb();

// ============================================================
// HELPERS
// ============================================================
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function signToken(payload) {
  const d = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SECRET).update(d).digest('base64');
  return d + '.' + sig;
}

function verifyToken(token) {
  try {
    const [d, sig] = token.split('.');
    if (!d || !sig) return null;
    if (sig !== crypto.createHmac('sha256', SECRET).update(d).digest('base64')) return null;
    const payload = JSON.parse(Buffer.from(d, 'base64').toString());
    if (payload.exp && Date.now() > payload.exp) return null; // token expirado
    return payload;
  } catch { return null; }
}

function auth(req, res, next) {
  if (req.path === '/api/login' || req.path === '/api/cadastrar' || req.path === '/api/equipes/public') return next();
  if (!req.path.startsWith('/api/')) return next();
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Nao autenticado' });
  const user = verifyToken(h.slice(7));
  if (!user) return res.status(401).json({ error: 'Token invalido' });
  req.user = user;
  next();
}

function gestor(req, res, next) {
  if (!req.user || req.user.perfil !== 'gestor') return res.status(403).json({ error: 'Acesso restrito' });
  next();
}
// Normaliza nome de equipe/regiao para multi-obra (remove acento, espaço e caixa) - EQUIPE5 == EQUIPE 5
function normEquipe(s){ return (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,''); }

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ============================================================
// MIDDLEWARE
// ============================================================
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(auth);

// ============================================================
// AUTH
// ============================================================
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatorios' });
  const u = await db.prepare('SELECT * FROM usuarios WHERE email=? AND ativo=1').get(email);
  if (!u || u.senha !== hash(senha)) return res.status(401).json({ error: 'Email ou senha incorretos' });
  const token = signToken({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, equipe_id: u.equipe_id, exp: Date.now() + 86400000 * 7 });
  res.json({ token, user: { id: u.id, nome: u.nome, perfil: u.perfil, equipe_id: u.equipe_id } });
});

// Cadastro publico DESATIVADO: apenas gestor cria usuarios pelo painel admin
app.post('/api/cadastrar', async (req, res) => {
  return res.status(403).json({ error: 'Cadastro desativado. Solicite ao gestor para criar seu acesso no Painel Admin > Usuarios.' });
});

app.get('/api/usuarios', gestor, async (req, res) => {
  res.json(await db.prepare('SELECT id,nome,email,perfil,equipe_id,ativo,criado_em FROM usuarios ORDER BY ativo DESC, nome').all());
});

app.post('/api/usuarios', gestor, async (req, res) => {
  const { nome, email, senha, perfil, equipe_id } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Preencha todos os campos' });
  const emailNorm = email.trim().toLowerCase();
  if (!emailNorm.includes('@')) return res.status(400).json({ error: 'Email invalido' });
  if (senha.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });
  if (await db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailNorm)) return res.status(400).json({ error: 'Email ja cadastrado' });
  if (perfil && !['tecnico','gestor'].includes(perfil)) return res.status(400).json({ error: 'Perfil invalido' });
  // valida equipe existe
  if (equipe_id) {
    const eq = await db.prepare('SELECT id FROM equipes WHERE id=? AND ativo=1').get(equipe_id);
    if (!eq) return res.status(400).json({ error: 'Equipe nao encontrada' });
  }
  const r = await db.prepare('INSERT INTO usuarios (nome,email,senha,perfil,equipe_id) VALUES (?,?,?,?,?)').run(nome.trim(), emailNorm, hash(senha), perfil || 'tecnico', equipe_id || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/usuarios/:id', gestor, async (req, res) => {
  const id = req.params.id;
  const atual = await db.prepare('SELECT * FROM usuarios WHERE id=?').get(id);
  if (!atual) return res.status(404).json({ error: 'Usuario nao encontrado' });
  const { nome, email, senha, perfil, equipe_id, ativo } = req.body;
  if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatorios' });
  const emailNorm = email.trim().toLowerCase();
  if (await db.prepare('SELECT id FROM usuarios WHERE email=? AND id<>?').get(emailNorm, id)) return res.status(400).json({ error: 'Email ja em uso por outro usuario' });
  if (perfil && !['tecnico','gestor'].includes(perfil)) return res.status(400).json({ error: 'Perfil invalido' });
  if (equipe_id) {
    const eq = await db.prepare('SELECT id FROM equipes WHERE id=? AND ativo=1').get(equipe_id);
    if (!eq) return res.status(400).json({ error: 'Equipe nao encontrada' });
  }
  // impedir desativar ultimo gestor ativo
  if (String(ativo) === '0' && atual.perfil === 'gestor') {
    const gestoresAtivos = (await db.prepare("SELECT COUNT(*) as c FROM usuarios WHERE perfil='gestor' AND ativo=1 AND id<>?").get(id)).c;
    if (gestoresAtivos === 0) return res.status(400).json({ error: 'Nao pode desativar o ultimo gestor' });
  }
  // impedir auto-desativacao
  if (String(ativo) === '0' && Number(id) === req.user.id) return res.status(400).json({ error: 'Voce nao pode desativar seu proprio usuario' });

  if (senha && senha.trim().length > 0) {
    if (senha.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres' });
    await db.prepare('UPDATE usuarios SET nome=?,email=?,senha=?,perfil=?,equipe_id=?,ativo=? WHERE id=?').run(nome.trim(), emailNorm, hash(senha), perfil || atual.perfil, equipe_id || null, ativo != null ? Number(ativo) : atual.ativo, id);
  } else {
    await db.prepare('UPDATE usuarios SET nome=?,email=?,perfil=?,equipe_id=?,ativo=? WHERE id=?').run(nome.trim(), emailNorm, perfil || atual.perfil, equipe_id || null, ativo != null ? Number(ativo) : atual.ativo, id);
  }
  res.json({ ok: true });
});

app.delete('/api/usuarios/:id', gestor, async (req, res) => {
  const id = req.params.id;
  const u = await db.prepare('SELECT * FROM usuarios WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuario nao encontrado' });
  if (Number(id) === req.user.id) return res.status(400).json({ error: 'Voce nao pode excluir seu proprio usuario' });
  if (u.perfil === 'gestor') {
    const gestoresAtivos = (await db.prepare("SELECT COUNT(*) as c FROM usuarios WHERE perfil='gestor' AND ativo=1 AND id<>?").get(id)).c;
    if (gestoresAtivos === 0) return res.status(400).json({ error: 'Nao pode remover o ultimo gestor' });
  }
  await db.prepare('UPDATE usuarios SET ativo=0, equipe_id=NULL WHERE id=?').run(id);
  res.json({ ok: true });
});

// Perfil do proprio usuario (app) - sem precisar ser gestor
app.get('/api/me', async (req,res)=>{
  if(!req.user) return res.status(401).json({error:'Nao autenticado'});
  const u = await db.prepare('SELECT id,nome,email,perfil,equipe_id FROM usuarios WHERE id=?').get(req.user.id);
  if(!u) return res.status(404).json({error:'Usuario nao encontrado'});
  const eq = u.equipe_id ? await db.prepare('SELECT nome,cor FROM equipes WHERE id=?').get(u.equipe_id) : null;
  res.json({...u, equipe_nome: eq?eq.nome:null, equipe_cor: eq?eq.cor:null});
});
app.put('/api/me', async (req,res)=>{
  if(!req.user) return res.status(401).json({error:'Nao autenticado'});
  const {nome, senha} = req.body;
  if(!nome || !nome.trim()) return res.status(400).json({error:'Nome obrigatorio'});
  if(senha && senha.length<4) return res.status(400).json({error:'Senha deve ter ao menos 4 caracteres'});
  const atual = await db.prepare('SELECT id FROM usuarios WHERE id=?').get(req.user.id);
  if(!atual) return res.status(404).json({error:'Usuario nao encontrado'});
  if(senha) await db.prepare('UPDATE usuarios SET nome=?, senha=? WHERE id=?').run(nome.trim(), hash(senha), req.user.id);
  else await db.prepare('UPDATE usuarios SET nome=? WHERE id=?').run(nome.trim(), req.user.id);
  res.json({ok:true});
});

// ============================================================
// EQUIPES
// ============================================================
app.get('/api/equipes', async (req, res) => {
  const equipes = await db.prepare('SELECT * FROM equipes WHERE ativo=1 AND COALESCE(eh_geral,0)=0 ORDER BY nome').all();
  // Robust: inclui todos os perfis ativos, nao so tecnico — reflete logica real de obra
  const users = await db.prepare('SELECT id,nome,email,perfil,equipe_id FROM usuarios WHERE ativo=1').all();
  // conta RDOs e obras vinculadas por equipe (via usuarios)
  const rdosPorEquipe = await db.prepare('SELECT equipe_id, COUNT(*) as c FROM presenca WHERE equipe_id IS NOT NULL GROUP BY equipe_id').all();
  const rdoMap = Object.fromEntries(rdosPorEquipe.map(r=>[r.equipe_id, r.c]));
  res.json(equipes.map(e => ({
    ...e,
    membros: users.filter(u => String(u.equipe_id) === String(e.id)),
    total_membros: users.filter(u => String(u.equipe_id) === String(e.id)).length,
    rdos_vinculados: rdoMap[e.id] || 0
  })));
});

// Mantido por compatibilidade (login antigo) — agora retorna vazio e loga aviso
app.get('/api/equipes/public', async (req, res) => {
  res.json(await db.prepare('SELECT id,nome,cor FROM equipes WHERE ativo=1 AND COALESCE(eh_geral,0)=0 ORDER BY nome').all());
});

app.post('/api/equipes', gestor, async (req, res) => {
  const { nome, cor, membros } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  const nomeTrim = nome.trim();
  if (nomeTrim === NOME_GERAL) return res.status(400).json({ error: 'Nome reservado ao estoque geral' });
  if (await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1').get(nomeTrim)) return res.status(400).json({ error: 'Ja existe equipe com esse nome' });
  // valida membros existem e ativos
  if (membros && Array.isArray(membros) && membros.length) {
    const ids = membros.map(Number).filter(Boolean);
    for (const uid of ids) {
      const u = await db.prepare('SELECT id, ativo FROM usuarios WHERE id=?').get(uid);
      if (!u) return res.status(400).json({ error: 'Usuario id ' + uid + ' nao encontrado' });
      if (!u.ativo) return res.status(400).json({ error: 'Usuario id ' + uid + ' esta desativado' });
    }
  }
  const r = await db.prepare('INSERT INTO equipes (nome,cor) VALUES (?,?)').run(nomeTrim, cor || '#1565c0');
  if (membros && Array.isArray(membros) && membros.length) {
    for (const uid of membros.map(Number)) {
      await db.prepare('UPDATE usuarios SET equipe_id=? WHERE id=?').run(r.lastInsertRowid, Number(uid));
    }
  }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/equipes/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const existe = await db.prepare('SELECT id, nome FROM equipes WHERE id=? AND ativo=1').get(id);
  if (!existe) return res.status(404).json({ error: 'Equipe nao encontrada' });
  const { nome, cor, membros } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  const nomeTrim = nome.trim();
  if (await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1 AND id<>?').get(nomeTrim, id)) return res.status(400).json({ error: 'Ja existe outra equipe com esse nome' });
  if (membros && Array.isArray(membros)) {
    for (const uid of membros.map(Number)) {
      const u = await db.prepare('SELECT id, ativo FROM usuarios WHERE id=?').get(uid);
      if (!u) return res.status(400).json({ error: 'Usuario id ' + uid + ' nao encontrado' });
      if (!u.ativo) return res.status(400).json({ error: 'Usuario id ' + uid + ' esta desativado' });
    }
  }
  await db.prepare('UPDATE equipes SET nome=?,cor=? WHERE id=?').run(nomeTrim, cor || '#1565c0', id);
  // Renomeou: acompanha nome nos locais (regiao guarda o nome) para não virar "equipe fantasma"
  if (normEquipe(existe.nome) !== normEquipe(nomeTrim)) {
    try {
      const regs = await db.prepare("SELECT id, regiao FROM locais WHERE regiao IS NOT NULL AND regiao<>''").all();
      for (const l of (regs || [])) {
        if (normEquipe(l.regiao) === normEquipe(existe.nome)) { try { await db.prepare('UPDATE locais SET regiao=? WHERE id=?').run(nomeTrim, l.id); } catch (e) {} }
      }
    } catch (e) {}
  }
  if (membros && Array.isArray(membros)) {
    await db.prepare('UPDATE usuarios SET equipe_id=NULL WHERE equipe_id=?').run(id);
    for (const uid of membros) {
      await db.prepare('UPDATE usuarios SET equipe_id=? WHERE id=?').run(id, Number(uid));
    }
  }
  res.json({ ok: true });
});

app.delete('/api/equipes/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const eq = await db.prepare('SELECT id, nome, COALESCE(eh_geral,0) as eh_geral FROM equipes WHERE id=? AND ativo=1').get(id);
  if (!eq) return res.status(404).json({ error: 'Equipe nao encontrada' });
  if (Number(eq.eh_geral) === 1) return res.status(400).json({ error: 'Estoque geral não pode ser excluído' });
  // Limpa vínculo nos locais (regiao guarda o nome): volta para SEM EQUIPE
  try {
    const regs = await db.prepare("SELECT id, regiao FROM locais WHERE regiao IS NOT NULL AND regiao<>''").all();
    const alvo = normEquipe(eq.nome);
    for (const l of (regs || [])) {
      if (normEquipe(l.regiao) === alvo) { try { await db.prepare('UPDATE locais SET regiao=? WHERE id=?').run('', l.id); } catch (e) {} }
    }
  } catch (e) {}
  await db.prepare('UPDATE usuarios SET equipe_id=NULL WHERE equipe_id=?').run(id);
  await db.prepare('UPDATE equipes SET ativo=0 WHERE id=?').run(id);
  res.json({ ok: true });
});

// ============================================================
// OBRAS
// ============================================================
app.get('/api/obras', async (req, res) => {
  let sql = `SELECT o.*, l.nome as local_nome, l.comarca as local_comarca, l.endereco as local_endereco, l.cameras as local_cameras,
    (SELECT COUNT(*) FROM etapas WHERE obra_id=o.id AND (local_id IS NULL OR local_id=0)) as tpl,
    (SELECT COUNT(*) FROM locais WHERE obra_id=o.id AND ativo=1) as nlocais,
    (SELECT COUNT(*) FROM etapas WHERE obra_id=o.id AND local_id IS NOT NULL AND status='concluida') as nconcl
    FROM obras o LEFT JOIN locais l ON o.local_id=l.id WHERE o.ativo=1`;
  const p = [];
  if (req.query.status) { sql += ' AND o.status=?'; p.push(req.query.status); }
  res.json(await db.prepare(sql + ' ORDER BY o.criado_em DESC').all(...p));
});

app.get('/api/obras/:id', async (req, res) => {
  const o = await db.prepare(`SELECT o.*, l.nome as local_nome, l.comarca as local_comarca, l.endereco as local_endereco,
    l.cameras as local_cameras, l.latitude as local_latitude, l.longitude as local_longitude,
    l.google_maps_link as local_google_maps_link
    FROM obras o LEFT JOIN locais l ON o.local_id=l.id WHERE o.id=?`).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Obra nao encontrada' });
  o.etapas = await db.prepare('SELECT * FROM etapas WHERE obra_id=? ORDER BY ordem').all(req.params.id);
  res.json(o);
});

app.post('/api/obras', gestor, async (req, res) => {
  const { nome, local_id, comarca, prazo_dias, data_inicio, responsavel, descricao } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO obras (nome,local_id,comarca,prazo_dias,data_inicio,responsavel,descricao) VALUES (?,?,?,?,?,?,?)')
    .run(nome, local_id || null, comarca || '', prazo_dias || 30, data_inicio || null, responsavel || '', descricao || '');
  // Sequência lógica Obra→Modelo: planta o checklist a partir do vocabulário (atividades ativas).
  // Sem isso a obra nascia sem modelo, o modal vinha vazio e o auto-etapa caía em ordem 999.
  try {
    const atvs = await db.prepare('SELECT nome FROM atividades WHERE ativo=1 ORDER BY id').all();
    let ord = 1;
    for (const a of atvs) {
      const ex = await db.prepare('SELECT id FROM etapas WHERE obra_id=? AND local_id IS NULL AND UPPER(nome)=UPPER(?)').get(r.lastInsertRowid, a.nome);
      if (!ex) await db.prepare("INSERT INTO etapas (obra_id,local_id,nome,ordem,status) VALUES (?,?,?,?,'pendente')").run(r.lastInsertRowid, null, a.nome, ord++);
    }
  } catch (e) { console.error('[obra-template]', e.message); }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/obras/:id', gestor, async (req, res) => {
  const atual = await db.prepare('SELECT * FROM obras WHERE id=?').get(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Obra nao encontrada' });
  const b = req.body || {};
  const nome = (b.nome !== undefined ? b.nome : atual.nome || '').toString().trim();
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const local_id = b.local_id === undefined || b.local_id === '' || b.local_id === null ? (b.local_id === null ? null : atual.local_id) : Number(b.local_id);
  const comarca = b.comarca !== undefined ? b.comarca : atual.comarca;
  const prazo_dias = b.prazo_dias !== undefined && b.prazo_dias !== '' ? Number(b.prazo_dias) || 30 : atual.prazo_dias;
  const data_inicio = b.data_inicio !== undefined ? (b.data_inicio || null) : atual.data_inicio;
  const status = b.status !== undefined ? b.status : atual.status;
  if (status && !['planejamento', 'em_andamento', 'concluida'].includes(status)) return res.status(400).json({ error: 'Status invalido' });
  const responsavel = b.responsavel !== undefined ? b.responsavel : atual.responsavel;
  const descricao = b.descricao !== undefined ? b.descricao : atual.descricao;
  await db.prepare('UPDATE obras SET nome=?,local_id=?,comarca=?,prazo_dias=?,data_inicio=?,status=?,responsavel=?,descricao=? WHERE id=?')
    .run(nome, local_id, comarca, prazo_dias, data_inicio, status, responsavel, descricao, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/obras/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE obras SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/obras/:id/toggle', gestor, async (req, res) => {
  const o = await db.prepare('SELECT status FROM obras WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Obra nao encontrada' });
  const novo = o.status === 'concluida' ? 'em_andamento' : 'concluida';
  await db.prepare('UPDATE obras SET status=? WHERE id=?').run(novo, req.params.id);
  res.json({ ok: true, status: novo });
});

// ============================================================
// ETAPAS
// ============================================================
app.get('/api/obras/:obra_id/etapas', async (req, res) => {
  // Modelo primeiro, depois per-local com nome do local (o modal separa os 2 grupos)
  res.json(await db.prepare(`SELECT e.*, l.nome as local_nome FROM etapas e LEFT JOIN locais l ON l.id=e.local_id
    WHERE e.obra_id=? ORDER BY CASE WHEN e.local_id IS NULL OR e.local_id=0 THEN 0 ELSE 1 END, e.ordem`).all(req.params.obra_id));
});

app.post('/api/obras/:obra_id/etapas', gestor, async (req, res) => {
  const { nome, ordem, observacoes } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO etapas (obra_id,nome,ordem,observacoes) VALUES (?,?,?,?)')
    .run(req.params.obra_id, nome, ordem || 1, observacoes || '');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/etapas/:id', gestor, async (req, res) => {
  const { nome, ordem, status, data_inicio, data_fim, observacoes } = req.body;
  await db.prepare('UPDATE etapas SET nome=?,ordem=?,status=?,data_inicio=?,data_fim=?,observacoes=? WHERE id=?')
    .run(nome, ordem, status, data_inicio, data_fim, observacoes, req.params.id);
  // Atualizar progresso da obra
  const etapa = await db.prepare('SELECT obra_id FROM etapas WHERE id=?').get(req.params.id);
  if (etapa) await atualizarProgresso(etapa.obra_id);
  res.json({ ok: true });
});

app.delete('/api/etapas/:id', gestor, async (req, res) => {
  const etapa = await db.prepare('SELECT obra_id FROM etapas WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM etapas WHERE id=?').run(req.params.id);
  if (etapa) await atualizarProgresso(etapa.obra_id);
  res.json({ ok: true });
});

async function atualizarProgresso(obraId) {
  // Fonte única: concluidas per-local / (locais × modelo) — igual ao Relatórios (etapas-desempenho).
  // Antes misturava modelo + per-local no mesmo COUNT e só recalculava no toque manual → barra stale.
  const tpl = Number((await db.prepare('SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0)').get(obraId)).c) || 0;
  const locs = await db.prepare('SELECT id FROM locais WHERE ativo=1 AND obra_id=?').all(obraId);
  if (tpl > 0 && locs.length) {
    const ids = locs.map(l => l.id);
    const row = await db.prepare(`SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND local_id IN (${ids.map(() => '?').join(',')}) AND status='concluida'`).get(obraId, ...ids);
    const pct = Math.round(((Number(row.c) || 0) / (locs.length * tpl)) * 100);
    await db.prepare('UPDATE obras SET progresso=? WHERE id=?').run(Math.min(100, pct), obraId);
  } else if (locs.length) {
    // Sem modelo: locais com ≥1 RDO / total (mesma regra do Estoque)
    const com = await db.prepare('SELECT COUNT(DISTINCT local) as c FROM rdos WHERE obra_id=?').get(obraId);
    const pct = Math.round((Math.min(Number(com.c) || 0, locs.length) / locs.length) * 100);
    await db.prepare('UPDATE obras SET progresso=? WHERE id=?').run(pct, obraId);
  } else {
    await db.prepare('UPDATE obras SET progresso=0 WHERE id=?').run(obraId);
  }
}

// ============================================================
// LOCAIS
// ============================================================
app.get('/api/locais', async (req, res) => {
  // ?ativo=0 → só inativos | ?ativo=todos → todos (p/ reativar) | padrão: só ativos
  const fAtivo = req.query.ativo === 'todos' ? '' : (req.query.ativo === '0' ? ' AND ativo=0' : ' AND ativo=1');
  let sql = 'SELECT * FROM locais WHERE 1=1' + fAtivo;
  const p = [];
  if (req.query.obra_id) {
    // F1: filtra direto por obra_id (novo). Mantém fallback TJ-CE global para dados legados sem obra_id
    const obra = await db.prepare('SELECT nome FROM obras WHERE id=?').get(req.query.obra_id);
    const isGlobal = obra && obra.nome && obra.nome.trim().toUpperCase().replace(/[-\s]/g,'') === 'TJCE';
    sql += ' AND (obra_id=?' + (isGlobal ? ' OR obra_id IS NULL' : '') + ')'; p.push(req.query.obra_id);
  }
  if (req.query.equipe_id) { sql += ' AND equipe_id=?'; p.push(req.query.equipe_id); }
  if (req.query.comarca) { sql += ' AND UPPER(comarca)=UPPER(?)'; p.push(req.query.comarca); }
  if (req.query.regiao) { sql += ' AND regiao=?'; p.push(req.query.regiao); } // deprecated, mantido para compat
  if (req.query.busca) { sql += ' AND (nome LIKE ? OR comarca LIKE ? OR endereco LIKE ?)'; p.push('%' + req.query.busca + '%', '%' + req.query.busca + '%', '%' + req.query.busca + '%'); }
  res.json(await db.prepare(sql + ' ORDER BY comarca, nome').all(...p));
});

app.get('/api/locais/comarcas', async (req, res) => {
  let sql='SELECT DISTINCT comarca FROM locais WHERE ativo=1 AND comarca IS NOT NULL';
  const p=[];
  if(req.query.obra_id){ sql+=' AND obra_id=?'; p.push(req.query.obra_id); }
  res.json((await db.prepare(sql+' ORDER BY comarca').all(...p)).map(r=>r.comarca));
});

// Locais da equipe com progresso dinâmico per-local via RDO/etapas — multi-obra com normalização EQUIPE5==EQUIPE 5
app.get('/api/equipe/:regiao/locais', async (req, res) => {
  const reg = req.params.regiao;
  const norm = normEquipe(reg);
  const isSem = norm === normEquipe('SEM EQUIPE');
  const tjce = await db.prepare("SELECT id, nome, progresso, status, prazo_dias, data_inicio FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
  const totalTpl = tjce ? (await db.prepare('SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0)').get(tjce.id)).c : 0;
  async function enrich(rows){
    for (const r of rows){
      if (!r.obra_id && tjce) { r.obra_id = tjce.id; r.obra_nome = tjce.nome; r.obra_status = tjce.status; r.prazo_dias = tjce.prazo_dias; r.data_inicio = tjce.data_inicio; }
      if (tjce && totalTpl>0) {
        const concl = (await db.prepare("SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND local_id=? AND status='concluida'").get(tjce.id, r.id)).c;
        r.obra_progresso = Math.round(concl/totalTpl*100);
        r.etapas_concluidas = concl; r.etapas_total = totalTpl;
      } else if (tjce) {
        const hasRdo = (await db.prepare('SELECT COUNT(*) as c FROM rdos WHERE local=?').get(r.nome)).c;
        r.obra_progresso = hasRdo>0 ? 100 : 0;
      }
    }
    rows.sort((a,b)=>(a.obra_progresso||0)-(b.obra_progresso||0));
    return rows;
  }
  // SEM EQUIPE: regiao nula/vazia
  if (isSem) {
    const sem = await db.prepare(`
      SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status FROM locais l LEFT JOIN obras o ON o.local_id=l.id AND o.ativo=1
      WHERE l.ativo=1 AND (l.regiao IS NULL OR TRIM(l.regiao)='')
      ORDER BY l.comarca LIMIT 100
    `).all();
    return res.json(await enrich(sem));
  }
  // Tenta localizar equipe pelo nome normalizado -> filtra por equipe_id OU regiao normalizada (compat legado)
  const equipes = await db.prepare('SELECT id,nome FROM equipes WHERE ativo=1').all();
  const eq = equipes.find(e=> normEquipe(e.nome)===norm);
  let rows=[];
  if(eq){
    rows = await db.prepare(`
      SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status, o.prazo_dias, o.data_inicio
      FROM locais l LEFT JOIN obras o ON o.local_id = l.id AND o.ativo=1
      WHERE l.ativo=1 AND (l.equipe_id=? OR UPPER(REPLACE(REPLACE(l.regiao,' ',''),'-',''))=UPPER(REPLACE(REPLACE(?,' ',''),'-','')))
      ORDER BY l.comarca
    `).all(eq.id, reg);
    // fallback normalizado JS se ainda vazio (acentos)
    if(!rows.length){
      const all = await db.prepare(`SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status, o.prazo_dias, o.data_inicio FROM locais l LEFT JOIN obras o ON o.local_id=l.id AND o.ativo=1 WHERE l.ativo=1 ORDER BY l.comarca`).all();
      rows = all.filter(l=> normEquipe(l.regiao)===norm || String(l.equipe_id)===String(eq.id));
    }
  } else {
    rows = await db.prepare(`
      SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status, o.prazo_dias, o.data_inicio
      FROM locais l LEFT JOIN obras o ON o.local_id = l.id AND o.ativo=1
      WHERE l.ativo=1 AND l.regiao = ?
      ORDER BY l.comarca
    `).all(reg);
    if(!rows.length){
      const all = await db.prepare(`SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status, o.prazo_dias, o.data_inicio FROM locais l LEFT JOIN obras o ON o.local_id=l.id AND o.ativo=1 WHERE l.ativo=1 ORDER BY l.comarca`).all();
      rows = all.filter(l=> normEquipe(l.regiao)===norm);
    }
  }
  res.json(await enrich(rows));
});

// Atribuir locais a equipe/obra (F1 multi-obra) - suporta obra_id+equipe_id e legado regiao
app.post('/api/locais/atribuir-equipe', gestor, async (req, res) => {
  const { ids, obra_id, equipe_id, regiao } = req.body;
  if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({error:'Selecione ao menos 1 local'});
  // Resolve equipe_id/regiao (compat)
  let eqId = equipe_id ? Number(equipe_id) : null;
  let regNorm = (regiao||'').toString().trim();
  let obraId = obra_id ? Number(obra_id) : null;
  if (!eqId && regNorm && regNorm!=='SEM EQUIPE') {
    const eq = await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1').get(regNorm);
    if (!eq) return res.status(400).json({error:'Equipe não encontrada. Crie em Equipes primeiro.'});
    eqId = eq.id;
  } else if (eqId) {
    const eq = await db.prepare('SELECT id, nome FROM equipes WHERE id=? AND ativo=1').get(eqId);
    if (!eq) return res.status(400).json({error:'Equipe não encontrada'});
    regNorm = eq.nome;
  }
  if (regNorm==='SEM EQUIPE') { eqId=null; regNorm=''; }
  // Se obra_id não veio, tenta inferir da primeira local ou usa TJ-CE como fallback
  if (!obraId) {
    const tjce = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
    obraId = tjce ? tjce.id : null;
  }
  for (const id of ids) {
    await db.prepare('UPDATE locais SET regiao=?, equipe_id=?, obra_id=? WHERE id=?').run(regNorm, eqId, obraId, Number(id));
  }
  res.json({ok:true, atualizados: ids.length, obra_id: obraId, equipe_id: eqId});
});

app.get('/api/locais/:id', async (req, res) => {
  const l = await db.prepare('SELECT * FROM locais WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Local nao encontrado' });
  res.json(l);
});

app.post('/api/locais', gestor, async (req, res) => {
  const { nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras, obra_id, equipe_id } = req.body;
  if (!nome || !nome.toString().trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO locais (nome,comarca,nome_imovel,tipo,ocupacao,endereco,area,longitude,latitude,google_maps_link,street_view_link,cameras,obra_id,equipe_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(nome, comarca || '', nome_imovel || '', tipo || '', ocupacao || '', endereco || '', area || '', longitude || '', latitude || '', google_maps_link || '', street_view_link || '', cameras || 0, obra_id||null, equipe_id||null);
  // Mantém regiao string para compatibilidade com app antigo
  if (equipe_id) {
    const eq = await db.prepare('SELECT nome FROM equipes WHERE id=?').get(Number(equipe_id));
    if (eq) await db.prepare('UPDATE locais SET regiao=? WHERE id=?').run(eq.nome, r.lastInsertRowid);
  }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/locais/:id', gestor, async (req, res) => {
  const atual = await db.prepare('SELECT * FROM locais WHERE id=?').get(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Local nao encontrado' });
  const { nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras, obra_id, equipe_id, regiao, ativo } = req.body;
  // Merge com atual para permitir PATCH parcial (usado por vincular/desvincular)
  const novoNome = nome !== undefined ? nome : atual.nome;
  const novoComarca = comarca !== undefined ? comarca : atual.comarca;
  const novoNomeImovel = nome_imovel !== undefined ? nome_imovel : atual.nome_imovel;
  const novoTipo = tipo !== undefined ? tipo : atual.tipo;
  const novoOcupacao = ocupacao !== undefined ? ocupacao : atual.ocupacao;
  const novoEndereco = endereco !== undefined ? endereco : atual.endereco;
  const novoArea = area !== undefined ? area : atual.area;
  const novoLon = longitude !== undefined ? longitude : atual.longitude;
  const novoLat = latitude !== undefined ? latitude : atual.latitude;
  const novoGmaps = google_maps_link !== undefined ? google_maps_link : atual.google_maps_link;
  const novoStreet = street_view_link !== undefined ? street_view_link : atual.street_view_link;
  const novoCams = cameras !== undefined ? cameras : atual.cameras;
  let novoObraId = obra_id !== undefined ? (obra_id ? Number(obra_id) : null) : atual.obra_id;
  let novoEquipeId = equipe_id !== undefined ? (equipe_id ? Number(equipe_id) : null) : atual.equipe_id;
  let novoRegiao = regiao !== undefined ? regiao : atual.regiao;
  if (equipe_id !== undefined) {
    if (equipe_id) {
      const eq = await db.prepare('SELECT nome FROM equipes WHERE id=?').get(Number(equipe_id));
      if (eq) novoRegiao = eq.nome;
    } else {
      novoRegiao = '';
    }
  } else if (regiao !== undefined) {
    novoRegiao = regiao;
    if (regiao) {
      const eq = await db.prepare('SELECT id FROM equipes WHERE nome=?').get(regiao);
      if (eq) novoEquipeId = eq.id;
    } else {
      novoEquipeId = null;
    }
  }
  await db.prepare('UPDATE locais SET nome=?,comarca=?,nome_imovel=?,tipo=?,ocupacao=?,endereco=?,area=?,longitude=?,latitude=?,google_maps_link=?,street_view_link=?,cameras=?,obra_id=?,equipe_id=?,regiao=?,ativo=? WHERE id=?')
    .run(novoNome, novoComarca, novoNomeImovel, novoTipo, novoOcupacao, novoEndereco, novoArea, novoLon, novoLat, novoGmaps, novoStreet, novoCams, novoObraId, novoEquipeId, novoRegiao, ativo !== undefined ? (Number(ativo) ? 1 : 0) : atual.ativo, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/locais/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE locais SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// PLANTA DO LOCAL + CHECKLIST DE PONTOS (conferência CCTV/infra)
// - Planta: PDF/foto por local; QR impresso aponta p/ /app?local=ID
// - Pontos: CAM 01..N / infra com status; técnica avança até TESTADA,
//   APROVADA só gestor. Resumo diário p/ acompanhar produção.
// ============================================================
const PONTOS_STATUS = ['a_instalar', 'instalada', 'cabeada', 'configurada', 'testada', 'aprovada'];
const plantasDir = path.join(uploadsDir, 'plantas');
if (!fs.existsSync(plantasDir)) fs.mkdirSync(plantasDir, { recursive: true });
const uploadPlanta = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, plantasDir),
    filename: (req, file, cb) => cb(null, 'planta_' + req.params.id + '_' + Date.now() + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|jpe?g|png)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Só PDF, JPG ou PNG'));
  }
});
app.get('/api/locais/:id/plantas', async (req, res) => {
  // migração preguiçosa: planta única antiga vira item "Geral"
  try {
    const ant = await db.prepare('SELECT planta_url FROM locais WHERE id=?').get(req.params.id);
    if (ant?.planta_url) {
      const n = await db.prepare('SELECT COUNT(*) as c FROM local_plantas WHERE local_id=?').get(req.params.id);
      if (!Number(n?.c)) await db.prepare('INSERT INTO local_plantas (local_id, titulo, url) VALUES (?,?,?)').run(req.params.id, 'Geral', ant.planta_url);
    }
  } catch (e) {}
  res.json(await db.prepare('SELECT * FROM local_plantas WHERE local_id=? ORDER BY id').all(req.params.id));
});
app.post('/api/locais/:id/plantas', gestor, (req, res) => {
  uploadPlanta.single('planta')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Falha no upload' });
    if (!req.file) return res.status(400).json({ error: 'Envie o arquivo (planta)' });
    const url = '/uploads/plantas/' + req.file.filename;
    const titulo = ((req.body && req.body.titulo) || 'Geral').toString().slice(0, 60);
    const r = await db.prepare('INSERT INTO local_plantas (local_id, titulo, url) VALUES (?,?,?)').run(req.params.id, titulo, url);
    res.json({ ok: true, id: r.lastInsertRowid, titulo, url });
  });
});
app.delete('/api/plantas/:id', gestor, async (req, res) => {
  const ant = await db.prepare('SELECT url FROM local_plantas WHERE id=?').get(req.params.id);
  await db.prepare('DELETE FROM local_plantas WHERE id=?').run(req.params.id);
  if (ant?.url) { try { fs.unlinkSync(path.join(__dirname, ant.url)); } catch (e) {} }
  res.json({ ok: true });
});
app.get('/api/locais/:id/pontos', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM local_pontos WHERE local_id=? ORDER BY tipo, codigo').all(req.params.id);
  res.json(rows);
});
app.post('/api/locais/:id/pontos', gestor, async (req, res) => {
  const { tipo, codigo, descricao } = req.body;
  if (!codigo || !codigo.trim()) return res.status(400).json({ error: 'Código obrigatório (ex: CAM 01)' });
  const loc = await db.prepare('SELECT id, obra_id FROM locais WHERE id=?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Local não encontrado' });
  const r = await db.prepare(`INSERT INTO local_pontos (local_id, obra_id, tipo, codigo, descricao, status, atualizado_por) VALUES (?,?,?,?,?,?,?)`)
    .run(loc.id, loc.obra_id, (tipo || 'camera'), codigo.trim().toUpperCase(), (descricao || '').trim(), 'a_instalar', req.user ? req.user.nome : '');
  res.json({ ok: true, id: r.lastInsertRowid });
});
// Gera N pontos CAM a partir da qtd de câmeras do local (pula códigos existentes)
app.post('/api/locais/:id/pontos/gerar', gestor, async (req, res) => {
  const loc = await db.prepare('SELECT id, obra_id, cameras FROM locais WHERE id=?').get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Local não encontrado' });
  const qtd = Math.max(0, Number(req.body.qtd_cameras ?? loc.cameras) || 0);
  if (!qtd) return res.status(400).json({ error: 'Local sem qtd de câmeras — informe qtd_cameras' });
  const exis = new Set((await db.prepare('SELECT codigo FROM local_pontos WHERE local_id=?').all(loc.id)).map(x => x.codigo));
  let criados = 0;
  for (let i = 1; i <= qtd; i++) {
    const cod = 'CAM ' + String(i).padStart(2, '0');
    if (exis.has(cod)) continue;
    await db.prepare(`INSERT INTO local_pontos (local_id, obra_id, tipo, codigo, status, atualizado_por) VALUES (?,?,?,?,?,?)`)
      .run(loc.id, loc.obra_id, 'camera', cod, 'a_instalar', req.user ? req.user.nome : '');
    criados++;
  }
  res.json({ ok: true, criados, total: qtd });
});
app.put('/api/pontos/:id', async (req, res) => {
  const p = await db.prepare('SELECT * FROM local_pontos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Ponto não encontrado' });
  const { status, observacao, rdo_id } = req.body;
  if (status && !PONTOS_STATUS.includes(status)) return res.status(400).json({ error: 'Status inválido' });
  if (status === 'aprovada' && req.user.perfil !== 'gestor') return res.status(403).json({ error: 'Só o gestor aprova' });
  const set = [], vals = [];
  if (status) { set.push('status=?'); vals.push(status); }
  if (observacao !== undefined) { set.push('observacao=?'); vals.push(String(observacao).slice(0, 500)); }
  if (rdo_id !== undefined) { set.push('rdo_id=?'); vals.push(rdo_id ? Number(rdo_id) : null); }
  set.push('atualizado_por=?'); vals.push(req.user ? req.user.nome : '');
  if (db.isPostgres) { set.push('atualizado_em=NOW()'); } else { set.push(`atualizado_em=datetime('now')`); }
  vals.push(req.params.id);
  await db.prepare(`UPDATE local_pontos SET ${set.join(', ')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});
app.delete('/api/pontos/:id', gestor, async (req, res) => {
  await db.prepare('DELETE FROM local_pontos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Resumo diário: pontos concluídos (testada/aprovada) por equipe e por local
app.get('/api/pontos/resumo', async (req, res) => {
  const { obra_id, data } = req.query;
  const dia = (data || new Date().toISOString().slice(0, 10)).slice(0, 10);
  let sql = `SELECT p.*, l.nome as local_nome, l.equipe_id, e.nome as equipe_nome FROM local_pontos p
    JOIN locais l ON l.id=p.local_id LEFT JOIN equipes e ON e.id=l.equipe_id WHERE 1=1`;
  const prm = [];
  if (obra_id) { sql += ' AND p.obra_id=?'; prm.push(Number(obra_id)); }
  const rows = await db.prepare(sql).all(...prm);
  const noDia = v => { try { const s = (v instanceof Date) ? v.toISOString() : String(v || ''); return s.slice(0, 10) === dia; } catch (e) { return false; } };
  const feito = s => s === 'testada' || s === 'aprovada';
  const porEquipe = {}, porLocal = {};
  let total = 0, concluidos = 0, concluidosHoje = 0;
  for (const r of rows) {
    total++;
    const eq = r.equipe_nome || 'SEM EQUIPE';
    const lc = r.local_nome || ('Local ' + r.local_id);
    porEquipe[eq] = porEquipe[eq] || { equipe_nome: eq, total: 0, concluidos: 0, concluidos_hoje: 0 };
    porLocal[lc] = porLocal[lc] || { local_id: r.local_id, local_nome: lc, total: 0, concluidos: 0, concluidos_hoje: 0 };
    porEquipe[eq].total++; porLocal[lc].total++;
    if (feito(r.status)) {
      concluidos++; porEquipe[eq].concluidos++; porLocal[lc].concluidos++;
      if (noDia(r.atualizado_em)) { concluidosHoje++; porEquipe[eq].concluidos_hoje++; porLocal[lc].concluidos_hoje++; }
    }
  }
  res.json({ data: dia, total, concluidos, concluidos_hoje: concluidosHoje,
    porEquipe: Object.values(porEquipe).sort((a, b) => b.concluidos_hoje - a.concluidos_hoje),
    porLocal: Object.values(porLocal).sort((a, b) => b.concluidos_hoje - a.concluidos_hoje) });
});

// Importar locais do Excel
app.post('/api/locais/importar', gestor, async (req, res) => {
  const { locais } = req.body;
  if (!locais || !Array.isArray(locais)) return res.status(400).json({ error: 'Dados obrigatorios' });
  const stmt = db.prepare('INSERT INTO locais (nome,comarca,nome_imovel,tipo,ocupacao,endereco,area,longitude,latitude,google_maps_link,street_view_link,cameras) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  let count = 0;
  for (const l of locais) {
    await stmt.run(l.nome || l.Name || '', l.comarca || l.Comarca || '', l.nome_imovel || l['Nome do imovel'] || '', l.tipo || l.Tipo || '', l.ocupacao || l.Ocupacao || '', l.endereco || l.Endereco || '', l.area || l['Area construida'] || '', l.longitude || l.Longitude || '', l.latitude || l.Latitude || '', l.google_maps_link || l['Google Maps Link'] || '', l.street_view_link || l['Street View Link'] || '', l.cameras || l.Cameras || 0);
    count++;
  }
  res.json({ ok: true, importados: count });
});

// Importar TJCE_Mesclado com deduplicacao e vinculo a equipes (REGIAO)
app.post('/api/locais/importar-mesclado', gestor, async (req, res) => {
  const { linhas } = req.body;
  if (!linhas || !Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Envie {linhas:[...]} com dados do Excel' });

  // Cores fixas por regiao
  const coresRegiao = { 'Equipe 1': '#1565c0', 'Equipe 2': '#2e7d32', 'Equipe 3': '#ef6c00', 'Equipe 4': '#6a1b9a', 'TERCEIRIZADA': '#c62828' };

  // Garantir equipes para regioes encontradas
  const regioes = [...new Set(linhas.map(l=> (l['REGIAO'] || l.regiao || '').toString().trim()).filter(Boolean))];
  for (const reg of regioes) {
    const nomeEq = reg.trim();
    if (!await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1').get(nomeEq)) {
      await db.prepare('INSERT INTO equipes (nome,cor) VALUES (?,?)').run(nomeEq, coresRegiao[nomeEq] || '#455a64');
    }
  }

  // Upsert idempotente: chave estável = COMARCA + NOME DO IMÓVEL + ENDEREÇO (não inclui area/cameras que são graváveis)
  // Reimportar a mesma planilha com dados novos só atualiza, nunca duplica - normalizado sem acento
  const normKey = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,' ');
  const mapa = new Map();
  linhas.forEach(l => {
    const comarca = (l['COMARCA'] || l.comarca || l.Comarca || '').toString().trim();
    const endereco = (l['Endereco'] || l.endereco || l.Endereco || '').toString().trim();
    if (!endereco) return;
    const nomeImovelTmp = (l['NOME DO IMÓVEL'] || l['NOME DO IMOVEL'] || l.nome_imovel || l.nome || l.Name || '').toString().trim();
    const key = (normKey(comarca) + '|' + normKey(nomeImovelTmp) + '|' + normKey(endereco));
    const existente = mapa.get(key);
    const cam_fixa = parseInt(l['CAM FIXA'] || l.cam_fixa || l['CAM FIXA'] || 0) || 0;
    const cam_ana = parseInt(l['CAM ANALÍTICA'] || l['CAM ANALITICA'] || l.cam_analitica || 0) || 0;
    const cam_lpr = parseInt(l['CAM LPR'] || l.cam_lpr || 0) || 0;
    const etapa = (l['ETAPA'] || l.etapa || '').toString().trim();
    const status = (l['STATUS PROJETO'] || l.status_projeto || '').toString().trim();
    const regiao = (l['REGIAO'] || l.regiao || '').toString().trim();
    const cronograma = (l['CRONOGRAMA'] || l.cronograma || '').toString().trim();
    if (!existente) {
      mapa.set(key, {
        comarca, endereco,
        nome: (l['NOME DO IMÓVEL'] || l['NOME DO IMOVEL'] || l.nome || l.Name || l['NOME DO IMOVEL'] || endereco).toString().trim() || endereco,
        nome_imovel: (l['NOME DO IMÓVEL'] || l['NOME DO IMOVEL'] || '').toString().trim(),
        tipo: (l['Tipo'] || l.tipo || '').toString().trim(),
        ocupacao: (l['Ocupacao'] || l.ocupacao || '').toString().trim(),
        area: (l['Area construida'] || l.area || '').toString().trim(),
        longitude: (l['Longitude'] || l.longitude || '').toString().trim(),
        latitude: (l['Latitude'] || l.latitude || '').toString().trim(),
        google_maps_link: (l['Google Maps Link'] || l.google_maps_link || '').toString().trim(),
        street_view_link: (l['Street View Link'] || l.street_view_link || '').toString().trim(),
        cam_fixa, cam_analitica: cam_ana, cam_lpr,
        cameras: cam_fixa + cam_ana + cam_lpr,
        status_projeto: status, etapa, regiao, cronograma,
        terceirizada: regiao.toUpperCase()==='TERCEIRIZADA' ? 1 : 0
      });
    } else {
      // mesma chave (mesmo imóvel) aparece de novo na planilha com dados atualizados -> sobrescreve com o mais recente (upsert)
      if (etapa) existente.etapa = etapa;
      if (status) existente.status_projeto = status;
      if (regiao) { existente.regiao = regiao; existente.terceirizada = regiao.toUpperCase()==='TERCEIRIZADA'?1:0; }
      if (cronograma) existente.cronograma = cronograma;
      if (l['Longitude']) existente.longitude = l['Longitude'].toString();
      if (l['Latitude']) existente.latitude = l['Latitude'].toString();
      if (l['Area construida'] || l.area) existente.area = (l['Area construida'] || l.area || existente.area).toString().trim();
      // cameras sempre sobrescreve se informado
      existente.cam_fixa = cam_fixa; existente.cam_analitica = cam_ana; existente.cam_lpr = cam_lpr; existente.cameras = cam_fixa+cam_ana+cam_lpr;
      existente.tipo = (l['Tipo'] || existente.tipo).toString().trim() || existente.tipo;
      existente.ocupacao = (l['Ocupacao'] || existente.ocupacao).toString().trim() || existente.ocupacao;
    }
  });

  let inseridos=0, atualizados=0, semCoord=0;
  // Normalização para idempotência (remove acentos, caixa, espaços) - evita duplicar se planilha vier com variação
  const norm = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,' ');
  const existentes = await db.prepare('SELECT id, comarca, endereco, nome, nome_imovel FROM locais WHERE ativo=1').all();
  const mapExist = new Map();
  existentes.forEach(r=>{
    const k = norm(r.comarca)+'|'+norm(r.nome_imovel||r.nome)+'|'+norm(r.endereco);
    if (!mapExist.has(k)) mapExist.set(k, r.id);
  });
  const stmtIns = await db.prepare(`INSERT INTO locais (nome,comarca,nome_imovel,tipo,ocupacao,endereco,area,longitude,latitude,google_maps_link,street_view_link,cameras,status_projeto,etapa,cam_fixa,cam_analitica,cam_lpr,regiao,cronograma,terceirizada) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stmtUpd = await db.prepare(`UPDATE locais SET nome=?,comarca=?,nome_imovel=?,tipo=?,ocupacao=?,endereco=?,area=?,longitude=?,latitude=?,google_maps_link=?,street_view_link=?,cameras=?,status_projeto=?,etapa=?,cam_fixa=?,cam_analitica=?,cam_lpr=?,regiao=?,cronograma=?,terceirizada=? WHERE id=?`);
  for (const v of mapa.values()) {
      if (!v.longitude || !v.latitude) semCoord++;
      const k = norm(v.comarca)+'|'+norm(v.nome_imovel||v.nome)+'|'+norm(v.endereco);
      const exId = mapExist.get(k);
      if (exId) { await stmtUpd.run(v.nome, v.comarca, v.nome_imovel, v.tipo, v.ocupacao, v.endereco, v.area, v.longitude, v.latitude, v.google_maps_link, v.street_view_link, v.cameras, v.status_projeto, v.etapa, v.cam_fixa, v.cam_analitica, v.cam_lpr, v.regiao, v.cronograma, v.terceirizada, exId); atualizados++; }
      else { await stmtIns.run(v.nome, v.comarca, v.nome_imovel, v.tipo, v.ocupacao, v.endereco, v.area, v.longitude, v.latitude, v.google_maps_link, v.street_view_link, v.cameras, v.status_projeto, v.etapa, v.cam_fixa, v.cam_analitica, v.cam_lpr, v.regiao, v.cronograma, v.terceirizada); inseridos++; mapExist.set(k, -1); }
    }
  res.json({ ok:true, regioes, unicos: mapa.size, total_linhas: linhas.length, inseridos, atualizados, semCoord, equipes_criadas: regioes.length });
});

// Importar materiais da lista (auto-categoriza para organização visual)
function categoriaAuto(nome){
  const n = nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (/(camera|cam )/.test(n)) return 'Câmeras';
  if (/(cabo|cabeamento|utp|optico|fibra)/.test(n)) return 'Cabeamento';
  if (/(switch|olt|onu|ont|gbic|splitter|dio|roseta|cordao|patch|olt|gpon)/.test(n)) return 'Óptico / Ativos';
  if (/(rack|bandeja|guia|porca|regua|nobreak|bateria)/.test(n)) return 'Infra Rack';
  if (/(eletroduto|condulete|curva|luva|tubo|caixa|canaleta|sealtubo|box|bucha|niple|tampao|tampa|uniao)/.test(n)) return 'Infra Elétrica';
  if (/(parafuso|bucha|abracadeira|arruela|prego|velcro|joystick|suporte)/.test(n)) return 'Fixação';
  return 'Geral';
}
app.post('/api/materiais/importar', gestor, async (req, res) => {
  const { texto, categoria } = req.body;
  if (!texto) return res.status(400).json({ error: 'Texto obrigatorio' });
  const stmt = await db.prepare('INSERT OR IGNORE INTO materiais (nome,categoria) VALUES (?,?)');
  let count = 0;
  for (const linha of texto.split('\n')) {
    const nome = linha.trim();
    if (nome) {
      const cat = categoria || categoriaAuto(nome);
      await stmt.run(nome, cat); count++;
    }
  }
  res.json({ ok: true, importados: count });
});

// ============================================================
// ATIVIDADES
// ============================================================
app.get('/api/atividades', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM atividades WHERE ativo=1 ORDER BY nome').all());
});

app.post('/api/atividades', gestor, async (req, res) => {
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO atividades (nome) VALUES (?)').run(nome);
  // Vocabulário→Modelo: nova atividade entra no checklist das obras (sem duplicar).
  // Antes o RDO aceitava a atividade mas o modelo não tinha → etapa per-local ordem 999 e progresso cego.
  try {
    const obras = await db.prepare('SELECT id FROM obras WHERE ativo=1').all();
    for (const o of obras) {
      const ex = await db.prepare('SELECT id FROM etapas WHERE obra_id=? AND local_id IS NULL AND UPPER(nome)=UPPER(?)').get(o.id, nome);
      if (!ex) {
        const mx = await db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0)').get(o.id);
        await db.prepare("INSERT INTO etapas (obra_id,local_id,nome,ordem,status) VALUES (?,?,?,?,'pendente')").run(o.id, null, nome, (Number(mx.m) || 0) + 1);
      }
    }
  } catch (e) { console.error('[atividade-template]', e.message); }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.delete('/api/atividades/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE atividades SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// MATERIAIS (catalogo do gestor)
// ============================================================
app.get('/api/materiais', async (req, res) => {
  let sql = 'SELECT * FROM materiais WHERE ativo=1';
  const p = [];
  if (req.query.categoria) { sql += ' AND categoria=?'; p.push(req.query.categoria); }
  let rows = await db.prepare(sql + ' ORDER BY categoria, nome').all(...p);
  if (req.query.busca) {
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const buscaNorm = norm(req.query.busca);
    rows = rows.filter(r => norm(r.nome).includes(buscaNorm));
  }
  res.json(rows);
});

app.post('/api/materiais', gestor, async (req, res) => {
  const { nome, categoria, unidade, quantidade_minima } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO materiais (nome,categoria,unidade,quantidade_minima) VALUES (?,?,?,?)').run(nome, categoria || 'Geral', unidade || 'UND', Number(quantidade_minima) || 0);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/materiais/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const atual = await db.prepare('SELECT * FROM materiais WHERE id=?').get(id);
  if (!atual) return res.status(404).json({ error: 'Material não encontrado' });
  const { nome, categoria, unidade, quantidade_minima } = req.body;
  await db.prepare('UPDATE materiais SET nome=?, categoria=?, unidade=?, quantidade_minima=? WHERE id=?')
    .run(
      (nome || atual.nome).trim(),
      categoria != null ? categoria : atual.categoria,
      unidade != null ? unidade : (atual.unidade || 'UND'),
      quantidade_minima != null ? (Number(quantidade_minima) || 0) : (Number(atual.quantidade_minima) || 0),
      id
    );
  res.json({ ok: true });
});

app.delete('/api/materiais/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE materiais SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// ESTOQUE POR EQUIPE - saldo por equipe x minimo global (materiais.quantidade_minima)
// ============================================================
// Visão geral: cada linha = 1 material x 1 equipe, com gasto total e status
app.get('/api/estoque/equipes', async (req, res) => {
  const { equipe_id, busca, so_alertas, so_movimento } = req.query;
  const mats = await db.prepare('SELECT id, nome, categoria, COALESCE(unidade,\'UND\') as unidade, COALESCE(quantidade_minima,0) as quantidade_minima FROM materiais WHERE ativo=1 ORDER BY nome').all();
  const eqs = await db.prepare('SELECT id, nome, COALESCE(eh_geral,0) as eh_geral FROM equipes WHERE ativo=1 ORDER BY COALESCE(eh_geral,0) DESC, nome').all();
  const eqFiltradas = equipe_id ? eqs.filter(e => Number(e.id) === Number(equipe_id)) : eqs;
  const saldos = await db.prepare('SELECT equipe_id, material_id, quantidade_atual FROM estoque_equipes').all();
  const mapSaldo = new Map(saldos.map(s => [`${s.equipe_id}:${s.material_id}`, Number(s.quantidade_atual) || 0]));
  const gastos = await db.prepare(`SELECT equipe_id, material_id, SUM(CASE WHEN tipo IN ('saida','rdo') THEN quantidade WHEN tipo='estorno' THEN -quantidade ELSE 0 END) as gasto FROM estoque_movimentacoes GROUP BY equipe_id, material_id`).all();
  const mapGasto = new Map(gastos.map(g => [`${g.equipe_id}:${g.material_id}`, Number(g.gasto) || 0]));
  let linhas = [];
  for (const eq of eqFiltradas) {
    for (const m of mats) {
      const saldo = mapSaldo.get(`${eq.id}:${m.id}`) ?? 0;
      const minimo = Number(m.quantidade_minima) || 0;
      const gasto = mapGasto.get(`${eq.id}:${m.id}`) ?? 0;
      let status = 'ok';
      if (minimo > 0 && saldo <= minimo) status = 'critico';
      else if (minimo > 0 && saldo <= minimo * 1.2) status = 'atencao';
      else if (saldo === 0 && gasto > 0) status = 'zerado';
      linhas.push({ equipe_id: eq.id, equipe_nome: eq.nome, eh_geral: Number(eq.eh_geral) || 0, material_id: m.id, material_nome: m.nome, categoria: m.categoria, unidade: m.unidade, saldo, minimo: minimo, gasto, status });
    }
  }
  if (busca) {
    const n = busca.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    linhas = linhas.filter(l => l.material_nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(n) || l.equipe_nome.toLowerCase().includes(n));
  }
  if (String(so_alertas) === '1' || String(so_alertas) === 'true') linhas = linhas.filter(l => l.status === 'critico' || l.status === 'atencao' || l.status === 'zerado');
  // so_movimento: trafega só o que tem saldo ou gasto (a tela já ignorava o resto)
  if (String(so_movimento) === '1' || String(so_movimento) === 'true') linhas = linhas.filter(l => Number(l.saldo) !== 0 || Number(l.gasto) !== 0);
  res.json(linhas);
});

// Só alertas (para badge / aviso): saldo <= minimo global
app.get('/api/estoque/alertas', async (req, res) => {
  const { equipe_id } = req.query;
  const eqF = equipe_id ? 'AND s.equipe_id=?' : '';
  const params = equipe_id ? [Number(equipe_id)] : [];
  const rows = await db.prepare(`
    SELECT e.nome as equipe_nome, m.nome as material_nome, m.unidade as unidade,
      s.equipe_id, s.material_id, s.quantidade_atual as saldo,
      COALESCE(m.quantidade_minima,0) as minimo
    FROM estoque_equipes s
    JOIN equipes e ON e.id=s.equipe_id
    JOIN materiais m ON m.id=s.material_id
    WHERE COALESCE(m.quantidade_minima,0) > 0 AND s.quantidade_atual <= COALESCE(m.quantidade_minima,0) ${eqF}
    ORDER BY s.quantidade_atual - COALESCE(m.quantidade_minima,0), e.nome, m.nome
  `).all(...params);
  res.json(rows.map(r => ({ ...r, saldo: Number(r.saldo) || 0, minimo: Number(r.minimo) || 0, falta: Math.max(0, (Number(r.minimo) || 0) - (Number(r.saldo) || 0)) })));
});

// Lançar: compra (→geral), saida_geral (baixa do geral), distribuir (geral→equipe), entrada/saida (ajuste direto na equipe)
// Fluxo: cadastra GERAL primeiro, depois distribui para equipes. RDO dá baixa sozinho.
app.post('/api/estoque/lancar', gestor, async (req, res) => {
  const { equipe_id, material_id, tipo, quantidade, origem } = req.body;
  const matId = Number(material_id), qtd = Number(quantidade);
  if (!matId || !qtd || qtd <= 0) return res.status(400).json({ error: 'material_id e quantidade (>0) são obrigatórios' });
  if (!['entrada', 'saida', 'compra', 'saida_geral', 'distribuir', 'distribuir_local', 'entrada_local', 'saida_local'].includes(tipo)) return res.status(400).json({ error: "tipo deve ser 'entrada', 'saida', 'compra', 'saida_geral', 'distribuir', 'distribuir_local', 'entrada_local' ou 'saida_local'" });
  const mat = await db.prepare('SELECT id, nome, COALESCE(unidade,\'UND\') as unidade, COALESCE(quantidade_minima,0) as quantidade_minima FROM materiais WHERE id=? AND ativo=1').get(matId);
  if (!mat) return res.status(400).json({ error: 'Material inválido' });
  const minimo = Number(mat.quantidade_minima) || 0;
  const uid = req.usuario?.id || req.user?.id || null;
  const origTxt = (origem || '').toString().slice(0, 200);

  if (tipo === 'compra' || tipo === 'saida_geral') {
    // Soma ou baixa no GERAL (estoque central)
    const gid = await getGeralId();
    const mov = tipo === 'compra' ? 'entrada' : 'saida';
    const r = await movimentarEstoqueRdo(gid, matId, mov, qtd, origTxt || tipo, uid);
    return res.json({ ok: true, equipe: r.equipe_nome, geral: true, material: mat.nome, unidade: mat.unidade, saldo: r.saldo, minimo, alerta: r.alerta, msg: r.alerta ? `⚠️ ${r.equipe_nome} com ${r.saldo} ${mat.unidade} de ${mat.nome} (mínimo ${minimo})` : (tipo === 'compra' ? `Compra: +${qtd} ${mat.unidade} no geral (saldo ${r.saldo})` : `Baixa no geral: -${qtd} ${mat.unidade} (saldo ${r.saldo})`) });
  }

  const eqId = Number(equipe_id);
  const precisaEq = !['entrada_local', 'saida_local'].includes(tipo);
  if (precisaEq && !eqId) return res.status(400).json({ error: 'Escolha a equipe' });
  const eq = precisaEq ? await db.prepare('SELECT id, nome FROM equipes WHERE id=? AND ativo=1').get(eqId) : null;
  if (precisaEq && !eq) return res.status(400).json({ error: 'Equipe inválida' });

  if (tipo === 'distribuir') {
    // Transfere GERAL → equipe (duas pernas, auditoria preservada)
    const gid = await getGeralId();
    if (gid === eqId) return res.status(400).json({ error: 'Distribuir é do geral para uma equipe' });
    const g = await movimentarEstoqueRdo(gid, matId, 'saida', qtd, `distribuição → ${eq.nome}${origTxt ? ' (' + origTxt + ')' : ''}`, uid);
    const t = await movimentarEstoqueRdo(eqId, matId, 'entrada', qtd, `recebido do geral${origTxt ? ' (' + origTxt + ')' : ''}`, uid);
    const avisoGeral = minimo > 0 && g.saldo <= minimo;
    return res.json({ ok: true, equipe: eq.nome, material: mat.nome, unidade: mat.unidade, saldo: t.saldo, saldo_geral: g.saldo, minimo, alerta: t.alerta, avisoGeral,
      msg: t.alerta ? `⚠️ ${eq.nome} ficou com ${t.saldo} ${mat.unidade} de ${mat.nome} (mínimo ${minimo})` : `Distribuído: ${qtd} ${mat.unidade} geral→${eq.nome} (geral: ${g.saldo})` });
  }

  // distribuir_local: equipe leva material para o LOCAL (equipe→local, duas pernas auditadas)
  // entrada_local/saida_local: ajuste direto no saldo do local (ex: compra entregue no local)
  if (['distribuir_local', 'entrada_local', 'saida_local'].includes(tipo)) {
    const locId = Number(req.body.local_id);
    if (!locId) return res.status(400).json({ error: 'Escolha o local' });
    const loc = await db.prepare('SELECT id, nome FROM locais WHERE id=? AND ativo=1').get(locId);
    if (!loc) return res.status(400).json({ error: 'Local inválido' });
    if (tipo === 'distribuir_local') {
      const g = await movimentarEstoqueRdo(eqId, matId, 'saida', qtd, `levado p/ local ${loc.nome}${origTxt ? ' (' + origTxt + ')' : ''}`, uid);
      const t = await movimentarEstoqueLocal(locId, matId, 'entrada', qtd, `recebido da equipe ${eq.nome}${origTxt ? ' (' + origTxt + ')' : ''}`, uid);
      return res.json({ ok: true, equipe: eq.nome, local: loc.nome, material: mat.nome, unidade: mat.unidade, saldo_equipe: g.saldo, saldo_local: t.saldo, minimo, alerta: t.alerta,
        msg: t.alerta ? `⚠️ ${loc.nome} ficou com ${t.saldo} ${mat.unidade} de ${mat.nome} (mínimo ${minimo})` : `Levado: ${qtd} ${mat.unidade} ${eq.nome}→${loc.nome} (equipe: ${g.saldo} • local: ${t.saldo})` });
    }
    const mov = tipo === 'entrada_local' ? 'entrada' : 'saida';
    const t = await movimentarEstoqueLocal(locId, matId, mov, qtd, origTxt || tipo, uid);
    return res.json({ ok: true, local: loc.nome, material: mat.nome, unidade: mat.unidade, saldo: t.saldo, minimo, alerta: t.alerta,
      msg: t.alerta ? `⚠️ ${loc.nome} ficou com ${t.saldo} ${mat.unidade} de ${mat.nome} (mínimo ${minimo})` : 'Lançamento no local ok' });
  }

  // entrada/saida: ajuste direto no saldo da equipe
  const reg = await db.prepare('SELECT id, quantidade_atual FROM estoque_equipes WHERE equipe_id=? AND material_id=?').get(eqId, matId);
  const saldoAnt = reg ? (Number(reg.quantidade_atual) || 0) : 0;
  const r = await movimentarEstoqueRdo(eqId, matId, tipo, qtd, origTxt, uid);
  res.json({ ok: true, equipe: eq.nome, material: mat.nome, unidade: mat.unidade, saldo_anterior: saldoAnt, saldo: r.saldo, minimo, alerta: r.alerta, msg: r.alerta ? `⚠️ ${eq.nome} ficou com ${r.saldo} ${mat.unidade} de ${mat.nome} (mínimo ${minimo})` : 'Lançamento ok' });
});

// Histórico de gastos (o que foi gasto por equipe)
app.get('/api/estoque/movimentacoes', async (req, res) => {
  const { equipe_id, material_id, limite } = req.query;
  let sql = `SELECT mv.*, e.nome as equipe_nome, m.nome as material_nome, m.unidade as unidade FROM estoque_movimentacoes mv JOIN equipes e ON e.id=mv.equipe_id JOIN materiais m ON m.id=mv.material_id WHERE 1=1`;
  const p = [];
  if (equipe_id) { sql += ' AND mv.equipe_id=?'; p.push(Number(equipe_id)); }
  if (material_id) { sql += ' AND mv.material_id=?'; p.push(Number(material_id)); }
  sql += ' ORDER BY mv.id DESC LIMIT ' + (Math.min(Number(limite) || 100, 500));
  res.json(await db.prepare(sql).all(...p));
});

// ============================================================
// ESTOQUE FÍSICO POR LOCAL — saldo por local x mínimo global
// Espelho do /api/estoque/equipes: cada linha = 1 material x 1 local.
// ============================================================
app.get('/api/estoque/locais', async (req, res) => {
  const { local_id, busca, so_alertas, so_movimento } = req.query;
  const mats = await db.prepare('SELECT id, nome, categoria, COALESCE(unidade,\'UND\') as unidade, COALESCE(quantidade_minima,0) as quantidade_minima FROM materiais WHERE ativo=1 ORDER BY nome').all();
  let locs = await db.prepare('SELECT l.id, l.nome, l.comarca, l.obra_id, o.nome as obra_nome FROM locais l LEFT JOIN obras o ON o.id=l.obra_id WHERE l.ativo=1 ORDER BY l.nome').all();
  if (local_id) locs = locs.filter(l => Number(l.id) === Number(local_id));
  const saldos = await db.prepare('SELECT local_id, material_id, quantidade_atual FROM estoque_locais').all();
  const mapSaldo = new Map(saldos.map(s => [`${s.local_id}:${s.material_id}`, Number(s.quantidade_atual) || 0]));
  const gastos = await db.prepare(`SELECT local_id, material_id, SUM(CASE WHEN tipo='rdo' THEN quantidade WHEN tipo='estorno' THEN -quantidade ELSE 0 END) as gasto FROM estoque_local_movimentacoes GROUP BY local_id, material_id`).all();
  const mapGasto = new Map(gastos.map(g => [`${g.local_id}:${g.material_id}`, Number(g.gasto) || 0]));
  let linhas = [];
  for (const l of locs) {
    for (const m of mats) {
      const saldo = mapSaldo.get(`${l.id}:${m.id}`) ?? 0;
      const minimo = Number(m.quantidade_minima) || 0;
      const gasto = mapGasto.get(`${l.id}:${m.id}`) ?? 0;
      let status = 'ok';
      if (minimo > 0 && saldo <= minimo) status = 'critico';
      else if (minimo > 0 && saldo <= minimo * 1.2) status = 'atencao';
      else if (saldo === 0 && gasto > 0) status = 'zerado';
      linhas.push({ local_id: l.id, local_nome: l.nome, comarca: l.comarca, obra_id: l.obra_id, obra_nome: l.obra_nome, material_id: m.id, material_nome: m.nome, categoria: m.categoria, unidade: m.unidade, saldo, minimo, gasto, status });
    }
  }
  if (busca) {
    const n = busca.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    linhas = linhas.filter(l => l.material_nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(n) || l.local_nome.toLowerCase().includes(n));
  }
  if (String(so_alertas) === '1' || String(so_alertas) === 'true') linhas = linhas.filter(l => l.status === 'critico' || l.status === 'atencao' || l.status === 'zerado');
  // so_movimento: não trafega o cartesiano zerado (239 locais x 154 materiais);
  // a tela filtra o resto no cliente. Reduz ~36k linhas para dezenas.
  if (String(so_movimento) === '1' || String(so_movimento) === 'true') linhas = linhas.filter(l => Number(l.saldo) !== 0 || Number(l.gasto) !== 0);
  res.json(linhas);
});

// Trilha de movimentações do local (auditoria: quem abasteceu / o que o RDO consumiu)
app.get('/api/estoque/locais/movimentacoes', async (req, res) => {
  const { local_id, material_id, limite } = req.query;
  let sql = `SELECT mv.*, l.nome as local_nome, m.nome as material_nome, m.unidade as unidade FROM estoque_local_movimentacoes mv JOIN locais l ON l.id=mv.local_id JOIN materiais m ON m.id=mv.material_id WHERE 1=1`;
  const p = [];
  if (local_id) { sql += ' AND mv.local_id=?'; p.push(Number(local_id)); }
  if (material_id) { sql += ' AND mv.material_id=?'; p.push(Number(material_id)); }
  sql += ' ORDER BY mv.id DESC LIMIT ' + (Math.min(Number(limite) || 100, 500));
  res.json(await db.prepare(sql).all(...p));
});

// ============================================================
// ESTOQUE POR OBRA - Estimativa vs Consumo (Materiais.xlsx)
// ============================================================
// Lista estimativas de uma obra
app.get('/api/obras/:obra_id/materiais/estimativas', async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const rows = await db.prepare(`SELECT m.*, l.nome as local_nome, e.nome as equipe_nome
    FROM obra_materiais m LEFT JOIN locais l ON l.id=m.local_id LEFT JOIN equipes e ON e.id=m.equipe_id
    WHERE m.obra_id=? ORDER BY m.material_nome`).all(obraId);
  res.json(rows);
});
// Cria/atualiza uma estimativa (upsert por material + escopo local/equipe; NULL = obra toda)
app.post('/api/obras/:obra_id/materiais/estimativas', gestor, async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const { material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao, local_id, equipe_id } = req.body;
  if (!material_nome || !material_nome.trim()) return res.status(400).json({error:'material_nome obrigatório'});
  const nome = material_nome.trim();
  const qtd = Number(quantidade_estimada)||0;
  if (qtd <0) return res.status(400).json({error:'Quantidade inválida'});
  const locId = local_id ? Number(local_id) : null;
  const eqId = equipe_id ? Number(equipe_id) : null;
  if (locId) { const l = await db.prepare('SELECT id FROM locais WHERE id=? AND obra_id=? AND ativo=1').get(locId, obraId); if (!l) return res.status(400).json({error:'Local não pertence a esta obra'}); }
  if (eqId) { const t = await db.prepare('SELECT id FROM equipes WHERE id=? AND ativo=1').get(eqId); if (!t) return res.status(400).json({error:'Equipe inválida'}); }
  // upsert: tenta insert, se conflito atualiza
  const conds = ['obra_id=?', 'UPPER(material_nome)=UPPER(?)'];
  const vals = [obraId, nome];
  if (locId) { conds.push('local_id=?'); vals.push(locId); } else conds.push('local_id IS NULL');
  if (eqId) { conds.push('equipe_id=?'); vals.push(eqId); } else conds.push('equipe_id IS NULL');
  const existe = await db.prepare(`SELECT id FROM obra_materiais WHERE ${conds.join(' AND ')}`).get(...vals);
  if (existe) {
    await db.prepare('UPDATE obra_materiais SET unidade=?, quantidade_estimada=?, valor_unitario=?, fornecedor=?, etapa=?, observacao=?, local_id=?, equipe_id=? WHERE id=?')
      .run(unidade||'UND', qtd, Number(valor_unitario)||0, fornecedor||'', etapa||'ETAPA 1', observacao||'', locId, eqId, existe.id);
    return res.json({ok:true, id: existe.id, atualizado:true});
  } else {
    const r = await db.prepare('INSERT INTO obra_materiais (obra_id, material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao, local_id, equipe_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(obraId, nome, unidade||'UND', qtd, Number(valor_unitario)||0, fornecedor||'', etapa||'ETAPA 1', observacao||'', locId, eqId);
    // garante que material existe no catálogo
    try { await db.prepare('INSERT OR IGNORE INTO materiais (nome,categoria) VALUES (?,?)').run(nome, 'Geral'); } catch(e){}
    return res.json({ok:true, id: r.lastInsertRowid});
  }
});
app.put('/api/obra-materiais/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const { material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao, local_id, equipe_id } = req.body;
  const atual = await db.prepare('SELECT * FROM obra_materiais WHERE id=?').get(id);
  if(!atual) return res.status(404).json({error:'Estimativa não encontrada'});
  const locId = local_id === null || local_id === '' ? null : (local_id != null ? Number(local_id) : atual.local_id);
  const eqId = equipe_id === null || equipe_id === '' ? null : (equipe_id != null ? Number(equipe_id) : atual.equipe_id);
  const nomeFinal = (material_nome || atual.material_nome).trim();
  // evita duplicar outro registro no mesmo escopo
  const conds = ['obra_id=?', 'UPPER(material_nome)=UPPER(?)', 'id<>?'];
  const vals = [atual.obra_id, nomeFinal, id];
  if (locId) { conds.push('local_id=?'); vals.push(locId); } else conds.push('local_id IS NULL');
  if (eqId) { conds.push('equipe_id=?'); vals.push(eqId); } else conds.push('equipe_id IS NULL');
  const choque = await db.prepare(`SELECT id FROM obra_materiais WHERE ${conds.join(' AND ')}`).get(...vals);
  if (choque) return res.status(400).json({error:'Já existe estimativa deste material neste local/equipe — edite a existente'});
  await db.prepare('UPDATE obra_materiais SET material_nome=?, unidade=?, quantidade_estimada=?, valor_unitario=?, fornecedor=?, etapa=?, observacao=?, local_id=?, equipe_id=? WHERE id=?')
    .run(nomeFinal, unidade||atual.unidade, quantidade_estimada!=null? Number(quantidade_estimada):atual.quantidade_estimada, valor_unitario!=null? Number(valor_unitario):atual.valor_unitario, fornecedor!=null? fornecedor:atual.fornecedor, etapa||atual.etapa, observacao!=null? observacao:atual.observacao, locId, eqId, id);
  res.json({ok:true});
});
app.delete('/api/obra-materiais/:id', gestor, async (req, res) => {
  await db.prepare('DELETE FROM obra_materiais WHERE id=?').run(Number(req.params.id));
  res.json({ok:true});
});
// ============================================================
// COMPRAS POR OBRA — o que foi efetivamente comprado para a obra
// (base do comparativo comprado x consumido; estimativa = plano)
// ============================================================
app.get('/api/obras/:obra_id/compras', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM obra_compras WHERE obra_id=? ORDER BY data_compra DESC, id DESC').all(Number(req.params.obra_id));
  res.json(rows);
});
app.post('/api/obras/:obra_id/compras', gestor, async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const { material_nome, unidade, quantidade, valor_unitario, fornecedor, data_compra, observacao } = req.body;
  if (!material_nome || !material_nome.trim()) return res.status(400).json({error:'material_nome obrigatório'});
  const qtd = Number(quantidade)||0;
  if (qtd <= 0) return res.status(400).json({error:'Quantidade deve ser > 0'});
  const nome = material_nome.trim();
  const r = await db.prepare('INSERT INTO obra_compras (obra_id, material_nome, unidade, quantidade, valor_unitario, fornecedor, data_compra, observacao, criado_por) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(obraId, nome, (unidade||'UND').toUpperCase(), qtd, Number(valor_unitario)||0, fornecedor||'', data_compra||new Date().toISOString().slice(0,10), observacao||'', req.user ? req.user.nome : '');
  // garante que material existe no catálogo
  try { await db.prepare('INSERT OR IGNORE INTO materiais (nome,categoria) VALUES (?,?)').run(nome, 'Geral'); } catch(e){}
  res.json({ok:true, id: r.lastInsertRowid});
});
app.put('/api/obra-compras/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const atual = await db.prepare('SELECT * FROM obra_compras WHERE id=?').get(id);
  if(!atual) return res.status(404).json({error:'Compra não encontrada'});
  const { material_nome, unidade, quantidade, valor_unitario, fornecedor, data_compra, observacao } = req.body;
  await db.prepare('UPDATE obra_compras SET material_nome=?, unidade=?, quantidade=?, valor_unitario=?, fornecedor=?, data_compra=?, observacao=? WHERE id=?')
    .run((material_nome||atual.material_nome).trim(), (unidade||atual.unidade||'UND').toUpperCase(), quantidade!=null? Number(quantidade):atual.quantidade, valor_unitario!=null? Number(valor_unitario):atual.valor_unitario, fornecedor!=null? fornecedor:atual.fornecedor, data_compra||atual.data_compra, observacao!=null? observacao:atual.observacao, id);
  res.json({ok:true});
});
app.delete('/api/obra-compras/:id', gestor, async (req, res) => {
  await db.prepare('DELETE FROM obra_compras WHERE id=?').run(Number(req.params.id));
  res.json({ok:true});
});
// Importar Materiais.xlsx por obra (espera {linhas:[{Descrição do material, Unidade, Quantidade solicitada, Menor valor Total, Fornecedor...}]})
app.post('/api/obras/:obra_id/materiais/importar', gestor, async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const { linhas } = req.body;
  if(!linhas || !Array.isArray(linhas) || !linhas.length) return res.status(400).json({error:'Envie {linhas:[...]}'});
  const norm = s=> (s||'').toString().trim();
  let importados=0, atualizados=0;
  for(const l of linhas){
    // tenta mapear colunas variadas da planilha
    const nome = norm(l['Descrição do material'] || l['Descricao do material'] || l['Descrição'] || l['Descricao'] || l['material_nome'] || l['MATERIAL'] || l['nome']);
    if(!nome || nome.toLowerCase().includes('descrição')) continue;
    const unidade = norm(l['Unidade'] || l['unidade'] || 'UND');
    const qtd = Number(String(l['Quantidade solicitada']||l['quantidade_estimada']||l['Quantidade']||0).toString().replace(',','.'))||0;
    if(!qtd) continue;
    const valorTotal = Number(String(l['Menor valor Total']||l['valor_total']||0).toString().replace(',','.'))||0;
    const fornecedor = norm(l['Fornecedor com menor preço']||l['fornecedor']||'');
    const etapa = norm(l['etapa']||'ETAPA 1');
    // valor unitário deriva do total/qtd se não vier separado
    const valorUnit = valorTotal && qtd ? valorTotal/qtd : Number(String(l['Valor Unitário']||l['valor_unitario']||0).toString().replace(',','.'))||0;
    // importação é sempre escopo OBRA (não toca linhas por local/equipe)
    const existe = await db.prepare('SELECT id FROM obra_materiais WHERE obra_id=? AND UPPER(material_nome)=UPPER(?) AND local_id IS NULL AND equipe_id IS NULL').get(obraId, nome);
    if(existe){
      await db.prepare('UPDATE obra_materiais SET unidade=?, quantidade_estimada=?, valor_unitario=?, fornecedor=?, etapa=? WHERE id=?').run(unidade, qtd, valorUnit, fornecedor, etapa, existe.id);
      atualizados++;
    } else {
      await db.prepare('INSERT INTO obra_materiais (obra_id, material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa) VALUES (?,?,?,?,?,?,?)').run(obraId, nome, unidade, qtd, valorUnit, fornecedor, etapa);
      importados++;
    }
    try { await db.prepare('INSERT OR IGNORE INTO materiais (nome,categoria) VALUES (?,?)').run(nome, 'Geral'); } catch(e){}
  }
  res.json({ok:true, importados, atualizados, total:linhas.length});
});
// Consumo agregado por obra (estimativa vs real por RDOs) — dinâmica com alertas e forecast
app.get('/api/obras/:obra_id/materiais/consumo', async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const estimativas = await db.prepare('SELECT * FROM obra_materiais WHERE obra_id=? ORDER BY material_nome').all(obraId);
  const rdos = await db.prepare('SELECT id, local, local_id, materiais_json, equipe_json, usuario_id, data FROM rdos WHERE obra_id=? AND COALESCE(ativo,1)=1').all(obraId);
  const locais = await db.prepare('SELECT id FROM locais WHERE obra_id=? AND ativo=1').all(obraId);
  const totalLocais = locais.length;
  // locais com pelo menos 1 RDO (considera concluído se tem RDO)
  const locaisComRdo = new Set(rdos.map(r=> r.local_id || r.local).filter(Boolean));
  const locaisConcluidos = locaisComRdo.size;
  const locaisPendentes = Math.max(0, totalLocais - locaisConcluidos);
  // agrega consumo por material (case-insensitive)
  const mapNorm = s=> (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
  const consumoPorMat = {}; // norm -> {nome, total, rdos, porEquipe, porLocal}
  const consumoPorEquipe = {}; // equipeNome -> total geral (soma de qtds)
  const consumoPorLocal = {}; // localNome -> total
  for(const r of rdos){
    let mats=[]; try{ mats=JSON.parse(r.materiais_json||'[]'); }catch(e){ mats=[]; }
    let equipes=[]; try{ equipes=JSON.parse(r.equipe_json||'[]'); }catch(e){ equipes=[]; }
    if(!Array.isArray(mats)) mats=[];
    for(const m of mats){
      const nome = (m.nome || m.material_nome || m.descricao || '').toString().trim();
      if(!nome) continue;
      const qtd = Number(m.qtd ?? m.quantidade ?? m.qty ?? 1)||0;
      const norm = mapNorm(nome);
      if(!consumoPorMat[norm]) consumoPorMat[norm]={nome, total:0, rdos:0, porEquipe:{}, porLocal:{}};
      consumoPorMat[norm].total+=qtd;
      consumoPorMat[norm].rdos+=1;
      // por equipe: distribui qtd igualmente entre equipes do RDO ou conta para cada
      const eqs = equipes.length? equipes : ['SEM EQUIPE'];
      for(const eq of eqs){
        consumoPorMat[norm].porEquipe[eq]=(consumoPorMat[norm].porEquipe[eq]||0)+qtd;
        consumoPorEquipe[eq]=(consumoPorEquipe[eq]||0)+qtd;
      }
      const locKey = r.local || (r.local_id? String(r.local_id):'SEM LOCAL');
      consumoPorMat[norm].porLocal[locKey]=(consumoPorMat[norm].porLocal[locKey]||0)+qtd;
      consumoPorLocal[locKey]=(consumoPorLocal[locKey]||0)+qtd;
    }
  }
  // mapas de escopo (estimativa por local/equipe)
  const locRows = await db.prepare('SELECT id,nome FROM locais WHERE obra_id=? AND ativo=1').all(obraId);
  const mapLocalNome = Object.fromEntries(locRows.map(l => [Number(l.id), l.nome]));
  const eqRows = await db.prepare('SELECT id,nome FROM equipes WHERE ativo=1').all();
  const mapEquipeNome = Object.fromEntries(eqRows.map(e => [Number(e.id), e.nome]));
  // consumo recortado para linhas com escopo: RDO conta se (local bate ou linha é obra-toda) E (equipe contém ou linha é obra-toda)
  const consumoEscopado = (est) => {
    const locNome = est.local_id ? (mapLocalNome[Number(est.local_id)] || '') : '';
    const eqNome = est.equipe_id ? (mapEquipeNome[Number(est.equipe_id)] || '') : '';
    let total = 0, nrdos = 0;
    const porEquipe = {}, porLocal = {};
    for (const r of rdos) {
      if (est.local_id && !(Number(r.local_id) === Number(est.local_id) || (r.local && locNome && mapNorm(r.local) === mapNorm(locNome)))) continue;
      let eqs = []; try { eqs = JSON.parse(r.equipe_json || '[]'); } catch (e) { eqs = []; }
      if (est.equipe_id && eqNome && !eqs.some(x => normEquipe(x) === normEquipe(eqNome))) continue;
      let mats = []; try { mats = JSON.parse(r.materiais_json || '[]'); } catch (e) { mats = []; }
      let somou = false;
      for (const m of mats) {
        const nome = (m.nome || m.material_nome || m.descricao || '').toString().trim();
        if (!nome || mapNorm(nome) !== mapNorm(est.material_nome)) continue;
        const qtd = Number(m.qtd ?? m.quantidade ?? m.qty ?? 1) || 0;
        total += qtd; somou = true;
        const eqList = eqs.length ? eqs : ['SEM EQUIPE'];
        for (const eq of eqList) porEquipe[eq] = (porEquipe[eq] || 0) + qtd;
        const locKey = r.local || (r.local_id ? String(r.local_id) : 'SEM LOCAL');
        porLocal[locKey] = (porLocal[locKey] || 0) + qtd;
      }
      if (somou) nrdos++;
    }
    return { total, nrdos, porEquipe, porLocal };
  };
  // monta resposta por material estimado
  // Nexo com Materiais: anexa minimo do catálogo (referência) por nome normalizado
  const catMinimos = await db.prepare('SELECT nome, COALESCE(quantidade_minima,0) as minimo FROM materiais WHERE ativo=1').all();
  const mapMinimo = new Map(catMinimos.map(c => [mapNorm(c.nome), Number(c.minimo) || 0]));
  // Comprado por material (comparativo comprado x consumido) — soma por nome normalizado
  let comprasPorMat = new Map();
  try {
    const compras = await db.prepare('SELECT material_nome, quantidade, valor_unitario FROM obra_compras WHERE obra_id=?').all(obraId);
    for (const c of compras) {
      const k = mapNorm(c.material_nome);
      const cur = comprasPorMat.get(k) || { qtd: 0, valor: 0 };
      const q = Number(c.quantidade) || 0;
      cur.qtd += q; cur.valor += q * (Number(c.valor_unitario) || 0);
      comprasPorMat.set(k, cur);
    }
  } catch (e) { comprasPorMat = new Map(); }
  const itens = estimativas.map(e=>{
    const norm = mapNorm(e.material_nome);
    const comp = comprasPorMat.get(norm) || { qtd: 0, valor: 0 };
    let consumido, nrdos, porEq, porLoc;
    if (e.local_id || e.equipe_id) {
      const sc = consumoEscopado(e);
      consumido = sc.total; nrdos = sc.nrdos; porEq = sc.porEquipe; porLoc = sc.porLocal;
    } else {
      const cons = consumoPorMat[norm];
      consumido = cons? cons.total : 0; nrdos = cons? cons.rdos : 0;
      porEq = cons? cons.porEquipe : {}; porLoc = cons? cons.porLocal : {};
    }
    const estimado = Number(e.quantidade_estimada)||0;
    const saldo = estimado - consumido;
    const pct = estimado>0? Math.round(consumido/estimado*100) : (consumido>0?100:0);
    const valorEstimado = estimado * (Number(e.valor_unitario)||0);
    const valorConsumido = consumido * (Number(e.valor_unitario)||0);
    const valorSaldo = saldo * (Number(e.valor_unitario)||0);
    // forecast: média por local concluído
    const mediaPorLocal = locaisConcluidos>0? consumido/locaisConcluidos : (totalLocais>0? estimado/totalLocais : 0);
    const projecaoRestante = mediaPorLocal * locaisPendentes;
    let necessidade = Math.max(0, projecaoRestante - Math.max(0,saldo));
    // tolerância FP: sem nenhum RDO, projecao=(estimado/L)*L deveria ser == estimado, mas o
    // IEEE754 deixa poeira ~2e-13 > 0 → virava status COMPRAR fantasma com 0% usado e a
    // sugestão ganhava +1 via Math.ceil (ex: 100→101). Abaixo de 1e-9 é zero.
    if (necessidade < 1e-9) necessidade = 0;
    let status='ok';
    if(consumido>estimado) status='estourado';
    else if(saldo<=0) status='critico';
    else if(pct>=90) status='critico';
    else if(pct>=70) status='atencao';
    else if(necessidade>0) status='comprar';
    const precisaComprar = status==='critico' || status==='estourado' || necessidade>0;
    const sugestaoCompra = precisaComprar ? Math.ceil(Math.max(necessidade, estimado*0.2 - saldo, 0) + (estimado*0.05)) : 0; // 20% buffer + 5% margem
    return {
      id:e.id, material_nome:e.material_nome, unidade:e.unidade, etapa:e.etapa, fornecedor:e.fornecedor, valor_unitario:Number(e.valor_unitario)||0,
      local_id:e.local_id||null, local_nome:e.local_id?(mapLocalNome[Number(e.local_id)]||null):null,
      equipe_id:e.equipe_id||null, equipe_nome:e.equipe_id?(mapEquipeNome[Number(e.equipe_id)]||null):null,
      escopo:(e.local_id||e.equipe_id)?'direcionado':'obra',
      estimado, consumido, saldo, pct, valorEstimado, valorConsumido, valorSaldo,
      comprado: Math.round(comp.qtd*100)/100, comprado_valor: Math.round(comp.valor*100)/100,
      rdos: nrdos, porEquipe: porEq, porLocal: porLoc,
      mediaPorLocal: Math.round(mediaPorLocal*100)/100, projecaoRestante: Math.round(projecaoRestante*100)/100,
      necessidade: Math.round(necessidade*100)/100, status, precisaComprar, sugestaoCompra,
      minimo_catalogo: mapMinimo.get(norm) || 0
    };
  });
  // materiais consumidos sem estimativa (extra)
  const estimNorms = new Set(estimativas.map(e=> mapNorm(e.material_nome)));
  const extras = Object.entries(consumoPorMat).filter(([k])=> !estimNorms.has(k)).map(([norm, v])=>{
    const comp = comprasPorMat.get(norm) || { qtd: 0, valor: 0 };
    return { material_nome: v.nome, unidade:'UND', estimado:0, consumido: v.total, saldo: -v.total, pct:100, valorEstimado:0, valorConsumido:0, valorSaldo:0, comprado: Math.round(comp.qtd*100)/100, comprado_valor: Math.round(comp.valor*100)/100, rdos:v.rdos, porEquipe:v.porEquipe, porLocal:v.porLocal, status:'extra', precisaComprar:true, sugestaoCompra:0, minimo_catalogo: mapMinimo.get(norm) || 0 };
  });
  const todosItens = [...itens, ...extras].sort((a,b)=> (b.pct - a.pct) || (b.consumido - a.consumido));
  const alertas = todosItens.filter(i=> i.precisaComprar);
  const totalCompradoQtd = [...comprasPorMat.values()].reduce((s,c)=>s+c.qtd,0);
  const totalCompradoValor = [...comprasPorMat.values()].reduce((s,c)=>s+c.valor,0);
  const resumo={
    obra_id:obraId, totalLocais, locaisConcluidos, locaisPendentes,
    totalMateriais: estimativas.length,
    totalEstimadoQtd: estimativas.reduce((s,e)=>s+Number(e.quantidade_estimada||0),0),
    totalConsumidoQtd: Object.values(consumoPorMat).reduce((s,v)=>s+v.total,0),
    totalValorEstimado: itens.reduce((s,i)=>s+i.valorEstimado,0),
    totalValorConsumido: itens.reduce((s,i)=>s+i.valorConsumido,0),
    totalValorSaldo: itens.reduce((s,i)=>s+i.valorSaldo,0),
    totalCompradoQtd: Math.round(totalCompradoQtd*100)/100,
    totalCompradoValor: Math.round(totalCompradoValor*100)/100,
    pctMedio: itens.length? Math.round(itens.reduce((s,i)=>s+i.pct,0)/itens.length):0,
    alertas: alertas.length,
    rdosTotal: rdos.length
  };
  // ranking equipes e locais
  const rankingEquipes = Object.entries(consumoPorEquipe).map(([nome,total])=>({nome, total})).sort((a,b)=>b.total-a.total).slice(0,10);
  const rankingLocais = Object.entries(consumoPorLocal).map(([nome,total])=>({nome, total})).sort((a,b)=>b.total-a.total).slice(0,10);
  res.json({resumo, itens: todosItens, alertas, rankingEquipes, rankingLocais});
});
// Relatório de gastos por LOCAL: quanto cada local da obra já consumiu (via RDOs),
// por material e por equipe. Base do "quanto foi gasto em cada local".
app.get('/api/obras/:obra_id/materiais/por-local', async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const mapNorm = s=> (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
  const rdos = await db.prepare('SELECT id, local, local_id, materiais_json, equipe_json, data FROM rdos WHERE obra_id=? AND COALESCE(ativo,1)=1 ORDER BY data DESC, id DESC').all(obraId);
  const locRows = await db.prepare('SELECT id, nome, comarca FROM locais WHERE obra_id=? AND ativo=1 ORDER BY nome').all(obraId);
  const porId = new Map(locRows.map(l => [Number(l.id), l]));
  const porNome = new Map(locRows.map(l => [mapNorm(l.nome), l]));
  const grupos = new Map(); // key -> {local_id, local_nome, comarca, rdos:Set, mats:Map}
  function grupoDe(r) {
    let loc = (r.local_id != null && porId.has(Number(r.local_id))) ? porId.get(Number(r.local_id)) : null;
    if (!loc && r.local && porNome.has(mapNorm(r.local))) loc = porNome.get(mapNorm(r.local));
    const key = loc ? 'L' + loc.id : 'N' + mapNorm(r.local || 'SEM LOCAL');
    if (!grupos.has(key)) grupos.set(key, { local_id: loc ? loc.id : null, local_nome: loc ? loc.nome : (r.local || 'SEM LOCAL'), comarca: loc ? loc.comarca : '', rdos: new Set(), mats: new Map() });
    return grupos.get(key);
  }
  for (const r of rdos) {
    let mats = []; try { mats = JSON.parse(r.materiais_json || '[]'); } catch (e) { mats = []; }
    if (!Array.isArray(mats) || !mats.length) continue;
    let eqs = []; try { eqs = JSON.parse(r.equipe_json || '[]'); } catch (e) { eqs = []; }
    const g = grupoDe(r);
    g.rdos.add(r.id);
    for (const m of mats) {
      const nome = (m.nome || m.material_nome || m.descricao || '').toString().trim();
      if (!nome) continue;
      const qtd = Number(m.qtd ?? m.quantidade ?? m.qty ?? 1) || 0;
      const k = mapNorm(nome);
      if (!g.mats.has(k)) g.mats.set(k, { material_nome: nome, consumido: 0, rdos: 0, porEquipe: {} });
      const it = g.mats.get(k);
      it.consumido = Math.round((it.consumido + qtd) * 100) / 100;
      it.rdos += 1;
      for (const eq of (eqs.length ? eqs : ['SEM EQUIPE'])) it.porEquipe[eq] = Math.round(((it.porEquipe[eq] || 0) + qtd) * 100) / 100;
    }
  }
  const locais = [...grupos.values()].map(g => ({
    local_id: g.local_id, local_nome: g.local_nome, comarca: g.comarca,
    total_rdos: g.rdos.size,
    total_qtd: Math.round([...g.mats.values()].reduce((s, i) => s + i.consumido, 0) * 100) / 100,
    itens: [...g.mats.values()].sort((a, b) => b.consumido - a.consumido)
  })).sort((a, b) => b.total_qtd - a.total_qtd);
  res.json({ obra_id: obraId, locais });
});
// Materiais liberados para o técnico (login): recorte equipe × local.
// Lógica: se a obra NÃO tem estimativa direcionada → scoped:false e o app usa o catálogo cheio (compat).
// Se tem → scoped:true e o app mostra SÓ o recorte (linhas obra-toda entram como coringa).
app.get('/api/obras/:obra_id/materiais/para-rdo', async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const localId = req.query.local_id ? Number(req.query.local_id) : null;
  const equipeId = req.query.equipe_id ? Number(req.query.equipe_id) : null;
  const rows = await db.prepare(`SELECT m.*, l.nome as local_nome, e.nome as equipe_nome, mt.categoria as categoria
    FROM obra_materiais m LEFT JOIN locais l ON l.id=m.local_id LEFT JOIN equipes e ON e.id=m.equipe_id
    LEFT JOIN materiais mt ON UPPER(mt.nome)=UPPER(m.material_nome)
    WHERE m.obra_id=? ORDER BY m.material_nome`).all(obraId);
  const temEscopo = rows.some(r => r.local_id || r.equipe_id);
  if (!temEscopo) return res.json({ scoped: false, materiais: [] });
  const seen = new Set();
  const materiais = [];
  for (const r of rows) {
    if (r.local_id && (!localId || Number(r.local_id) !== localId)) continue;
    if (r.equipe_id && (!equipeId || Number(r.equipe_id) !== equipeId)) continue;
    const k = (r.material_nome || '').toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    materiais.push({ nome: r.material_nome, categoria: r.categoria || 'Geral', unidade: r.unidade || 'UND',
      local_nome: r.local_nome || null, equipe_nome: r.equipe_nome || null });
  }
  res.json({ scoped: true, materiais });
});

// ============================================================
// RDOs — documento legal de obra: edição com trilha + exclusão lógica com auditoria
// Regra padrão obra gigante: nunca apaga fisicamente; desativa (ativo=0) + motivo + quem/quando.
// ============================================================
async function rdoLog(rdo_id, acao, req, motivo, antes, depois) {
  try {
    await db.prepare(`INSERT INTO rdo_auditoria (rdo_id,acao,usuario_id,usuario_nome,motivo,dados_antes,dados_depois) VALUES (?,?,?,?,?,?,?)`)
      .run(rdo_id, acao, req.user ? req.user.id : null, req.user ? req.user.nome : 'Anonimo',
        (motivo || '').toString().slice(0, 500),
        JSON.stringify(antes || {}).slice(0, 8000), JSON.stringify(depois || {}).slice(0, 8000));
  } catch (e) { console.error('[rdo-auditoria]', e.message); }
}
function podeEditarRdo(req, rdo) {
  if (!rdo) return false;
  if (req.user.perfil === 'gestor') return true;
  return Number(rdo.usuario_id) === Number(req.user.id);
}
// Trava 24h: técnico só altera RDO recente (anti-fraude em medição); após 24h só gestor.
function rdoTravado24h(rdo, req) {
  if (!rdo || (req.user && req.user.perfil === 'gestor')) return null;
  let base = rdo.criado_em || rdo.data || null;
  if (!base) return null;
  // Postgres (pg) devolve TIMESTAMPTZ como objeto Date; SQLite devolve TEXT — normaliza pra string ISO antes de tratar como texto
  if (base instanceof Date) base = base.toISOString();
  let dt = new Date(String(base).includes('T') ? base : String(base).replace(' ', 'T') + 'Z');
  if (isNaN(dt.getTime()) && rdo.data) { dt = new Date(rdo.data + 'T23:59:59'); }
  if (isNaN(dt.getTime())) return null;
  const horas = (Date.now() - dt.getTime()) / 3600000;
  if (horas > 24) return Math.floor(horas);
  return null;
}
app.get('/api/rdos', async (req, res) => {
  const verLixeira = String(req.query.incluir_excluidos || '') === '1' || String(req.query.somente_excluidos || '') === '1';
  if (verLixeira && req.user.perfil !== 'gestor') return res.status(403).json({ error: 'So gestor ve excluidos' });
  let sql = `SELECT r.*, o.nome as obra_nome, o.responsavel as obra_responsavel, o.status as obra_status,
    l.comarca as cidade, l.latitude as local_lat, l.longitude as local_lng, l.endereco as local_endereco
    FROM rdos r 
    LEFT JOIN obras o ON r.obra_id=o.id 
    LEFT JOIN locais l ON (r.local_id=l.id OR (r.local_id IS NULL AND (r.local = l.nome OR UPPER(l.nome) LIKE '%' || UPPER(r.local) || '%' OR UPPER(l.comarca) LIKE '%' || UPPER(r.local) || '%'))) AND l.ativo=1
    WHERE 1=1`;
  const p = [];
  if (String(req.query.somente_excluidos || '') === '1') { sql += ' AND COALESCE(r.ativo,1)=0'; }
  else if (String(req.query.incluir_excluidos || '') !== '1') { sql += ' AND COALESCE(r.ativo,1)=1'; }
  if (req.query.obra_id) { sql += ' AND r.obra_id=?'; p.push(req.query.obra_id); }
  if (req.query.local_id) { sql += ' AND r.local_id=?'; p.push(req.query.local_id); }
  if (req.query.usuario_id) { sql += ' AND r.usuario_id=?'; p.push(req.query.usuario_id); }
  if (req.query.data_de) { sql += ' AND r.data>=?'; p.push(req.query.data_de); }
  if (req.query.data_ate) { sql += ' AND r.data<=?'; p.push(req.query.data_ate); }
  if (req.query.local) { sql += ' AND r.local=?'; p.push(req.query.local); }
  res.json(await db.prepare(sql + ' ORDER BY r.data DESC, r.criado_em DESC').all(...p));
});

app.get('/api/rdos/:id', async (req, res) => {
  const rdo = await db.prepare(`SELECT r.*, o.nome as obra_nome, l.comarca as cidade
    FROM rdos r 
    LEFT JOIN obras o ON r.obra_id=o.id 
    LEFT JOIN locais l ON (r.local_id=l.id OR (r.local_id IS NULL AND (r.local = l.nome OR UPPER(l.nome) LIKE '%' || UPPER(r.local) || '%' OR UPPER(l.comarca) LIKE '%' || UPPER(r.local) || '%'))) AND l.ativo=1
    WHERE r.id=?`).get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (Number(rdo.ativo) === 0 && req.user.perfil !== 'gestor' && Number(rdo.usuario_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'RDO excluido — acesso restrito' });
  }
  res.json(rdo);
});

// Trilha geral de auditoria de RDOs (somente gestor) — alimenta aba Auditoria
app.get('/api/auditoria/rdo', gestor, async (req, res) => {
  const lim = Math.min(Number(req.query.limit || 200), 500);
  const p = [];
  let sql = `SELECT a.*, r.data as rdo_data, r.local as rdo_local, r.atividade as rdo_atividade, r.obra_id
    FROM rdo_auditoria a LEFT JOIN rdos r ON r.id=a.rdo_id WHERE 1=1`;
  if (req.query.acao) { sql += ' AND a.acao=?'; p.push(String(req.query.acao).toUpperCase()); }
  if (req.query.obra_id) { sql += ' AND r.obra_id=?'; p.push(req.query.obra_id); }
  if (req.query.busca) { sql += ' AND (a.usuario_nome LIKE ? OR a.motivo LIKE ? OR r.local LIKE ?)'; p.push(`%${req.query.busca}%`, `%${req.query.busca}%`, `%${req.query.busca}%`); }
  sql += ' ORDER BY a.id DESC LIMIT ' + lim;
  res.json(await db.prepare(sql).all(...p));
});

// Historico / trilha de auditoria de um RDO (dono ou gestor)
app.get('/api/rdos/:id/historico', async (req, res) => {
  const rdo = await db.prepare('SELECT id, usuario_id FROM rdos WHERE id=?').get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (req.user.perfil !== 'gestor' && Number(rdo.usuario_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Sem acesso ao historico' });
  }
  res.json(await db.prepare('SELECT * FROM rdo_auditoria WHERE rdo_id=? ORDER BY id DESC').all(req.params.id));
});

// ============================================================
// BAIXA AUTOMÁTICA RDO → ESTOQUE POR EQUIPE
// RDO consome saldo da equipe sozinho (sem digitação dupla).
// Nomes livres do RDO (material/equipe) são resolvidos para ids.
// Qtd rateada igualmente entre as equipes do RDO.
// Estorno via contramovimento (auditoria preservada).
// ============================================================
const normMatRdo = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/\s+/g,' ');

async function resolverMaterialIdRdo(nome) {
  const n = (nome || '').toString().trim();
  if (!n) return null;
  let m = await db.prepare('SELECT id FROM materiais WHERE UPPER(nome)=UPPER(?) AND ativo=1').get(n);
  if (m) return m.id;
  const todos = await db.prepare('SELECT id, nome FROM materiais WHERE ativo=1').all();
  const nm = normMatRdo(n);
  m = todos.find(t => normMatRdo(t.nome) === nm);
  if (m) return m.id;
  // RDO citou material fora do catálogo → auto-cria para não perder a baixa
  try {
    const r = await db.prepare('INSERT INTO materiais (nome,categoria,unidade,quantidade_minima) VALUES (?,?,?,?)').run(n, categoriaAuto(n), 'UND', 0);
    return r.lastInsertRowid;
  } catch (e) {
    const d = await db.prepare('SELECT id FROM materiais WHERE UPPER(nome)=UPPER(?)').get(n);
    return d ? d.id : null;
  }
}

async function movimentarEstoqueRdo(equipeId, materialId, tipo, qtd, origem, usuarioId) {
  const reg = await db.prepare('SELECT id, quantidade_atual FROM estoque_equipes WHERE equipe_id=? AND material_id=?').get(equipeId, materialId);
  const saldoAnt = reg ? (Number(reg.quantidade_atual) || 0) : 0;
  const delta = (tipo === 'entrada' || tipo === 'estorno') ? Math.abs(qtd) : -Math.abs(qtd);
  const novo = Math.round((saldoAnt + delta) * 100) / 100;
  if (db.isPostgres) {
    if (reg) await db.prepare('UPDATE estoque_equipes SET quantidade_atual=?, atualizado_em=NOW() WHERE id=?').run(novo, reg.id);
    else await db.prepare('INSERT INTO estoque_equipes (equipe_id, material_id, quantidade_atual) VALUES (?,?,?)').run(equipeId, materialId, novo);
  } else {
    if (reg) await db.prepare(`UPDATE estoque_equipes SET quantidade_atual=?, atualizado_em=datetime('now') WHERE id=?`).run(novo, reg.id);
    else await db.prepare('INSERT INTO estoque_equipes (equipe_id, material_id, quantidade_atual) VALUES (?,?,?)').run(equipeId, materialId, novo);
  }
  await db.prepare('INSERT INTO estoque_movimentacoes (equipe_id, material_id, tipo, quantidade, saldo_apos, origem, usuario_id) VALUES (?,?,?,?,?,?,?)')
    .run(equipeId, materialId, tipo, Math.abs(qtd), novo, (origem || '').toString().slice(0, 200), usuarioId || null);
  const mat = await db.prepare('SELECT COALESCE(quantidade_minima,0) as minimo, COALESCE(unidade,\'UND\') as unidade, nome FROM materiais WHERE id=?').get(materialId);
  const eq = await db.prepare('SELECT nome FROM equipes WHERE id=?').get(equipeId);
  const minimo = Number(mat?.minimo) || 0;
  return { equipe_id: equipeId, equipe_nome: eq?.nome || '', material_id: materialId, material_nome: mat?.nome || '', unidade: mat?.unidade || 'UND', saldo: novo, minimo, alerta: minimo > 0 && novo <= minimo };
}

async function baixarEstoqueDoRdo(rdoId, equipeNomes, materiais, usuarioId, cobertosLocal) {
  const alertas = [];
  let baixas = 0;
  const eqAtivas = await db.prepare('SELECT id, nome FROM equipes WHERE ativo=1').all();
  const eqIds = [];
  for (const nome of (equipeNomes || [])) {
    const e = eqAtivas.find(x => normEquipe(x.nome) === normEquipe(nome));
    if (e && !eqIds.includes(e.id)) eqIds.push(e.id);
  }
  if (!eqIds.length) return { baixas: 0, alertas, ignorado: 'equipe do RDO não encontrada no cadastro' };
  for (const m of (materiais || [])) {
    const nome = (m.nome || m.material_nome || m.descricao || '').toString().trim();
    const qtd = Number(m.qtd ?? m.quantidade ?? m.qty ?? 0) || 0;
    if (!nome || qtd <= 0) continue;
    const matId = await resolverMaterialIdRdo(nome);
    if (!matId) continue;
    // o que o local já cobriu não sai da equipe (sem contagem dupla)
    const resto = Math.round((qtd - (Number(cobertosLocal?.[matId]) || 0)) * 100) / 100;
    if (resto <= 0) continue;
    const porEquipe = Math.round((resto / eqIds.length) * 100) / 100; // rateio igual entre equipes do RDO
    for (const eqId of eqIds) {
      const r = await movimentarEstoqueRdo(eqId, matId, 'rdo', porEquipe, `RDO #${rdoId}${eqIds.length > 1 ? ` (rateio ${eqIds.length} equipes)` : ''}`, usuarioId);
      baixas++;
      if (r.alerta) alertas.push(r);
    }
  }
  return { baixas, alertas };
}

async function estornarBaixaDoRdo(rdoId, usuarioId) {
  // Reverte via contramovimento (não apaga histórico). Reverte o LÍQUIDO pendente
  // por equipe/material (idempotente: pode rodar após várias edições).
  const id = Number(rdoId);
  const exata = `RDO #${id}`, prefixo = `RDO #${id} (%`;
  const rdoRows = await db.prepare(`SELECT equipe_id, material_id, SUM(quantidade) as q FROM estoque_movimentacoes WHERE tipo='rdo' AND (origem=? OR origem LIKE ?) GROUP BY equipe_id, material_id`).all(exata, prefixo);
  if (!rdoRows.length) return { estornos: 0 };
  const estRows = await db.prepare(`SELECT equipe_id, material_id, SUM(quantidade) as q FROM estoque_movimentacoes WHERE tipo='estorno' AND origem=? GROUP BY equipe_id, material_id`).all(`ESTORNO RDO #${id}`);
  const mapEst = new Map(estRows.map(r => [`${r.equipe_id}:${r.material_id}`, Number(r.q) || 0]));
  let n = 0;
  for (const r of rdoRows) {
    const pend = Math.round(((Number(r.q) || 0) - (mapEst.get(`${r.equipe_id}:${r.material_id}`) || 0)) * 100) / 100;
    if (pend > 0.0001) {
      await movimentarEstoqueRdo(r.equipe_id, r.material_id, 'estorno', pend, `ESTORNO RDO #${id}`, usuarioId);
      n++;
    }
  }
  return { estornos: n };
}

// ============================================================
// BAIXA AUTOMÁTICA RDO → ESTOQUE FÍSICO DO LOCAL
// O RDO consome do LOCAL primeiro (limitado ao saldo); o que faltar sai da
// EQUIPE (rateado). Sem contagem dupla: total debitado == qtd do RDO.
async function movimentarEstoqueLocal(localId, materialId, tipo, qtd, origem, usuarioId) {
  const reg = await db.prepare('SELECT id, quantidade_atual FROM estoque_locais WHERE local_id=? AND material_id=?').get(localId, materialId);
  const saldoAnt = reg ? (Number(reg.quantidade_atual) || 0) : 0;
  const delta = (tipo === 'entrada' || tipo === 'estorno') ? Math.abs(qtd) : -Math.abs(qtd);
  const novo = Math.round((saldoAnt + delta) * 100) / 100;
  if (db.isPostgres) {
    if (reg) await db.prepare('UPDATE estoque_locais SET quantidade_atual=?, atualizado_em=NOW() WHERE id=?').run(novo, reg.id);
    else await db.prepare('INSERT INTO estoque_locais (local_id, material_id, quantidade_atual) VALUES (?,?,?)').run(localId, materialId, novo);
  } else {
    if (reg) await db.prepare(`UPDATE estoque_locais SET quantidade_atual=?, atualizado_em=datetime('now') WHERE id=?`).run(novo, reg.id);
    else await db.prepare('INSERT INTO estoque_locais (local_id, material_id, quantidade_atual) VALUES (?,?,?)').run(localId, materialId, novo);
  }
  await db.prepare('INSERT INTO estoque_local_movimentacoes (local_id, material_id, tipo, quantidade, saldo_apos, origem, usuario_id) VALUES (?,?,?,?,?,?,?)')
    .run(localId, materialId, tipo, Math.abs(qtd), novo, (origem || '').toString().slice(0, 200), usuarioId || null);
  const mat = await db.prepare('SELECT COALESCE(quantidade_minima,0) as minimo, COALESCE(unidade,\'UND\') as unidade, nome FROM materiais WHERE id=?').get(materialId);
  const loc = await db.prepare('SELECT nome FROM locais WHERE id=?').get(localId);
  const minimo = Number(mat?.minimo) || 0;
  return { local_id: localId, local_nome: loc?.nome || '', material_id: materialId, material_nome: mat?.nome || '', unidade: mat?.unidade || 'UND', saldo: novo, minimo, alerta: minimo > 0 && novo <= minimo };
}

async function baixarEstoqueLocalDoRdo(rdoId, localId, materiais, usuarioId) {
  // Consome do LOCAL primeiro, limitado ao saldo (sem negativar): o que o local
  // não cobrir, a equipe cobre (ver cobertos). Evita contagem dupla equipe+local.
  const alertas = [];
  const cobertos = {};
  let baixas = 0;
  const lid = Number(localId);
  if (!lid) return { baixas: 0, alertas, cobertos, ignorado: 'RDO sem local vinculado' };
  const loc = await db.prepare('SELECT id FROM locais WHERE id=?').get(lid);
  if (!loc) return { baixas: 0, alertas, cobertos, ignorado: 'local do RDO nao encontrado' };
  for (const m of (materiais || [])) {
    const nome = (m.nome || m.material_nome || m.descricao || '').toString().trim();
    const qtd = Number(m.qtd ?? m.quantidade ?? m.qty ?? 0) || 0;
    if (!nome || qtd <= 0) continue;
    const matId = await resolverMaterialIdRdo(nome);
    if (!matId) continue;
    const reg = await db.prepare('SELECT quantidade_atual FROM estoque_locais WHERE local_id=? AND material_id=?').get(lid, matId);
    const deb = Math.min(qtd, Math.max(0, Number(reg?.quantidade_atual) || 0));
    if (deb <= 0) continue; // local sem saldo: equipe cobre tudo
    const r = await movimentarEstoqueLocal(lid, matId, 'rdo', deb, `RDO #${rdoId}`, usuarioId);
    cobertos[matId] = Math.round(((cobertos[matId] || 0) + deb) * 100) / 100;
    baixas++;
    if (r.alerta) alertas.push(r);
  }
  return { baixas, alertas, cobertos };
}

async function estornarBaixaLocalDoRdo(rdoId, usuarioId) {
  // Mesmo padrão idempotente da equipe: reverte o líquido pendente por local/material.
  const id = Number(rdoId);
  const exata = `RDO #${id}`;
  const rdoRows = await db.prepare(`SELECT local_id, material_id, SUM(quantidade) as q FROM estoque_local_movimentacoes WHERE tipo='rdo' AND origem=? GROUP BY local_id, material_id`).all(exata);
  if (!rdoRows.length) return { estornos: 0 };
  const estRows = await db.prepare(`SELECT local_id, material_id, SUM(quantidade) as q FROM estoque_local_movimentacoes WHERE tipo='estorno' AND origem=? GROUP BY local_id, material_id`).all(`ESTORNO RDO #${id}`);
  const mapEst = new Map(estRows.map(r => [`${r.local_id}:${r.material_id}`, Number(r.q) || 0]));
  let n = 0;
  for (const r of rdoRows) {
    const pend = Math.round(((Number(r.q) || 0) - (mapEst.get(`${r.local_id}:${r.material_id}`) || 0)) * 100) / 100;
    if (pend > 0.0001) {
      await movimentarEstoqueLocal(r.local_id, r.material_id, 'estorno', pend, `ESTORNO RDO #${id}`, usuarioId);
      n++;
    }
  }
  return { estornos: n };
}

app.post('/api/rdos', async (req, res) => {
  const d = req.body;
  if (!d.data || (!d.local && !d.local_id)) return res.status(400).json({ error: 'Data e local obrigatorios' });
  // F1: resolve obra_id/local_id de forma inteligente para multi-obra
  let obraId = d.obra_id ? Number(d.obra_id) : null;
  let localId = d.local_id ? Number(d.local_id) : null;
  // Se veio só nome do local, tenta resolver local_id e obra_id
  // ATENÇÃO: pode existir mais de um local com o mesmo nome em comarcas diferentes (ex.: "Fórum" repete em várias comarcas).
  // Por isso preferimos sempre d.local_id vindo do front (id único da opção marcada). Este é só um fallback best-effort,
  // restrito à obra selecionada quando possível, para reduzir a chance de pegar o local errado (e a cidade errada).
  if (!localId && d.local) {
    let loc;
    if (obraId) {
      loc = await db.prepare('SELECT id, obra_id FROM locais WHERE nome=? AND ativo=1 AND obra_id=? ORDER BY id LIMIT 1').get(d.local, obraId);
    }
    if (!loc) {
      loc = await db.prepare('SELECT id, obra_id FROM locais WHERE nome=? AND ativo=1 ORDER BY id LIMIT 1').get(d.local);
    }
    if (loc) { localId = loc.id; if (!obraId) obraId = loc.obra_id; }
  }
  if (!obraId && localId) {
    const loc = await db.prepare('SELECT obra_id FROM locais WHERE id=?').get(localId);
    if (loc) obraId = loc.obra_id;
  }
  // Fallback TJ-CE global para dados legados sem obra_id
  if (!obraId) {
    const tjce = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
    if (tjce) obraId = tjce.id;
  }
  const localNome = d.local || (localId ? (await db.prepare('SELECT nome FROM locais WHERE id=?').get(localId))?.nome || '' : '');
  const r = await db.prepare(`INSERT INTO rdos (obra_id,local_id,data,local,atividade,equipe_json,materiais_json,
    entrada_manha,saida_manha,entrada_tarde,saida_tarde,
    parou,motivo_parada,switch_instalado,nom_switch,local_switch,
    camera_instalada,nom_camera,local_camera,fotos_json,usuario_id,usuario_nome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    obraId, localId, d.data, localNome, d.atividade || '',
    JSON.stringify(d.equipe || []), JSON.stringify(d.materiais || []),
    d.entrada_manha, d.saida_manha, d.entrada_tarde, d.saida_tarde,
    d.parou || 'nao', d.motivo_parada || '',
    d.switch_instalado || 'nao', d.nom_switch || '', d.local_switch || '',
    d.camera_instalada || 'nao', d.nom_camera || '', d.local_camera || '',
    JSON.stringify(d.fotos || []),
    req.user ? req.user.id : null, req.user ? req.user.nome : 'Anonimo'
  );
  // Inteligente: auto-etapa per-local — usa obra_id real (não só TJ-CE) para multi-obra
  try {
    const ativ = (d.atividade||'').toString().trim();
    let targetObraId = obraId;
    let targetLocalId = localId;
    if (!targetLocalId && d.local) {
      const lr = await db.prepare('SELECT id FROM locais WHERE nome=? AND ativo=1').get(d.local);
      if (lr) targetLocalId = lr.id;
    }
    if (targetLocalId && ativ) {
      if (!targetObraId) {
        const lr2 = await db.prepare('SELECT obra_id FROM locais WHERE id=?').get(targetLocalId);
        if (lr2) targetObraId = lr2.obra_id;
      }
      if (targetObraId) {
        const tmpl = await db.prepare("SELECT ordem FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0) AND UPPER(nome)=UPPER(?)").get(targetObraId, ativ);
        const ordem = tmpl ? tmpl.ordem : 999;
        const existe = await db.prepare("SELECT id FROM etapas WHERE obra_id=? AND local_id=? AND UPPER(nome)=UPPER(?)").get(targetObraId, targetLocalId, ativ);
        if (!existe) {
          await db.prepare("INSERT INTO etapas (obra_id, local_id, nome, ordem, status) VALUES (?,?,?,?,?)").run(targetObraId, targetLocalId, ativ, ordem, 'concluida');
        } else {
          await db.prepare("UPDATE etapas SET status='concluida' WHERE id=?").run(existe.id);
        }
        // Fecha o ciclo: RDO→etapa→progresso da obra na mesma fonte do Relatórios
        try { await atualizarProgresso(targetObraId); } catch (e2) { console.error('[etapa-auto-progresso]', e2.message); }
      }
    }
  } catch(e){ console.error('[etapa-auto]', e.message); }
  try {
    await rdoLog(r.lastInsertRowid, 'CRIACAO', req, '', null, { obra_id: obraId, local_id: localId, data: d.data, local: localNome, atividade: d.atividade || '' });
    io.emit('rdo_novo', { id: r.lastInsertRowid });
  } catch(e){}
  // Baixa automática: LOCAL primeiro (limitado ao saldo), equipe cobre o resto (sem contagem dupla)
  let estoqueInfo = null;
  let estoqueLocalInfo = null;
  try {
    estoqueLocalInfo = await baixarEstoqueLocalDoRdo(r.lastInsertRowid, localId, d.materiais || [], req.user ? req.user.id : null);
    estoqueInfo = await baixarEstoqueDoRdo(r.lastInsertRowid, d.equipe || [], d.materiais || [], req.user ? req.user.id : null, estoqueLocalInfo.cobertos);
    if (estoqueInfo.alertas?.length) try { io.emit('estoque_alerta', { rdo_id: r.lastInsertRowid, alertas: estoqueInfo.alertas }); } catch (e2) {}
  } catch (e) { console.error('[estoque-rdo-baixa]', e.message); }
  res.json({ ok: true, id: r.lastInsertRowid, estoque: estoqueInfo, estoque_local: estoqueLocalInfo });
});

app.put('/api/rdos/:id', async (req, res) => {
  const d = req.body;
  const antes = await db.prepare('SELECT * FROM rdos WHERE id=?').get(req.params.id);
  if (!antes) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (Number(antes.ativo) === 0) return res.status(400).json({ error: 'RDO excluido — restaure antes de editar' });
  if (!podeEditarRdo(req, antes)) return res.status(403).json({ error: 'So o dono do RDO ou gestor pode editar' });
  const travH = rdoTravado24h(antes, req);
  if (travH) return res.status(403).json({ error: 'RDO com mais de 24h (' + travH + 'h) — só o gestor pode corrigir. Fale com o encarregado.' });
  const motivoEdicao = (d.motivo_edicao || d.motivo || '').toString().trim();
  if (!motivoEdicao || motivoEdicao.length < 3) return res.status(400).json({ error: 'Informe o motivo da edicao (min. 3 letras) — exigido para auditoria de documento de obra' });
  let localId = d.local_id ? Number(d.local_id) : null;
  let obraId = d.obra_id ? Number(d.obra_id) : null;
  // Fallback por nome (só quando o front não mandou local_id) — restrito à obra quando possível,
  // pois o mesmo nome de local pode existir em comarcas diferentes.
  if (!localId && d.local) {
    let loc;
    if (obraId) {
      loc = await db.prepare('SELECT id FROM locais WHERE nome=? AND ativo=1 AND obra_id=? ORDER BY id LIMIT 1').get(d.local, obraId);
    }
    if (!loc) {
      loc = await db.prepare('SELECT id FROM locais WHERE nome=? AND ativo=1 ORDER BY id LIMIT 1').get(d.local);
    }
    if (loc) localId = loc.id;
  }
  if (!obraId && localId) {
    const loc = await db.prepare('SELECT obra_id FROM locais WHERE id=?').get(localId);
    if (loc) obraId = loc.obra_id;
  }
  // se veio obra_id/local_id, atualiza, senão mantém os antigos
  if (!obraId) obraId = antes.obra_id;
  if (!localId) localId = antes.local_id;
  const dataFinal = d.data || antes.data;
  const localFinal = d.local !== undefined ? d.local : antes.local;
  if (!dataFinal || !localFinal) return res.status(400).json({ error: 'Data e local obrigatorios' });
  const depois = {
    obra_id: obraId, local_id: localId, data: dataFinal, local: localFinal,
    atividade: d.atividade !== undefined ? (d.atividade || '') : antes.atividade,
    equipe: d.equipe !== undefined ? d.equipe : JSON.parse(antes.equipe_json || '[]'),
    materiais: d.materiais !== undefined ? d.materiais : JSON.parse(antes.materiais_json || '[]')
  };
  await db.prepare(`UPDATE rdos SET obra_id=?,local_id=?,data=?,local=?,atividade=?,equipe_json=?,materiais_json=?,
    entrada_manha=?,saida_manha=?,entrada_tarde=?,saida_tarde=?,
    parou=?,motivo_parada=?,switch_instalado=?,nom_switch=?,local_switch=?,
    camera_instalada=?,nom_camera=?,local_camera=?,fotos_json=?,
    atualizado_em=datetime('now'),atualizado_por=? WHERE id=?`).run(
    obraId, localId, dataFinal, localFinal, depois.atividade,
    JSON.stringify(depois.equipe), JSON.stringify(depois.materiais),
    d.entrada_manha !== undefined ? d.entrada_manha : antes.entrada_manha,
    d.saida_manha !== undefined ? d.saida_manha : antes.saida_manha,
    d.entrada_tarde !== undefined ? d.entrada_tarde : antes.entrada_tarde,
    d.saida_tarde !== undefined ? d.saida_tarde : antes.saida_tarde,
    d.parou !== undefined ? d.parou : antes.parou,
    d.motivo_parada !== undefined ? d.motivo_parada : antes.motivo_parada,
    d.switch_instalado !== undefined ? d.switch_instalado : antes.switch_instalado,
    d.nom_switch !== undefined ? d.nom_switch : antes.nom_switch,
    d.local_switch !== undefined ? d.local_switch : antes.local_switch,
    d.camera_instalada !== undefined ? d.camera_instalada : antes.camera_instalada,
    d.nom_camera !== undefined ? d.nom_camera : antes.nom_camera,
    d.local_camera !== undefined ? d.local_camera : antes.local_camera,
    JSON.stringify(d.fotos !== undefined ? d.fotos : JSON.parse(antes.fotos_json || '[]')),
    req.user ? req.user.nome : 'Anonimo',
    req.params.id
  );
  await rdoLog(req.params.id, 'EDICAO', req, motivoEdicao, antes, depois);
  try { io.emit('rdo_atualizado', { id: Number(req.params.id), por: req.user ? req.user.nome : '' }); } catch(e){}
  // Recompõe estoque: estorna baixa antiga e aplica a nova (materiais/equipe/local podem ter mudado)
  let estoqueInfo = null;
  try {
    await estornarBaixaDoRdo(req.params.id, req.user ? req.user.id : null);
    await estornarBaixaLocalDoRdo(req.params.id, req.user ? req.user.id : null);
    const estoqueLocalInfo = await baixarEstoqueLocalDoRdo(req.params.id, localId, depois.materiais || [], req.user ? req.user.id : null);
    estoqueInfo = await baixarEstoqueDoRdo(req.params.id, depois.equipe || [], depois.materiais || [], req.user ? req.user.id : null, estoqueLocalInfo.cobertos);
    estoqueInfo.estoque_local = estoqueLocalInfo;
    if (estoqueInfo.alertas?.length) try { io.emit('estoque_alerta', { rdo_id: Number(req.params.id), alertas: estoqueInfo.alertas }); } catch (e2) {}
  } catch (e) { console.error('[estoque-rdo-edicao]', e.message); }
  res.json({ ok: true, estoque: estoqueInfo });
});

app.delete('/api/rdos/:id', async (req, res) => {
  const rdo = await db.prepare('SELECT * FROM rdos WHERE id=?').get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (Number(rdo.ativo) === 0) return res.status(400).json({ error: 'RDO ja excluido' });
  if (req.user.perfil !== 'gestor' && Number(rdo.usuario_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'So o dono do RDO ou gestor pode excluir' });
  }
  const travHx = rdoTravado24h(rdo, req);
  if (travHx) return res.status(403).json({ error: 'RDO com mais de 24h (' + travHx + 'h) — só o gestor pode excluir. Fale com o encarregado.' });
  const motivo = ((req.body && req.body.motivo) || req.query.motivo || '').toString().trim();
  if (!motivo || motivo.length < 5) return res.status(400).json({ error: 'Informe o motivo da exclusao (min. 5 letras) — exigido para auditoria' });
  const quem = req.user ? req.user.nome : 'Anonimo';
  await db.prepare(`UPDATE rdos SET ativo=0, excluido_em=datetime('now'), excluido_por=?, motivo_exclusao=? WHERE id=?`).run(quem, motivo.slice(0, 500), req.params.id);
  await rdoLog(req.params.id, 'EXCLUSAO', req, motivo, rdo, { ativo: 0, excluido_por: quem, motivo_exclusao: motivo });
  try { await estornarBaixaDoRdo(req.params.id, req.user ? req.user.id : null); } catch (e) { console.error('[estoque-rdo-exclusao]', e.message); }
  try { await estornarBaixaLocalDoRdo(req.params.id, req.user ? req.user.id : null); } catch (e) { console.error('[estoque-local-exclusao]', e.message); }
  try { io.emit('rdo_excluido', { id: Number(req.params.id), por: quem, motivo }); } catch(e){}
  res.json({ ok: true, auditoria: { por: quem, motivo } });
});

// Restaurar RDO excluido (somente gestor) — mantem trilha
app.post('/api/rdos/:id/restaurar', gestor, async (req, res) => {
  const rdo = await db.prepare('SELECT * FROM rdos WHERE id=?').get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (Number(rdo.ativo) !== 0) return res.status(400).json({ error: 'RDO nao esta excluido' });
  await db.prepare(`UPDATE rdos SET ativo=1, excluido_em=NULL, excluido_por=NULL, motivo_exclusao=NULL, atualizado_em=datetime('now'), atualizado_por=? WHERE id=?`)
    .run(req.user ? req.user.nome : 'Anonimo', req.params.id);
  await rdoLog(req.params.id, 'RESTAURACAO', req, (req.body && req.body.motivo) || 'Restaurado pelo gestor', { ativo: 0 }, { ativo: 1 });
  try {
    const rdoRest = await db.prepare('SELECT equipe_json, materiais_json, local_id FROM rdos WHERE id=?').get(req.params.id);
    const locInfo = await baixarEstoqueLocalDoRdo(req.params.id, rdoRest.local_id, JSON.parse(rdoRest.materiais_json || '[]'), req.user ? req.user.id : null);
    await baixarEstoqueDoRdo(req.params.id, JSON.parse(rdoRest.equipe_json || '[]'), JSON.parse(rdoRest.materiais_json || '[]'), req.user ? req.user.id : null, locInfo.cobertos);
  } catch (e) { console.error('[estoque-rdo-restaurar]', e.message); }
  await rdoLog(req.params.id, 'RESTAURACAO', req, (req.body && req.body.motivo) || 'Restaurado pelo gestor', { ativo: 0 }, { ativo: 1 });
  try { io.emit('rdo_restaurado', { id: Number(req.params.id) }); } catch(e){}
  res.json({ ok: true });
});

// Upload de fotos
app.post('/api/upload', upload.array('fotos', 10), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo' });
  const urls = req.files.map(f => '/uploads/' + f.filename);
  res.json({ ok: true, urls });
});

// Presenca / Localizacao em tempo real
app.post('/api/presenca', async (req, res) => {
  const { latitude, longitude, obra_id, local_nome } = req.body;
  if (!req.user) return res.status(401).json({ error: 'Nao autenticado' });
  const existe = await db.prepare('SELECT id FROM presenca WHERE usuario_id=?').get(req.user.id);
  if (existe) {
    await db.prepare('UPDATE presenca SET latitude=?,longitude=?,obra_id=?,local_nome=?,usuario_nome=?,equipe_id=?,atualizado_em=datetime(\'now\') WHERE usuario_id=?')
      .run(latitude, longitude, obra_id || null, local_nome || '', req.user.nome, req.user.equipe_id || null, req.user.id);
  } else {
    await db.prepare('INSERT INTO presenca (usuario_id,usuario_nome,equipe_id,latitude,longitude,obra_id,local_nome) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.id, req.user.nome, req.user.equipe_id || null, latitude, longitude, obra_id || null, local_nome || '');
  }
  res.json({ ok: true });
});

app.get('/api/presenca', async (req, res) => {
  let sql = `SELECT p.*, u.email, u.perfil FROM presenca p JOIN usuarios u ON p.usuario_id=u.id WHERE u.ativo=1`;
  const p = [];
  if (req.query.equipe_id) { sql += ' AND p.equipe_id=?'; p.push(req.query.equipe_id); }
  res.json(await db.prepare(sql + ' ORDER BY p.atualizado_em DESC').all(...p));
});

// Minha presenca (apenas do usuario logado)
app.get('/api/minha-presenca', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nao autenticado' });
  const registros = await db.prepare(`SELECT p.*, u.email FROM presenca p JOIN usuarios u ON p.usuario_id=u.id 
    WHERE p.usuario_id=? AND u.ativo=1 ORDER BY p.atualizado_em DESC`).all(req.user.id);
  res.json(registros);
});

app.get('/api/presenca/equipe/:id', async (req, res) => {
  res.json(await db.prepare(`SELECT p.*, u.email FROM presenca p JOIN usuarios u ON p.usuario_id=u.id 
    WHERE p.equipe_id=? AND u.ativo=1 ORDER BY p.atualizado_em DESC`).all(req.params.id));
});

// Minha equipe
app.get('/api/minha-equipe', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nao autenticado' });
  if (!req.user.equipe_id) return res.json(null);
  const equipe = await db.prepare('SELECT * FROM equipes WHERE id=?').get(req.user.equipe_id);
  if (!equipe) return res.json(null);
  equipe.membros = await db.prepare('SELECT id,nome,email FROM usuarios WHERE equipe_id=? AND ativo=1').all(req.user.equipe_id);
  return res.json(equipe);
});

// Dashboard
app.get('/api/dashboard', gestor, async (req, res) => {
  const totalObras = Number((await db.prepare('SELECT COUNT(*) as c FROM obras WHERE ativo=1').get()).c)||0;
  const totalRdos = Number((await db.prepare('SELECT COUNT(*) as c FROM rdos WHERE COALESCE(ativo,1)=1').get()).c)||0;
  const rdosHoje = Number((await db.prepare("SELECT COUNT(*) as c FROM rdos WHERE COALESCE(ativo,1)=1 AND data=date('now')").get()).c)||0;
  const totalUsuarios = Number((await db.prepare('SELECT COUNT(*) as c FROM usuarios WHERE ativo=1').get()).c)||0;
  const totalEquipes = Number((await db.prepare('SELECT COUNT(*) as c FROM equipes WHERE ativo=1').get()).c)||0;
  const recentes = await db.prepare('SELECT id,data,local,atividade,usuario_nome FROM rdos WHERE COALESCE(ativo,1)=1 ORDER BY criado_em DESC LIMIT 10').all();
  res.json({ totalObras, totalRdos, rdosHoje, totalUsuarios, totalEquipes, recentes });
});

// Dashboard por equipe (REGIAO do mesclado + presenca/RDO) - F2 com filtro obra_id + normalização multi-obra
app.get('/api/dashboard/por-equipe', gestor, async (req, res) => {
  let sqlPorRegiao = `SELECT regiao, COUNT(*) as total_locais, SUM(cameras) as total_cameras, SUM(cam_fixa) as fixa, SUM(cam_analitica) as analitica, SUM(cam_lpr) as lpr, SUM(CASE WHEN latitude IS NOT NULL AND latitude!='' THEN 1 ELSE 0 END) as com_coord FROM locais WHERE ativo=1`;
  const pReg = [];
  if (req.query.obra_id) { sqlPorRegiao += ' AND obra_id=?'; pReg.push(req.query.obra_id); }
  sqlPorRegiao += ' GROUP BY regiao';
  const porRegiaoRaw = await db.prepare(sqlPorRegiao).all(...pReg);
  porRegiaoRaw.forEach(r=>{ if(!r.regiao || !r.regiao.trim()) r.regiao='SEM EQUIPE'; r.total_locais=Number(r.total_locais)||0; r.total_cameras=Number(r.total_cameras)||0; r.fixa=Number(r.fixa)||0; r.analitica=Number(r.analitica)||0; r.lpr=Number(r.lpr)||0; r.com_coord=Number(r.com_coord)||0; });
  // merge por chave normalizada (EQUIPE5 == EQUIPE 5) - cast para Number pois Postgres retorna strings
  const porRegiaoNorm = {};
  for(const r of porRegiaoRaw){
    const n = normEquipe(r.regiao);
    if(!porRegiaoNorm[n]) porRegiaoNorm[n]={regiao:r.regiao, total_locais:0, total_cameras:0, fixa:0, analitica:0, lpr:0, com_coord:0};
    porRegiaoNorm[n].total_locais+=Number(r.total_locais)||0;
    porRegiaoNorm[n].total_cameras+=Number(r.total_cameras)||0;
    porRegiaoNorm[n].fixa+=Number(r.fixa)||0;
    porRegiaoNorm[n].analitica+=Number(r.analitica)||0;
    porRegiaoNorm[n].lpr+=Number(r.lpr)||0;
    porRegiaoNorm[n].com_coord+=Number(r.com_coord)||0;
    // mantém nome da equipe quando existir
  }
  const equipes = await db.prepare('SELECT id,nome,cor FROM equipes WHERE ativo=1 AND COALESCE(eh_geral,0)=0').all();
  const equipesByNorm={}; equipes.forEach(e=>{ const n=normEquipe(e.nome); if(!equipesByNorm[n]) equipesByNorm[n]=e; else if(e.nome.length<equipesByNorm[n].nome.length) equipesByNorm[n]=e; });
  // corrige display: se equipe existe, usa nome da equipe
  for(const n of Object.keys(porRegiaoNorm)){
    if(equipesByNorm[n]) porRegiaoNorm[n].regiao=equipesByNorm[n].nome;
  }
  const membros = await db.prepare('SELECT equipe_id, COUNT(*) as c FROM usuarios WHERE ativo=1 AND equipe_id IS NOT NULL GROUP BY equipe_id').all();
  const membrosMap = Object.fromEntries(membros.map(m=>[String(m.equipe_id), Number(m.c)||0]));
  let sqlRdos = `SELECT u.equipe_id as equipe_id, COUNT(r.id) as total, SUM(CASE WHEN r.data=date('now') THEN 1 ELSE 0 END) as hoje FROM rdos r JOIN usuarios u ON r.usuario_id=u.id WHERE u.equipe_id IS NOT NULL`;
  const pRdos=[];
  if (req.query.obra_id) { sqlRdos+=' AND r.obra_id=?'; pRdos.push(req.query.obra_id); }
  sqlRdos+=' GROUP BY u.equipe_id';
  const rdosPorEquipe = await db.prepare(sqlRdos).all(...pRdos);
  const rdoMap = Object.fromEntries(rdosPorEquipe.map(r=>[String(r.equipe_id), {total:Number(r.total)||0, hoje:Number(r.hoje)||0}]));
  let sqlPres=`SELECT equipe_id, COUNT(*) as c FROM presenca WHERE equipe_id IS NOT NULL`;
  const pPres=[];
  if (req.query.obra_id) { sqlPres+=' AND obra_id=?'; pPres.push(req.query.obra_id); }
  sqlPres+=' GROUP BY equipe_id';
  const presPorEquipe = await db.prepare(sqlPres).all(...pPres);
  const presMap = Object.fromEntries(presPorEquipe.map(p=>[String(p.equipe_id), Number(p.c)||0]));

  const normSem = normEquipe('SEM EQUIPE');
  const chavesNorm = new Set([...Object.keys(porRegiaoNorm), ...Object.keys(equipesByNorm), normSem]);
  const resultado = [];
  for (const n of chavesNorm) {
    const reg = porRegiaoNorm[n]||null;
    const eq = equipesByNorm[n]||null;
    const equipe_id = eq ? eq.id : null;
    const label = eq? eq.nome : (reg? reg.regiao : 'SEM EQUIPE');
    const m = equipe_id ? (membrosMap[String(equipe_id)]||0) : 0;
    const rdo = equipe_id ? (rdoMap[String(equipe_id)]||{total:0,hoje:0}) : {total:0,hoje:0};
    const pres = equipe_id ? (presMap[String(equipe_id)]||0) : 0;
    resultado.push({
      regiao: label,
      equipe_id, cor: eq?eq.cor:'#90a4ae',
      total_locais: reg?reg.total_locais:0,
      total_cameras: reg?reg.total_cameras:0,
      cam_fixa: reg?reg.fixa:0, cam_analitica: reg?reg.analitica:0, cam_lpr: reg?reg.lpr:0,
      com_coord: reg?reg.com_coord:0,
      membros: m, rdos_total: rdo.total||0, rdos_hoje: rdo.hoje||0, tecnicos_ativos: pres
    });
  }
  resultado.sort((a,b)=> b.total_locais - a.total_locais);
  res.json(resultado);
});

// Dashboard de desempenho por etapa (F2 multi-obra) - filtra por obra_id, default TJ-CE para compat
app.get('/api/dashboard/etapas-desempenho', gestor, async (req,res)=>{
  let obraId = req.query.obra_id ? Number(req.query.obra_id) : null;
  if (!obraId) {
    const tjce = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
    if(!tjce) return res.json({etapas:[], locais:[], totalLocais:0});
    obraId = tjce.id;
  } else {
    const existe = await db.prepare('SELECT id FROM obras WHERE id=? AND ativo=1').get(obraId);
    if(!existe) return res.status(404).json({error:'Obra não encontrada'});
  }
  const template = await db.prepare('SELECT id,nome,ordem FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0) ORDER BY ordem').all(obraId);
  const totalLocais = (await db.prepare('SELECT COUNT(*) c FROM locais WHERE ativo=1 AND obra_id=?').get(obraId)).c;
  // agregados por etapa - concluidas per-local
  const conclPorEtapa = await db.prepare("SELECT UPPER(nome) as n, COUNT(*) c FROM etapas WHERE obra_id=? AND local_id IS NOT NULL AND status='concluida' GROUP BY UPPER(nome)").all(obraId);
  const mapConcl = Object.fromEntries(conclPorEtapa.map(r=>[r.n, r.c]));
  const rdosPorEtapa = await db.prepare("SELECT UPPER(atividade) as n, COUNT(*) c FROM rdos WHERE obra_id=? AND atividade IS NOT NULL AND atividade!='' GROUP BY UPPER(atividade)").all(obraId);
  const mapRdosEtapa = Object.fromEntries(rdosPorEtapa.map(r=>[r.n, r.c]));
  const rdosHojePorEtapa = await db.prepare("SELECT UPPER(atividade) as n, COUNT(*) c FROM rdos WHERE obra_id=? AND data=date('now') GROUP BY UPPER(atividade)").all(obraId);
  const mapHoje = Object.fromEntries(rdosHojePorEtapa.map(r=>[r.n, r.c]));
  const etapas = template.map(t=>{
    const key = t.nome.toUpperCase();
    const concl = mapConcl[key] || 0;
    return {
      nome: t.nome, ordem: t.ordem,
      concluidos: concl, pendentes: totalLocais - concl,
      totalRdos: mapRdosEtapa[key] || 0, rdosHoje: mapHoje[key] || 0,
      pct: totalLocais ? Math.round(concl/totalLocais*100) : 0
    };
  });
  // per-local - filtrado por obra_id
  const locais = await db.prepare('SELECT id,nome,comarca,regiao,obra_id FROM locais WHERE ativo=1 AND obra_id=? ORDER BY regiao, comarca').all(obraId);
  const conclPorLocal = await db.prepare("SELECT local_id, COUNT(*) c FROM etapas WHERE obra_id=? AND local_id IS NOT NULL AND status='concluida' GROUP BY local_id").all(obraId);
  const mapConclLocal = Object.fromEntries(conclPorLocal.map(r=>[String(r.local_id), r.c]));
  const rdosPorLocal = await db.prepare('SELECT local, COUNT(*) c FROM rdos WHERE obra_id=? GROUP BY local').all(obraId);
  const mapRdosLocal = Object.fromEntries(rdosPorLocal.map(r=>[r.local, r.c]));
  // ultimo RDO por local (mais recente) - filtrado por obra
  const ultimosRows = await db.prepare('SELECT local, data, atividade, usuario_nome FROM rdos WHERE obra_id=? ORDER BY data DESC, criado_em DESC').all(obraId);
  const mapUltimo = {};
  for(const r of ultimosRows){ if(!mapUltimo[r.local]) mapUltimo[r.local]=r; }
  const totalTpl = template.length || 1;
  let perLocal = locais.map(l=>{
    const concl = mapConclLocal[String(l.id)] || 0;
    return {
      ...l,
      concluidas: concl, total: totalTpl,
      progresso: Math.round(concl/totalTpl*100),
      totalRdos: mapRdosLocal[l.nome] || 0,
      ultimoRdo: mapUltimo[l.nome] ? `${mapUltimo[l.nome].data} - ${mapUltimo[l.nome].atividade} (${mapUltimo[l.nome].usuario_nome})` : null
    };
  });
  if(req.query.regiao) perLocal = perLocal.filter(l=> (l.regiao||'SEM EQUIPE')===req.query.regiao);
  if(req.query.busca) {
    const b=req.query.busca.toLowerCase();
    perLocal = perLocal.filter(l=> (l.nome+l.comarca+l.regiao).toLowerCase().includes(b));
  }
  perLocal.sort((a,b)=> a.progresso - b.progresso);
  // limita para não pesar
  const limit = parseInt(req.query.limit||'200');
  res.json({etapas, locais: perLocal.slice(0,limit), totalLocais, totalTpl, totalFiltrados: perLocal.length});
});

// ============================================================
// SOCKET.IO
// ============================================================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Token obrigatorio'));
  const user = verifyToken(token);
  if (!user) return next(new Error('Token invalido'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.on('novo_rdo', (data) => {
    io.emit('rdo_novo', data);
  });
});

// ============================================================
// ROUTES
// ============================================================
app.get('/', async (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', async (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/login', async (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/manual', async (req, res) => res.sendFile(path.join(__dirname, 'public', 'manual.html')));

// Middleware de erro — transforma PGError/SQLite error em 500 JSON em vez de timeout 502 (Express 4 async)
app.use((err, req, res, next) => {
  console.error('[api error]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Erro interno' });
});

function startServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('   IPQ Tecnologia - RDO de Campo' + (db.isPostgres ? ' [Postgres]' : ' [SQLite]'));
    console.log('=========================================');
    console.log('Painel:  http://localhost:' + PORT);
    console.log('Campo:   http://localhost:' + PORT + '/app');
    console.log('Login:   http://localhost:' + PORT + '/login');
    console.log('=========================================');
    console.log('Admin: admin@ipq.com / admin123');
    console.log('=========================================');
  });
  server.on('error', (e) => console.error('[server error]', e));
}
dbReady.then(startServer).catch((e) => {
  console.error('[boot] initDb falhou, subindo mesmo assim:', e);
  startServer();
});
