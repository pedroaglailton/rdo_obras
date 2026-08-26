const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
    ativo INTEGER DEFAULT 1
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
    local_nome TEXT,
    atualizado_em TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )`
];
// DB init - hibrido SQLite / Postgres (Supabase)
async function initDb(){
  if (db.isPostgres) {
    await db.init();
    // Garante coluna local_id em etapas para progresso per-local (TJ-CE) - Postgres
    try { await db.exec('ALTER TABLE etapas ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id) ON DELETE CASCADE'); console.log('[migracao] etapas.local_id Postgres'); } catch(e){}
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
    // Modo obra única TJ-CE: retorna TODOS os locais (sem filtro por comarca) — economiza cadastro 1 a 1
    const obra = await db.prepare('SELECT comarca, nome FROM obras WHERE id=?').get(req.query.obra_id);
    const isGlobal = obra && obra.nome && obra.nome.trim().toUpperCase().replace(/[-\s]/g,'') === 'TJCE';
    if (isGlobal) {
      // não filtra por comarca — TJ-CE engloba todas as comarcas
    } else if (obra && obra.comarca) { sql += ' AND UPPER(comarca)=UPPER(?)'; p.push(obra.comarca); }
    else { sql += ' AND 1=0'; } // obra sem comarca e não-global retorna vazio (legado)
  }
  if (req.query.comarca) { sql += ' AND UPPER(comarca)=UPPER(?)'; p.push(req.query.comarca); }
  if (req.query.regiao) { sql += ' AND regiao=?'; p.push(req.query.regiao); }
  if (req.query.busca) { sql += ' AND (nome LIKE ? OR comarca LIKE ? OR endereco LIKE ?)'; p.push('%' + req.query.busca + '%', '%' + req.query.busca + '%', '%' + req.query.busca + '%'); }
  res.json(await db.prepare(sql + ' ORDER BY comarca, nome').all(...p));
});

app.get('/api/locais/comarcas', async (req, res) => {
  res.json((await db.prepare('SELECT DISTINCT comarca FROM locais WHERE ativo=1 AND comarca IS NOT NULL ORDER BY comarca').all()).map(r => r.comarca));
});

// Locais da equipe com progresso dinâmico per-local via RDO/etapas — modo TJ-CE global
app.get('/api/equipe/:regiao/locais', async (req, res) => {
  const reg = req.params.regiao;
  const tjce = await db.prepare("SELECT id, nome, progresso, status, prazo_dias, data_inicio FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
  // progresso dinâmico: template vs etapas per-local concluídas
  const totalTpl = tjce ? (await db.prepare('SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0)').get(tjce.id)).c : 0;
  async function enrich(rows){
    for (const r of rows){
      // fallback global para obra
      if (!r.obra_id && tjce) { r.obra_id = tjce.id; r.obra_nome = tjce.nome; r.obra_status = tjce.status; r.prazo_dias = tjce.prazo_dias; r.data_inicio = tjce.data_inicio; }
      if (tjce && totalTpl>0) {
        const concl = (await db.prepare("SELECT COUNT(*) as c FROM etapas WHERE obra_id=? AND local_id=? AND status='concluida'").get(tjce.id, r.id)).c;
        r.obra_progresso = Math.round(concl/totalTpl*100);
        r.etapas_concluidas = concl; r.etapas_total = totalTpl;
      } else if (tjce) {
        // sem template, usa 1 etapa por RDO como progresso (0/100)
        const hasRdo = (await db.prepare('SELECT COUNT(*) as c FROM rdos WHERE local=?').get(r.nome)).c;
        r.obra_progresso = hasRdo>0 ? 100 : 0;
      }
    }
    // ordena por progresso (menos concluído primeiro) para priorizar frentes atrasadas
    rows.sort((a,b)=>(a.obra_progresso||0)-(b.obra_progresso||0));
    return rows;
  }
  const rows = await db.prepare(`
    SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status, o.prazo_dias, o.data_inicio
    FROM locais l LEFT JOIN obras o ON o.local_id = l.id AND o.ativo=1
    WHERE l.ativo=1 AND l.regiao = ?
    ORDER BY l.comarca
  `).all(reg);
  if (reg==='SEM EQUIPE') {
    const sem = await db.prepare(`
      SELECT l.*, o.id as obra_id, o.nome as obra_nome, o.progresso as obra_progresso, o.status as obra_status FROM locais l LEFT JOIN obras o ON o.local_id=l.id AND o.ativo=1
      WHERE l.ativo=1 AND (l.regiao IS NULL OR l.regiao='')
      ORDER BY l.comarca LIMIT 100
    `).all();
    return res.json(await enrich(sem));
  }
  res.json(await enrich(rows));
});

// Atribuir locais a equipe (dashboard define onde cada equipe vai trabalhar)
app.post('/api/locais/atribuir-equipe', gestor, async (req, res) => {
  const { ids, regiao } = req.body;
  if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({error:'Selecione ao menos 1 local'});
  // regiao pode ser '' para desatribuir
  const regNorm = (regiao||'').toString().trim();
  if (regNorm && !await db.prepare('SELECT id FROM equipes WHERE nome=? AND ativo=1').get(regNorm) && regNorm!=='SEM EQUIPE') {
    return res.status(400).json({error:'Equipe não encontrada. Crie em Equipes primeiro.'});
  }
  for (const id of ids) {
    await db.prepare('UPDATE locais SET regiao=? WHERE id=?').run(regNorm==='SEM EQUIPE'?'':regNorm, Number(id));
  }
  // Modo TJ-CE global: NÃO cria obra por local (economiza 233 cadastros). Todos os locais já pertencem à TJ-CE implícita.
  const tjceGlobal = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
  if (!tjceGlobal) {
    // fallback legado: se não há TJ-CE, mantém comportamento antigo (1 obra por local)
    for (const id of ids) {
      const loc = await db.prepare('SELECT id, nome, comarca, endereco FROM locais WHERE id=?').get(Number(id));
      if(!loc) continue;
      const obraExiste = await db.prepare('SELECT id FROM obras WHERE local_id=? AND ativo=1').get(loc.id);
      if(!obraExiste && regNorm){
        await db.prepare('INSERT INTO obras (nome, local_id, comarca, status, progresso) VALUES (?,?,?, ?,0)').run(loc.nome, loc.id, loc.comarca||'', 'planejamento');
      }
    }
  }
  res.json({ok:true, atualizados: ids.length, modo_global: !!tjceGlobal});
});

app.get('/api/locais/:id', async (req, res) => {
  const l = await db.prepare('SELECT * FROM locais WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Local nao encontrado' });
  res.json(l);
});

app.post('/api/locais', gestor, async (req, res) => {
  const { nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatorio' });
  const r = await db.prepare('INSERT INTO locais (nome,comarca,nome_imovel,tipo,ocupacao,endereco,area,longitude,latitude,google_maps_link,street_view_link,cameras) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(nome, comarca || '', nome_imovel || '', tipo || '', ocupacao || '', endereco || '', area || '', longitude || '', latitude || '', google_maps_link || '', street_view_link || '', cameras || 0);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/locais/:id', gestor, async (req, res) => {
  const { nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras } = req.body;
  await db.prepare('UPDATE locais SET nome=?,comarca=?,nome_imovel=?,tipo=?,ocupacao=?,endereco=?,area=?,longitude=?,latitude=?,google_maps_link=?,street_view_link=?,cameras=? WHERE id=?')
    .run(nome, comarca, nome_imovel, tipo, ocupacao, endereco, area, longitude, latitude, google_maps_link, street_view_link, cameras, req.params.id);
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
// RDOs
// ============================================================
app.get('/api/rdos', async (req, res) => {
  let sql = `SELECT r.*, o.nome as obra_nome, o.responsavel as obra_responsavel, o.status as obra_status,
    l.comarca as cidade, l.latitude as local_lat, l.longitude as local_lng, l.endereco as local_endereco
    FROM rdos r 
    LEFT JOIN obras o ON r.obra_id=o.id 
    LEFT JOIN locais l ON (r.local = l.nome OR UPPER(l.nome) LIKE '%' || UPPER(r.local) || '%' OR UPPER(l.comarca) LIKE '%' || UPPER(r.local) || '%') AND l.ativo=1
    WHERE 1=1`;
  const p = [];
  if (req.query.obra_id) { sql += ' AND r.obra_id=?'; p.push(req.query.obra_id); }
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
    LEFT JOIN locais l ON (r.local = l.nome OR UPPER(l.nome) LIKE '%' || UPPER(r.local) || '%' OR UPPER(l.comarca) LIKE '%' || UPPER(r.local) || '%') AND l.ativo=1
    WHERE r.id=?`).get(req.params.id);
  if (!rdo) return res.status(404).json({ error: 'RDO nao encontrado' });
  res.json(rdo);
});

