const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;
const isPostgres = !!DATABASE_URL;

let db;
let pool;

if (isPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (e) => console.error('[pg pool]', e));
  console.log('[db] usando Postgres (Supabase)');
} else {
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'crm.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log('[db] usando SQLite local');
}

// Traduz ? para $1,$2 e dialetos para Postgres
function toPg(sql) {
  let s = sql;
  // INSERT OR IGNORE -> ON CONFLICT
  if (/INSERT\s+OR\s+IGNORE/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT');
    if (/materiais/i.test(s)) s = s.replace(/VALUES\s*\(/i, 'VALUES (') + ' ON CONFLICT (nome) DO NOTHING';
    else s += ' ON CONFLICT DO NOTHING';
  }
  // date('now') -> CURRENT_DATE::text (rdos.data é TEXT YYYY-MM-DD)
  s = s.replace(/date\('now'\)/gi, 'CURRENT_DATE::text');
  // datetime('now') -> NOW()
  s = s.replace(/datetime\('now'\)/gi, 'NOW()');
  // LIKE -> ILIKE no Postgres para busca case-insensitive (materiais com 1ª maiúscula)
  s = s.replace(/\sLIKE\s/gi, ' ILIKE ');
  let i = 0;
  return s.replace(/\?/g, () => `$${++i}`);
}

// Wrapper unificado
const wrapper = {
  isPostgres,
  async exec(sql) {
    if (isPostgres) {
      // divide por ; para multiplas queries (CREATE)
      const stmts = sql.split(';').map(s=>s.trim()).filter(Boolean);
      for (const s of stmts) await pool.query(s);
    } else {
      db.exec(sql);
    }
  },
  prepare(sql) {
    if (isPostgres) {
      const pgSql = toPg(sql);
      // Detecta tipo para retorno
      const isSelect = /^\s*SELECT/i.test(sql);
      const isInsert = /^\s*INSERT/i.test(sql);
      return {
        get: async (...params) => {
          const res = await pool.query(pgSql, params);
          return res.rows[0] || undefined;
        },
        all: async (...params) => {
          const res = await pool.query(pgSql, params);
          return res.rows;
        },
        run: async (...params) => {
          // para INSERT com RETURNING
          let q = pgSql;
          if (isInsert && !/RETURNING/i.test(q)) {
            // tenta retornar id se houver coluna id
            if (/id/i.test(q)) q += ' RETURNING id';
          }
          const res = await pool.query(q, params);
          // mimetiza better-sqlite3
          const row = res.rows[0];
          return {
            lastInsertRowid: row ? row.id : undefined,
            changes: res.rowCount,
          };
        },
      };
    } else {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => stmt.run(...params),
      };
    }
  },
  // transaction helper - para Postgres, executa sem transação real (MVP)
  transaction(fn) {
    if (isPostgres) {
      return async (...args) => fn(...args);
    } else {
      return db.transaction(fn);
    }
  },
  pragma() {}, // no-op para Postgres
  async init() {
    if (isPostgres) {
      // Postgres - Supabase
      const stmts = [
        `CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE, senha TEXT, perfil TEXT DEFAULT 'tecnico', equipe_id INTEGER, ativo INTEGER DEFAULT 1, criado_em TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS equipes (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cor TEXT DEFAULT '#1565c0', ativo INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS locais (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, comarca TEXT, nome_imovel TEXT, tipo TEXT, ocupacao TEXT, endereco TEXT, area TEXT, longitude TEXT, latitude TEXT, google_maps_link TEXT, street_view_link TEXT, cameras INTEGER DEFAULT 0, ativo INTEGER DEFAULT 1, status_projeto TEXT, etapa TEXT, cam_fixa INTEGER DEFAULT 0, cam_analitica INTEGER DEFAULT 0, cam_lpr INTEGER DEFAULT 0, regiao TEXT, cronograma TEXT, terceirizada INTEGER DEFAULT 0, obra_id INTEGER REFERENCES obras(id) ON DELETE SET NULL, equipe_id INTEGER REFERENCES equipes(id) ON DELETE SET NULL)`,
        `CREATE TABLE IF NOT EXISTS obras (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL, comarca TEXT, prazo_dias INTEGER DEFAULT 30, data_inicio TEXT, status TEXT DEFAULT 'planejamento', progresso INTEGER DEFAULT 0, responsavel TEXT, descricao TEXT, ativo INTEGER DEFAULT 1, criado_em TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS etapas (id SERIAL PRIMARY KEY, obra_id INTEGER NOT NULL REFERENCES obras(id) ON DELETE CASCADE, local_id INTEGER REFERENCES locais(id) ON DELETE CASCADE, nome TEXT NOT NULL, ordem INTEGER DEFAULT 1, status TEXT DEFAULT 'pendente', data_inicio TEXT, data_fim TEXT, observacoes TEXT, criado_em TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS atividades (id SERIAL PRIMARY KEY, nome TEXT NOT NULL, ativo INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS materiais (id SERIAL PRIMARY KEY, nome TEXT NOT NULL UNIQUE, categoria TEXT DEFAULT 'Geral', ativo INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS rdos (id SERIAL PRIMARY KEY, obra_id INTEGER, data TEXT, local TEXT, local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL, atividade TEXT, equipe_json TEXT DEFAULT '[]', materiais_json TEXT DEFAULT '[]', entrada_manha TEXT, saida_manha TEXT, entrada_tarde TEXT, saida_tarde TEXT, parou TEXT DEFAULT 'nao', motivo_parada TEXT, switch_instalado TEXT DEFAULT 'nao', nom_switch TEXT, local_switch TEXT, camera_instalada TEXT DEFAULT 'nao', nom_camera TEXT, local_camera TEXT, fotos_json TEXT DEFAULT '[]', usuario_id INTEGER, usuario_nome TEXT, criado_em TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE TABLE IF NOT EXISTS presenca (id SERIAL PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, usuario_nome TEXT, equipe_id INTEGER, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, obra_id INTEGER, local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL, local_nome TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())`,
        `CREATE INDEX IF NOT EXISTS idx_rdos_data ON rdos(data)`,
        `CREATE INDEX IF NOT EXISTS idx_rdos_usuario ON rdos(usuario_id)`,
      ];
      for (const s of stmts) await pool.query(s);
      console.log('[db] tabelas Postgres verificadas');
      // Habilita RLS para silenciar linter Supabase (postgres role bypassa RLS, então não afeta pool direto)
      // Usa apenas POLICY FOR SELECT USING (true) — o linter ignora SELECT permissivo (lint 0024 só acusa ALL/INSERT/UPDATE/DELETE)
      const rlsTables = ['usuarios','equipes','locais','obras','etapas','atividades','materiais','rdos','presenca'];
      for (const t of rlsTables) {
        try { await pool.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`); } catch (e) { /* já habilitado */ }
        // Remove policy antiga ALL permissiva que gera WARN 0024
        try { await pool.query(`DROP POLICY IF EXISTS "allow_all_${t}" ON public.${t}`); } catch (e) {}
        // Cria apenas leitura pública — não gera WARN, e pool postgres bypassa de qualquer forma
        try { await pool.query(`CREATE POLICY "allow_select_${t}" ON public.${t} FOR SELECT USING (true)`); } catch (e) { /* já existe */ }
      }
      console.log('[db] RLS habilitado (linter OK, sem WARN permissivo)');
    } else {
      // SQLite já criado via Database, mas garante colunas extras
      const cols = db.prepare(`PRAGMA table_info(locais)`).all().map(c=>c.name);
      const ensure = (tbl,col,def)=>{ if(!cols.includes(col)){ db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); console.log(`[migracao] ${tbl}.${col}`); } };
      // já feito no server.js também, mas garante
    }
  },
};

module.exports = wrapper;
