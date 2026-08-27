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
    criado_em TEXT DEFAULT (datetime('now'))
  )`,
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
    UNIQUE(obra_id, material_nome)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_obra_materiais_obra ON obra_materiais(obra_id)`
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
    try { await db.exec('ALTER TABLE presenca ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE SET NULL'); console.log('[migracao] presenca.local_id Postgres'); } catch(e){}
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
    await ensureColumn('presenca', 'local_id', 'INTEGER REFERENCES locais(id) ON DELETE SET NULL');
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_obra ON locais(obra_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_locais_equipe ON locais(equipe_id)'); } catch(e){}
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_rdos_local_id ON rdos(local_id)'); } catch(e){}
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
    return JSON.parse(Buffer.from(d, 'base64').toString());
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
  const equipes = await db.prepare('SELECT * FROM equipes WHERE ativo=1 ORDER BY nome').all();
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
  res.json(await db.prepare('SELECT id,nome,cor FROM equipes WHERE ativo=1 ORDER BY nome').all());
});

app.post('/api/equipes', gestor, async (req, res) => {
  const { nome, cor, membros } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  const nomeTrim = nome.trim();
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
  const existe = await db.prepare('SELECT id FROM equipes WHERE id=? AND ativo=1').get(id);
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
  const eq = await db.prepare('SELECT id FROM equipes WHERE id=? AND ativo=1').get(id);
  if (!eq) return res.status(404).json({ error: 'Equipe nao encontrada' });
  await db.prepare('UPDATE usuarios SET equipe_id=NULL WHERE equipe_id=?').run(id);
  await db.prepare('UPDATE equipes SET ativo=0 WHERE id=?').run(id);
  res.json({ ok: true });
});