app.post('/api/rdos', async (req, res) => {
  const d = req.body;
  if (!d.data || !d.local) return res.status(400).json({ error: 'Data e local obrigatorios' });
  // Modo TJ-CE global: se não informou obra, vincula automaticamente à TJ-CE (economiza seleção)
  let obraId = d.obra_id || null;
  if (!obraId) {
    const tjce = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
    if (tjce) obraId = tjce.id;
  }
  const r = await db.prepare(`INSERT INTO rdos (obra_id,data,local,atividade,equipe_json,materiais_json,
    entrada_manha,saida_manha,entrada_tarde,saida_tarde,
    parou,motivo_parada,switch_instalado,nom_switch,local_switch,
    camera_instalada,nom_camera,local_camera,fotos_json,usuario_id,usuario_nome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    obraId, d.data, d.local, d.atividade || '',
    JSON.stringify(d.equipe || []), JSON.stringify(d.materiais || []),
    d.entrada_manha, d.saida_manha, d.entrada_tarde, d.saida_tarde,
    d.parou || 'nao', d.motivo_parada || '',
    d.switch_instalado || 'nao', d.nom_switch || '', d.local_switch || '',
    d.camera_instalada || 'nao', d.nom_camera || '', d.local_camera || '',
    JSON.stringify(d.fotos || []),
    req.user ? req.user.id : null, req.user ? req.user.nome : 'Anonimo'
  );
  // Inteligente: auto-etapa per-local — cada RDO com atividade marca a etapa correspondente como concluída
  try {
    const localRow = await db.prepare('SELECT id FROM locais WHERE nome=? AND ativo=1').get(d.local);
    const ativ = (d.atividade||'').toString().trim();
    if (localRow && ativ) {
      const tjce2 = await db.prepare("SELECT id FROM obras WHERE UPPER(REPLACE(REPLACE(nome,'-',''),' ',''))=UPPER(?) AND ativo=1").get('TJCE');
      if (tjce2) {
        const tmpl = await db.prepare("SELECT ordem FROM etapas WHERE obra_id=? AND (local_id IS NULL OR local_id=0) AND UPPER(nome)=UPPER(?)").get(tjce2.id, ativ);
        const ordem = tmpl ? tmpl.ordem : 999;
        const existe = await db.prepare("SELECT id FROM etapas WHERE obra_id=? AND local_id=? AND UPPER(nome)=UPPER(?)").get(tjce2.id, localRow.id, ativ);
        if (!existe) {
          await db.prepare("INSERT INTO etapas (obra_id, local_id, nome, ordem, status) VALUES (?,?,?,?,?)").run(tjce2.id, localRow.id, ativ, ordem, 'concluida');
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
  await db.prepare(`UPDATE rdos SET data=?,local=?,atividade=?,equipe_json=?,materiais_json=?,
    entrada_manha=?,saida_manha=?,entrada_tarde=?,saida_tarde=?,
    parou=?,motivo_parada=?,switch_instalado=?,nom_switch=?,local_switch=?,
    camera_instalada=?,nom_camera=?,local_camera=?,fotos_json=? WHERE id=?`).run(
    d.data, d.local, d.atividade || '',
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
  const totalObras = (await db.prepare('SELECT COUNT(*) as c FROM obras WHERE ativo=1').get()).c;
  const totalRdos = (await db.prepare('SELECT COUNT(*) as c FROM rdos').get()).c;
  const rdosHoje = (await db.prepare("SELECT COUNT(*) as c FROM rdos WHERE data=date('now')").get()).c;
  const totalUsuarios = (await db.prepare('SELECT COUNT(*) as c FROM usuarios WHERE ativo=1').get()).c;
  const totalEquipes = (await db.prepare('SELECT COUNT(*) as c FROM equipes WHERE ativo=1').get()).c;
  const recentes = await db.prepare('SELECT id,data,local,atividade,usuario_nome FROM rdos ORDER BY criado_em DESC LIMIT 10').all();
  res.json({ totalObras, totalRdos, rdosHoje, totalUsuarios, totalEquipes, recentes });
});

// Dashboard por equipe (REGIAO do mesclado + presenca/RDO)
app.get('/api/dashboard/por-equipe', gestor, async (req, res) => {
  // agregados por regiao vindo dos locais
  const porRegiao = await db.prepare(`SELECT regiao, COUNT(*) as total_locais, SUM(cameras) as total_cameras, SUM(cam_fixa) as fixa, SUM(cam_analitica) as analitica, SUM(cam_lpr) as lpr, SUM(CASE WHEN latitude IS NOT NULL AND latitude!='' THEN 1 ELSE 0 END) as com_coord FROM locais WHERE ativo=1 GROUP BY regiao`).all();
  // normalizar nulos
  porRegiao.forEach(r=>{ if(!r.regiao) r.regiao='SEM EQUIPE'; r.total_cameras=r.total_cameras||0; r.fixa=r.fixa||0; r.analitica=r.analitica||0; r.lpr=r.lpr||0; });
  // equipes cadastradas
  const equipes = await db.prepare('SELECT id,nome,cor FROM equipes WHERE ativo=1').all();
  // membros por equipe
  const membros = await db.prepare('SELECT equipe_id, COUNT(*) as c FROM usuarios WHERE ativo=1 AND equipe_id IS NOT NULL GROUP BY equipe_id').all();
  const membrosMap = Object.fromEntries(membros.map(m=>[String(m.equipe_id), m.c]));
  // RDOs por equipe (via usuario.equipe_id -> rdos.usuario_id)
  const rdosPorEquipe = await db.prepare(`SELECT u.equipe_id as equipe_id, COUNT(r.id) as total, SUM(CASE WHEN r.data=date('now') THEN 1 ELSE 0 END) as hoje FROM rdos r JOIN usuarios u ON r.usuario_id=u.id WHERE u.equipe_id IS NOT NULL GROUP BY u.equipe_id`).all();
  const rdoMap = Object.fromEntries(rdosPorEquipe.map(r=>[String(r.equipe_id), r]));
  // presenca ativa por equipe
  const presPorEquipe = await db.prepare('SELECT equipe_id, COUNT(*) as c FROM presenca WHERE equipe_id IS NOT NULL GROUP BY equipe_id').all();
  const presMap = Object.fromEntries(presPorEquipe.map(p=>[String(p.equipe_id), p.c]));

  // montar resposta unificada por regiao/equipe
  const chaves = new Set([...porRegiao.map(r=>r.regiao), ...equipes.map(e=>e.nome), 'SEM EQUIPE']);
  const resultado = [];
  for (const chave of chaves) {
    const reg = porRegiao.find(r=>r.regiao===chave);
    const eq = equipes.find(e=>e.nome===chave);
    const equipe_id = eq ? eq.id : null;
    const m = equipe_id ? (membrosMap[String(equipe_id)]||0) : 0;
    const rdo = equipe_id ? (rdoMap[String(equipe_id)]||{total:0,hoje:0}) : {total:0,hoje:0};
    const pres = equipe_id ? (presMap[String(equipe_id)]||0) : 0;
    resultado.push({
      regiao: chave,
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