// ============================================================
// OBRAS
// ============================================================
app.get('/api/obras', async (req, res) => {
  let sql = `SELECT o.*, l.nome as local_nome, l.comarca as local_comarca, l.endereco as local_endereco, l.cameras as local_cameras
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
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/obras/:id', gestor, async (req, res) => {
  const { nome, local_id, comarca, prazo_dias, data_inicio, status, responsavel, descricao } = req.body;
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
  res.json(await db.prepare('SELECT * FROM etapas WHERE obra_id=? ORDER BY ordem').all(req.params.obra_id));
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
  const r = await db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'concluida\' THEN 1 ELSE 0 END) as ok FROM etapas WHERE obra_id=?').get(obraId);
  const pct = r.total > 0 ? Math.round((r.ok / r.total) * 100) : 0;
  await db.prepare('UPDATE obras SET progresso=? WHERE id=?').run(pct, obraId);
}

// ============================================================
// LOCAIS
// ============================================================
app.get('/api/locais', async (req, res) => {
  let sql = 'SELECT * FROM locais WHERE ativo=1';
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
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
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
  const { nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras, obra_id, equipe_id, regiao } = req.body;
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
  await db.prepare('UPDATE locais SET nome=?,comarca=?,nome_imovel=?,tipo=?,ocupacao=?,endereco=?,area=?,longitude=?,latitude=?,google_maps_link=?,street_view_link=?,cameras=?,obra_id=?,equipe_id=?,regiao=? WHERE id=?')
    .run(novoNome, novoComarca, novoNomeImovel, novoTipo, novoOcupacao, novoEndereco, novoArea, novoLon, novoLat, novoGmaps, novoStreet, novoCams, novoObraId, novoEquipeId, novoRegiao, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/locais/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE locais SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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
  const { nome, categoria } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO materiais (nome,categoria) VALUES (?,?)').run(nome, categoria || 'Geral');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.delete('/api/materiais/:id', gestor, async (req, res) => {
  await db.prepare('UPDATE materiais SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// ESTOQUE POR OBRA - Estimativa vs Consumo (Materiais.xlsx)
// ============================================================
// Lista estimativas de uma obra
app.get('/api/obras/:obra_id/materiais/estimativas', async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const rows = await db.prepare('SELECT * FROM obra_materiais WHERE obra_id=? ORDER BY material_nome').all(obraId);
  res.json(rows);
});
// Cria/atualiza uma estimativa (upsert por material_nome)
app.post('/api/obras/:obra_id/materiais/estimativas', gestor, async (req, res) => {
  const obraId = Number(req.params.obra_id);
  const { material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao } = req.body;
  if (!material_nome || !material_nome.trim()) return res.status(400).json({error:'material_nome obrigatório'});
  const nome = material_nome.trim();
  const qtd = Number(quantidade_estimada)||0;
  if (qtd <0) return res.status(400).json({error:'Quantidade inválida'});
  // upsert: tenta insert, se conflito atualiza
  const existe = await db.prepare('SELECT id FROM obra_materiais WHERE obra_id=? AND UPPER(material_nome)=UPPER(?)').get(obraId, nome);
  if (existe) {
    await db.prepare('UPDATE obra_materiais SET unidade=?, quantidade_estimada=?, valor_unitario=?, fornecedor=?, etapa=?, observacao=? WHERE id=?')
      .run(unidade||'UND', qtd, Number(valor_unitario)||0, fornecedor||'', etapa||'ETAPA 1', observacao||'', existe.id);
    return res.json({ok:true, id: existe.id, atualizado:true});
  } else {
    const r = await db.prepare('INSERT INTO obra_materiais (obra_id, material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao) VALUES (?,?,?,?,?,?,?,?)')
      .run(obraId, nome, unidade||'UND', qtd, Number(valor_unitario)||0, fornecedor||'', etapa||'ETAPA 1', observacao||'');
    // garante que material existe no catálogo
    try { await db.prepare('INSERT OR IGNORE INTO materiais (nome,categoria) VALUES (?,?)').run(nome, 'Geral'); } catch(e){}
    return res.json({ok:true, id: r.lastInsertRowid});
  }
});
app.put('/api/obra-materiais/:id', gestor, async (req, res) => {
  const id = Number(req.params.id);
  const { material_nome, unidade, quantidade_estimada, valor_unitario, fornecedor, etapa, observacao } = req.body;
  const atual = await db.prepare('SELECT * FROM obra_materiais WHERE id=?').get(id);
  if(!atual) return res.status(404).json({error:'Estimativa não encontrada'});
  await db.prepare('UPDATE obra_materiais SET material_nome=?, unidade=?, quantidade_estimada=?, valor_unitario=?, fornecedor=?, etapa=?, observacao=? WHERE id=?')
    .run(material_nome||atual.material_nome, unidade||atual.unidade, quantidade_estimada!=null? Number(quantidade_estimada):atual.quantidade_estimada, valor_unitario!=null? Number(valor_unitario):atual.valor_unitario, fornecedor!=null? fornecedor:atual.fornecedor, etapa||atual.etapa, observacao!=null? observacao:atual.observacao, id);
  res.json({ok:true});
});
app.delete('/api/obra-materiais/:id', gestor, async (req, res) => {
  await db.prepare('DELETE FROM obra_materiais WHERE id=?').run(Number(req.params.id));
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
    const existe = await db.prepare('SELECT id FROM obra_materiais WHERE obra_id=? AND UPPER(material_nome)=UPPER(?)').get(obraId, nome);
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
  const rdos = await db.prepare('SELECT id, local, local_id, materiais_json, equipe_json, usuario_id, data FROM rdos WHERE obra_id=?').all(obraId);
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
  // monta resposta por material estimado
  const itens = estimativas.map(e=>{
    const norm = mapNorm(e.material_nome);
    const cons = consumoPorMat[norm];
    const consumido = cons? cons.total : 0;
    const estimado = Number(e.quantidade_estimada)||0;
    const saldo = estimado - consumido;
    const pct = estimado>0? Math.round(consumido/estimado*100) : (consumido>0?100:0);
    const valorEstimado = estimado * (Number(e.valor_unitario)||0);
    const valorConsumido = consumido * (Number(e.valor_unitario)||0);
    const valorSaldo = saldo * (Number(e.valor_unitario)||0);
    // forecast: média por local concluído
    const mediaPorLocal = locaisConcluidos>0? consumido/locaisConcluidos : (totalLocais>0? estimado/totalLocais : 0);
    const projecaoRestante = mediaPorLocal * locaisPendentes;
    const necessidade = Math.max(0, projecaoRestante - Math.max(0,saldo));
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
      estimado, consumido, saldo, pct, valorEstimado, valorConsumido, valorSaldo,
      rdos: cons? cons.rdos:0, porEquipe: cons? cons.porEquipe:{}, porLocal: cons? cons.porLocal:{},
      mediaPorLocal: Math.round(mediaPorLocal*100)/100, projecaoRestante: Math.round(projecaoRestante*100)/100,
      necessidade: Math.round(necessidade*100)/100, status, precisaComprar, sugestaoCompra
    };
  });
  // materiais consumidos sem estimativa (extra)
  const estimNorms = new Set(estimativas.map(e=> mapNorm(e.material_nome)));
  const extras = Object.entries(consumoPorMat).filter(([k])=> !estimNorms.has(k)).map(([norm, v])=>{
    return { material_nome: v.nome, unidade:'UND', estimado:0, consumido: v.total, saldo: -v.total, pct:100, valorEstimado:0, valorConsumido:0, valorSaldo:0, rdos:v.rdos, porEquipe:v.porEquipe, porLocal:v.porLocal, status:'extra', precisaComprar:true, sugestaoCompra:0 };
  });
  const todosItens = [...itens, ...extras].sort((a,b)=> (b.pct - a.pct) || (b.consumido - a.consumido));
  const alertas = todosItens.filter(i=> i.precisaComprar);
  const resumo={
    obra_id:obraId, totalLocais, locaisConcluidos, locaisPendentes,
    totalMateriais: estimativas.length,
    totalEstimadoQtd: estimativas.reduce((s,e)=>s+Number(e.quantidade_estimada||0),0),
    totalConsumidoQtd: Object.values(consumoPorMat).reduce((s,v)=>s+v.total,0),
    totalValorEstimado: itens.reduce((s,i)=>s+i.valorEstimado,0),
    totalValorConsumido: itens.reduce((s,i)=>s+i.valorConsumido,0),
    totalValorSaldo: itens.reduce((s,i)=>s+i.valorSaldo,0),
    pctMedio: itens.length? Math.round(itens.reduce((s,i)=>s+i.pct,0)/itens.length):0,
    alertas: alertas.length,
    rdosTotal: rdos.length
  };
  // ranking equipes e locais
  const rankingEquipes = Object.entries(consumoPorEquipe).map(([nome,total])=>({nome, total})).sort((a,b)=>b.total-a.total).slice(0,10);
  const rankingLocais = Object.entries(consumoPorLocal).map(([nome,total])=>({nome, total})).sort((a,b)=>b.total-a.total).slice(0,10);
  res.json({resumo, itens: todosItens, alertas, rankingEquipes, rankingLocais});
});

// ============================================================
// RDOs
// ============================================================
app.get('/api/rdos', async (req, res) => {
  let sql = `SELECT r.*, o.nome as obra_nome, o.responsavel as obra_responsavel, o.status as obra_status,
    l.comarca as cidade, l.latitude as local_lat, l.longitude as local_lng, l.endereco as local_endereco
    FROM rdos r 
    LEFT JOIN obras o ON r.obra_id=o.id 
    LEFT JOIN locais l ON (r.local_id=l.id OR (r.local_id IS NULL AND (r.local = l.nome OR UPPER(l.nome) LIKE '%' || UPPER(r.local) || '%' OR UPPER(l.comarca) LIKE '%' || UPPER(r.local) || '%'))) AND l.ativo=1
    WHERE 1=1`;
  const p = [];
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
  res.json(rdo);
});

app.post('/api/rdos', async (req, res) => {
  const d = req.body;
  if (!d.data || (!d.local && !d.local_id)) return res.status(400).json({ error: 'Data e local obrigatorios' });
  // F1: resolve obra_id/local_id de forma inteligente para multi-obra
  let obraId = d.obra_id ? Number(d.obra_id) : null;
  let localId = d.local_id ? Number(d.local_id) : null;
  // Se veio só nome do local, tenta resolver local_id e obra_id
  if (!localId && d.local) {
    const loc = await db.prepare('SELECT id, obra_id FROM locais WHERE nome=? AND ativo=1').get(d.local);
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
      }
    }
  } catch(e){ console.error('[etapa-auto]', e.message); }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/rdos/:id', async (req, res) => {
  const d = req.body;
  let localId = d.local_id ? Number(d.local_id) : null;
  if (!localId && d.local) {
    const loc = await db.prepare('SELECT id FROM locais WHERE nome=? AND ativo=1').get(d.local);
    if (loc) localId = loc.id;
  }
  let obraId = d.obra_id ? Number(d.obra_id) : null;
  if (!obraId && localId) {
    const loc = await db.prepare('SELECT obra_id FROM locais WHERE id=?').get(localId);
    if (loc) obraId = loc.obra_id;
  }
  // se veio obra_id/local_id, atualiza, senão mantém os antigos
  const atual = await db.prepare('SELECT obra_id, local_id FROM rdos WHERE id=?').get(req.params.id);
  if (!obraId) obraId = atual ? atual.obra_id : null;
  if (!localId) localId = atual ? atual.local_id : null;
  await db.prepare(`UPDATE rdos SET obra_id=?,local_id=?,data=?,local=?,atividade=?,equipe_json=?,materiais_json=?,
    entrada_manha=?,saida_manha=?,entrada_tarde=?,saida_tarde=?,
    parou=?,motivo_parada=?,switch_instalado=?,nom_switch=?,local_switch=?,
    camera_instalada=?,nom_camera=?,local_camera=?,fotos_json=? WHERE id=?`).run(
    obraId, localId, d.data, d.local, d.atividade || '',
    JSON.stringify(d.equipe || []), JSON.stringify(d.materiais || []),
    d.entrada_manha, d.saida_manha, d.entrada_tarde, d.saida_tarde,
    d.parou || 'nao', d.motivo_parada || '',
    d.switch_instalado || 'nao', d.nom_switch || '', d.local_switch || '',
    d.camera_instalada || 'nao', d.nom_camera || '', d.local_camera || '',
    JSON.stringify(d.fotos || []),
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/rdos/:id', async (req, res) => {
  const rdo = await db.prepare('SELECT usuario_id FROM rdos WHERE id=?').get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  if (req.user.perfil !== 'gestor' && rdo.usuario_id !== req.user.id) {
    return res.status(403).json({ error: 'So o dono do RDO pode excluir' });
  }
  await db.prepare('DELETE FROM rdos WHERE id=?').run(req.params.id);
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
  const totalRdos = Number((await db.prepare('SELECT COUNT(*) as c FROM rdos').get()).c)||0;
  const rdosHoje = Number((await db.prepare("SELECT COUNT(*) as c FROM rdos WHERE data=date('now')").get()).c)||0;
  const totalUsuarios = Number((await db.prepare('SELECT COUNT(*) as c FROM usuarios WHERE ativo=1').get()).c)||0;
  const totalEquipes = Number((await db.prepare('SELECT COUNT(*) as c FROM equipes WHERE ativo=1').get()).c)||0;
  const recentes = await db.prepare('SELECT id,data,local,atividade,usuario_nome FROM rdos ORDER BY criado_em DESC LIMIT 10').all();
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
  const equipes = await db.prepare('SELECT id,nome,cor FROM equipes WHERE ativo=1').all();
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
