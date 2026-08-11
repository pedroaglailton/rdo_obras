// Servidor central do RDO de Campo — recebe sincronizações dos celulares
// dos técnicos e serve os dados para o dashboard do gestor.
//
// Uso:
//   npm install
//   node server.js
//
// Variáveis de ambiente (opcionais):
//   PORT             - porta HTTP (padrão 3000)
//   API_KEY          - chave técnica que o app de campo envia no header
//                       'x-api-key' pra sincronizar (se não definir, é
//                       gerada automaticamente na 1a execução e salva em
//                       api_key.txt)
//   DASHBOARD_USERS  - contas de login do dashboard, formato
//                       "Nome:senha,Nome2:senha2" (todas com a mesma
//                       permissão — ver, atualizar e exportar). Se não
//                       definir, duas contas padrão ("Engenheiro" e
//                       "Estagiario") são geradas automaticamente na 1a
//                       execução e salvas em dashboard_usuarios.json.
//   FISCAL_USERS     - contas de login do app de fiscalização, mesmo
//                       formato "Nome:senha,Nome2:senha2". Não têm acesso
//                       ao dashboard nem à sincronização dos técnicos — só
//                       ao app de fiscalização. Se não definir, uma conta
//                       padrão ("Fiscal") é gerada e salva em
//                       fiscal_usuarios.json.
//   DB_PATH          - caminho do arquivo do banco (padrão ./rdo_central.sqlite)

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rdo_central.sqlite');
const API_KEY_FILE = path.join(__dirname, 'api_key.txt');
const DASHBOARD_USERS_FILE = path.join(__dirname, 'dashboard_usuarios.json');
const FISCAL_USERS_FILE = path.join(__dirname, 'fiscal_usuarios.json');
const SESSAO_DURACAO_MS = 12 * 60 * 60 * 1000; // 12 horas

let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  if (fs.existsSync(API_KEY_FILE)) {
    API_KEY = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
  } else {
    API_KEY = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(API_KEY_FILE, API_KEY);
    console.log('>> Nova API_KEY gerada e salva em api_key.txt — configure essa mesma chave no app de campo.');
  }
}
console.log('>> API_KEY ativa (uso técnico, app de campo):', API_KEY);

// Contas do dashboard — separadas da API_KEY. Todo mundo aqui tem a mesma
// permissão (ver dados + exportar Excel); o nome de usuário é só pra saber
// quem é quem, não é um nível de acesso diferente. Pode ser fixado via
// variável de ambiente DASHBOARD_USERS ("Nome:senha,Nome2:senha2"); senão,
// duas contas padrão são geradas automaticamente na primeira execução.
let DASHBOARD_USERS = {}; // { "Engenheiro": "senha123", "Estagiario": "senha456" }
if (process.env.DASHBOARD_USERS) {
  process.env.DASHBOARD_USERS.split(',').forEach(par => {
    const [nome, senha] = par.split(':').map(s => (s || '').trim());
    if (nome && senha) DASHBOARD_USERS[nome] = senha;
  });
} else if (fs.existsSync(DASHBOARD_USERS_FILE)) {
  DASHBOARD_USERS = JSON.parse(fs.readFileSync(DASHBOARD_USERS_FILE, 'utf8'));
} else {
  DASHBOARD_USERS = {
    Engenheiro: crypto.randomBytes(4).toString('hex'),
    Estagiario: crypto.randomBytes(4).toString('hex'),
  };
  fs.writeFileSync(DASHBOARD_USERS_FILE, JSON.stringify(DASHBOARD_USERS, null, 2));
  console.log('>> Contas do dashboard geradas e salvas em dashboard_usuarios.json — informe usuário+senha pra cada pessoa (ou defina DASHBOARD_USERS no ambiente pra escolher as suas).');
}
console.log('>> Contas do dashboard ativas:', Object.keys(DASHBOARD_USERS).map(n => `${n}:${DASHBOARD_USERS[n]}`).join('  |  '));

// Contas do app de fiscalização — separadas das do dashboard e da API_KEY.
// Só dão acesso ao app de fiscalização (conferir o que foi declarado nos
// RDOs), não ao dashboard nem à sincronização dos técnicos.
let FISCAL_USERS = {};
if (process.env.FISCAL_USERS) {
  process.env.FISCAL_USERS.split(',').forEach(par => {
    const [nome, senha] = par.split(':').map(s => (s || '').trim());
    if (nome && senha) FISCAL_USERS[nome] = senha;
  });
} else if (fs.existsSync(FISCAL_USERS_FILE)) {
  FISCAL_USERS = JSON.parse(fs.readFileSync(FISCAL_USERS_FILE, 'utf8'));
} else {
  FISCAL_USERS = { Fiscal: crypto.randomBytes(4).toString('hex') };
  fs.writeFileSync(FISCAL_USERS_FILE, JSON.stringify(FISCAL_USERS, null, 2));
  console.log('>> Conta do fiscal gerada e salva em fiscal_usuarios.json — informe usuário+senha pro fiscal (ou defina FISCAL_USERS no ambiente pra escolher as suas).');
}
console.log('>> Contas do fiscal ativas:', Object.keys(FISCAL_USERS).map(n => `${n}:${FISCAL_USERS[n]}`).join('  |  '));

// Sessões do fiscal — separadas das do dashboard (roles diferentes).
const sessoesFiscal = new Map();
function criarSessaoFiscal(usuario) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoesFiscal.set(token, { usuario, expira: Date.now() + SESSAO_DURACAO_MS });
  return token;
}

// Sessões de dashboard em memória: token -> { usuario, expira }
const sessoesDashboard = new Map();
function criarSessao(usuario) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoesDashboard.set(token, { usuario, expira: Date.now() + SESSAO_DURACAO_MS });
  return token;
}
function limparSessoesExpiradas() {
  const agora = Date.now();
  for (const [token, s] of sessoesDashboard) {
    if (s.expira < agora) sessoesDashboard.delete(token);
  }
  for (const [token, s] of sessoesFiscal) {
    if (s.expira < agora) sessoesFiscal.delete(token);
  }
}
setInterval(limparSessoesExpiradas, 30 * 60000).unref();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS obras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT UNIQUE NOT NULL,
  locais TEXT DEFAULT '[]',
  criado_em TEXT
);
CREATE TABLE IF NOT EXISTS rdos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  tecnico TEXT,
  criado_em TEXT,
  data_servico TEXT,
  obra_nome TEXT,
  local TEXT,
  atividade TEXT,
  equipe TEXT,
  materiais_json TEXT,
  entrada_manha TEXT, saida_manha TEXT, entrada_tarde TEXT, saida_tarde TEXT,
  parou TEXT, motivo_parada TEXT,
  switch_instalado TEXT, switch_nomenclatura TEXT, switch_local TEXT,
  camera_instalada TEXT, camera_nomenclatura TEXT, camera_local TEXT,
  qtd_fotos INTEGER DEFAULT 0,
  lat REAL, lon REAL,
  recebido_em TEXT
);
CREATE TABLE IF NOT EXISTS heartbeats (
  tecnico TEXT PRIMARY KEY,
  obra_nome TEXT,
  local TEXT,
  atividade TEXT,
  lat REAL, lon REAL,
  atualizado_em TEXT
);
CREATE TABLE IF NOT EXISTS vistorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  rdo_uid TEXT NOT NULL,
  fiscal TEXT,
  data_vistoria TEXT,
  local_confere TEXT,
  switch_conferido TEXT, switch_ok TEXT,
  camera_conferida TEXT, camera_ok TEXT,
  observacoes TEXT,
  qtd_fotos INTEGER DEFAULT 0,
  status TEXT,
  lat REAL, lon REAL,
  recebido_em TEXT
);
CREATE TABLE IF NOT EXISTS obra_entregas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obra_nome TEXT NOT NULL,
  locais TEXT DEFAULT '[]',
  destinatario TEXT NOT NULL,
  entregue INTEGER DEFAULT 0,
  criado_em TEXT
);
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve o app de campo e o dashboard como páginas estáticas, direto dessa
// mesma URL — assim não precisa mandar o .html por WhatsApp pra cada técnico.
app.use('/app-campo', express.static(path.join(__dirname, '..', 'app-campo')));
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.use('/fiscalizacao', express.static(path.join(__dirname, '..', 'fiscalizacao')));
app.get('/', (req, res) => res.redirect('/app-campo/rdo-campo.html'));

function checkAuth(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ ok: false, erro: 'API key inválida' });
  next();
}

// Autenticação do dashboard: token de sessão obtido via /api/dashboard/login
// (não usa a API_KEY técnica — cada pessoa só digita usuário + senha).
function checkDashboardAuth(req, res, next) {
  const token = req.header('x-dashboard-token');
  const sessao = token && sessoesDashboard.get(token);
  if (!sessao) {
    return res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
  if (sessao.expira < Date.now()) {
    sessoesDashboard.delete(token);
    return res.status(401).json({ ok: false, erro: 'Sessão expirada. Faça login novamente.' });
  }
  // renova a sessão a cada uso
  sessao.expira = Date.now() + SESSAO_DURACAO_MS;
  req.dashboardUsuario = sessao.usuario;
  next();
}

// ---- Login do dashboard: troca usuário + senha por um token de sessão ----
app.post('/api/dashboard/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha || DASHBOARD_USERS[usuario] !== senha) {
    return res.status(401).json({ ok: false, erro: 'Usuário ou senha incorretos.' });
  }
  const token = criarSessao(usuario);
  res.json({ ok: true, token, usuario, expira_em: SESSAO_DURACAO_MS });
});

app.post('/api/dashboard/logout', checkDashboardAuth, (req, res) => {
  sessoesDashboard.delete(req.header('x-dashboard-token'));
  res.json({ ok: true });
});

// Autenticação do app de fiscalização — mesmo esquema do dashboard, mas
// completamente separada (contas diferentes, sessões diferentes).
function checkFiscalAuth(req, res, next) {
  const token = req.header('x-fiscal-token');
  const sessao = token && sessoesFiscal.get(token);
  if (!sessao) {
    return res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
  if (sessao.expira < Date.now()) {
    sessoesFiscal.delete(token);
    return res.status(401).json({ ok: false, erro: 'Sessão expirada. Faça login novamente.' });
  }
  sessao.expira = Date.now() + SESSAO_DURACAO_MS;
  req.fiscalUsuario = sessao.usuario;
  next();
}

app.post('/api/fiscal/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha || FISCAL_USERS[usuario] !== senha) {
    return res.status(401).json({ ok: false, erro: 'Usuário ou senha incorretos.' });
  }
  const token = criarSessaoFiscal(usuario);
  res.json({ ok: true, token, usuario, expira_em: SESSAO_DURACAO_MS });
});

app.post('/api/fiscal/logout', checkFiscalAuth, (req, res) => {
  sessoesFiscal.delete(req.header('x-fiscal-token'));
  res.json({ ok: true });
});

// ---- Sincronização vinda do app de campo ----
app.post('/api/sync', checkAuth, (req, res) => {
  const { tecnico, obras = [], rdos = [] } = req.body || {};
  if (!tecnico) return res.status(400).json({ ok: false, erro: 'Campo "tecnico" é obrigatório' });

  const upsertObra = db.prepare(`
    INSERT INTO obras (nome, locais, criado_em) VALUES (@nome, @locais, @criado_em)
    ON CONFLICT(nome) DO UPDATE SET locais = @locais
  `);
  const upsertRdo = db.prepare(`
    INSERT INTO rdos (uid, tecnico, criado_em, data_servico, obra_nome, local, atividade, equipe,
      materiais_json, entrada_manha, saida_manha, entrada_tarde, saida_tarde, parou, motivo_parada,
      switch_instalado, switch_nomenclatura, switch_local, camera_instalada, camera_nomenclatura,
      camera_local, qtd_fotos, lat, lon, recebido_em)
    VALUES (@uid, @tecnico, @criado_em, @data_servico, @obra_nome, @local, @atividade, @equipe,
      @materiais_json, @entrada_manha, @saida_manha, @entrada_tarde, @saida_tarde, @parou, @motivo_parada,
      @switch_instalado, @switch_nomenclatura, @switch_local, @camera_instalada, @camera_nomenclatura,
      @camera_local, @qtd_fotos, @lat, @lon, @recebido_em)
    ON CONFLICT(uid) DO UPDATE SET
      tecnico=@tecnico, data_servico=@data_servico, obra_nome=@obra_nome, local=@local, atividade=@atividade,
      equipe=@equipe, materiais_json=@materiais_json, entrada_manha=@entrada_manha, saida_manha=@saida_manha,
      entrada_tarde=@entrada_tarde, saida_tarde=@saida_tarde, parou=@parou, motivo_parada=@motivo_parada,
      switch_instalado=@switch_instalado, switch_nomenclatura=@switch_nomenclatura, switch_local=@switch_local,
      camera_instalada=@camera_instalada, camera_nomenclatura=@camera_nomenclatura, camera_local=@camera_local,
      qtd_fotos=@qtd_fotos, lat=@lat, lon=@lon, recebido_em=@recebido_em
  `);

  const tx = db.transaction((obras, rdos) => {
    obras.forEach(o => upsertObra.run({ nome: o.nome, locais: JSON.stringify(o.locais || []), criado_em: o.criado_em || new Date().toISOString() }));
    rdos.forEach(r => upsertRdo.run({
      uid: r.uid, tecnico, criado_em: r.criado_em, data_servico: r.data_servico,
      obra_nome: r.obra_nome, local: r.local, atividade: r.atividade,
      equipe: r.equipe || '[]', materiais_json: r.materiais_json || '[]',
      entrada_manha: r.entrada_manha, saida_manha: r.saida_manha,
      entrada_tarde: r.entrada_tarde, saida_tarde: r.saida_tarde,
      parou: r.parou, motivo_parada: r.motivo_parada || '',
      switch_instalado: r.switch_instalado, switch_nomenclatura: r.switch_nomenclatura || '', switch_local: r.switch_local || '',
      camera_instalada: r.camera_instalada, camera_nomenclatura: r.camera_nomenclatura || '', camera_local: r.camera_local || '',
      qtd_fotos: r.qtd_fotos || 0, lat: r.lat ?? null, lon: r.lon ?? null,
      recebido_em: new Date().toISOString()
    }));
  });
  tx(obras, rdos);

  // Entregas pendentes de obras criadas pelo dashboard
  const pendentes = db.prepare(
    'SELECT id, obra_nome, locais FROM obra_entregas WHERE destinatario = ? AND entregue = 0'
  ).all(tecnico);
  if (pendentes.length) {
    const mark = db.prepare('UPDATE obra_entregas SET entregue = 1 WHERE id = ?');
    const tx2 = db.transaction(() => { pendentes.forEach(p => mark.run(p.id)); });
    tx2();
  }

  res.json({ ok: true, obras_recebidas: obras.length, rdos_recebidas: rdos.length, obras_pendentes: pendentes });
});

// ---- "Estou aqui" — pulso de status enviado pelo app enquanto está online ----
app.post('/api/heartbeat', checkAuth, (req, res) => {
  const { tecnico, obra_nome, local, atividade, lat, lon } = req.body || {};
  if (!tecnico) return res.status(400).json({ ok: false, erro: 'Campo "tecnico" é obrigatório' });
  db.prepare(`
    INSERT INTO heartbeats (tecnico, obra_nome, local, atividade, lat, lon, atualizado_em)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tecnico) DO UPDATE SET obra_nome=?, local=?, atividade=?, lat=?, lon=?, atualizado_em=?
  `).run(
    tecnico, obra_nome || null, local || null, atividade || null, lat ?? null, lon ?? null, new Date().toISOString(),
    obra_nome || null, local || null, atividade || null, lat ?? null, lon ?? null, new Date().toISOString()
  );
  res.json({ ok: true });
});

// ---- Lista de RDOs pro fiscal escolher o que vistoriar ----
// Filtros opcionais: ?obra=Nome&local=Nome&pendentes=true (só sem vistoria)
app.get('/api/fiscal/rdos', checkFiscalAuth, (req, res) => {
  const { obra, local, pendentes } = req.query;
  let sql = `
    SELECT r.*,
      v.uid AS vistoria_uid, v.status AS vistoria_status, v.fiscal AS vistoria_fiscal,
      v.data_vistoria AS vistoria_data
    FROM rdos r
    LEFT JOIN vistorias v ON v.rdo_uid = r.uid
    WHERE 1=1
  `;
  const params = [];
  if (obra) { sql += ' AND r.obra_nome = ?'; params.push(obra); }
  if (local) { sql += ' AND r.local = ?'; params.push(local); }
  if (pendentes === 'true') { sql += ' AND v.uid IS NULL'; }
  sql += ' ORDER BY r.data_servico DESC, r.recebido_em DESC LIMIT 200';
  const rdos = db.prepare(sql).all(...params);
  res.json({ ok: true, rdos, obras: db.prepare('SELECT * FROM obras ORDER BY nome').all() });
});

// ---- Sincronização vinda do app de fiscalização ----
app.post('/api/fiscal/sync', checkFiscalAuth, (req, res) => {
  const { vistorias = [] } = req.body || {};
  const upsertVistoria = db.prepare(`
    INSERT INTO vistorias (uid, rdo_uid, fiscal, data_vistoria, local_confere,
      switch_conferido, switch_ok, camera_conferida, camera_ok, observacoes,
      qtd_fotos, status, lat, lon, recebido_em)
    VALUES (@uid, @rdo_uid, @fiscal, @data_vistoria, @local_confere,
      @switch_conferido, @switch_ok, @camera_conferida, @camera_ok, @observacoes,
      @qtd_fotos, @status, @lat, @lon, @recebido_em)
    ON CONFLICT(uid) DO UPDATE SET
      data_vistoria=@data_vistoria, local_confere=@local_confere,
      switch_conferido=@switch_conferido, switch_ok=@switch_ok,
      camera_conferida=@camera_conferida, camera_ok=@camera_ok,
      observacoes=@observacoes, qtd_fotos=@qtd_fotos, status=@status,
      lat=@lat, lon=@lon, recebido_em=@recebido_em
  `);
  const tx = db.transaction((vistorias) => {
    vistorias.forEach(v => upsertVistoria.run({
      uid: v.uid, rdo_uid: v.rdo_uid, fiscal: req.fiscalUsuario, data_vistoria: v.data_vistoria,
      local_confere: v.local_confere, switch_conferido: v.switch_conferido || '', switch_ok: v.switch_ok || '',
      camera_conferida: v.camera_conferida || '', camera_ok: v.camera_ok || '',
      observacoes: v.observacoes || '', qtd_fotos: v.qtd_fotos || 0, status: v.status,
      lat: v.lat ?? null, lon: v.lon ?? null, recebido_em: new Date().toISOString()
    }));
  });
  tx(vistorias);
  res.json({ ok: true, vistorias_recebidas: vistorias.length });
});


// ---- Cadastro de obras pelo dashboard (engenheiro) ----
app.post('/api/dashboard/obra', checkDashboardAuth, (req, res) => {
  const { nome, locais = [] } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ ok: false, erro: 'Nome da obra é obrigatório.' });
  const nomeTrim = nome.trim();

  try {
    db.prepare('INSERT INTO obras (nome, locais, criado_em) VALUES (?, ?, ?)').run(
      nomeTrim, JSON.stringify(locais), new Date().toISOString()
    );
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ ok: false, erro: 'Já existe uma obra com esse nome.' });
    }
    return res.status(500).json({ ok: false, erro: e.message });
  }

  const tecnicos = db.prepare('SELECT DISTINCT tecnico FROM heartbeats').all();
  const stmtEntrega = db.prepare(
    'INSERT OR IGNORE INTO obra_entregas (obra_nome, locais, destinatario, criado_em) VALUES (?, ?, ?, ?)'
  );
  const agora = new Date().toISOString();
  const tx = db.transaction(() => {
    tecnicos.forEach(t => {
      stmtEntrega.run(nomeTrim, JSON.stringify(locais), t.tecnico, agora);
    });
  });
  tx();

  res.json({ ok: true, obra: { nome: nomeTrim, locais, criado_em: agora } });
});

app.get('/api/dashboard/obras', checkDashboardAuth, (req, res) => {
  const obras = db.prepare('SELECT * FROM obras ORDER BY nome').all();
  res.json({ ok: true, obras });
});

app.delete('/api/dashboard/obra/:id', checkDashboardAuth, (req, res) => {
  const { id } = req.params;
  const obra = db.prepare('SELECT * FROM obras WHERE id = ?').get(id);
  if (!obra) return res.status(404).json({ ok: false, erro: 'Obra não encontrada.' });
  db.prepare('DELETE FROM obras WHERE id = ?').run(id);
  db.prepare('DELETE FROM obra_entregas WHERE obra_nome = ?').run(obra.nome);
  res.json({ ok: true });
});

app.get('/api/dashboard', checkDashboardAuth, (req, res) => {
  const heartbeats = db.prepare('SELECT * FROM heartbeats ORDER BY atualizado_em DESC').all();
  const rdosRecentes = db.prepare(`
    SELECT r.*, v.status AS vistoria_status, v.fiscal AS vistoria_fiscal, v.data_vistoria AS vistoria_data
    FROM rdos r LEFT JOIN vistorias v ON v.rdo_uid = r.uid
    ORDER BY r.recebido_em DESC LIMIT 100
  `).all();
  const totalRdos = db.prepare('SELECT COUNT(*) c FROM rdos').get().c;
  const totalObras = db.prepare('SELECT COUNT(*) c FROM obras').get().c;
  const hoje = new Date().toISOString().slice(0, 10);
  const atrasosHoje = db.prepare(`SELECT COUNT(*) c FROM rdos WHERE parou='sim' AND data_servico=?`).get(hoje).c;
  const rdosPorObra = db.prepare(`SELECT obra_nome, COUNT(*) c FROM rdos GROUP BY obra_nome ORDER BY c DESC`).all();
  const rdosHoje = db.prepare(`SELECT COUNT(*) c FROM rdos WHERE data_servico=?`).get(hoje).c;
  const totalVistorias = db.prepare('SELECT COUNT(*) c FROM vistorias').get().c;
  const vistoriasReprovadas = db.prepare(`SELECT COUNT(*) c FROM vistorias WHERE status='reprovado'`).get().c;
  const rdosPendentesVistoria = db.prepare(`
    SELECT COUNT(*) c FROM rdos r LEFT JOIN vistorias v ON v.rdo_uid = r.uid WHERE v.uid IS NULL
  `).get().c;

  // materiais mais usados (soma das quantidades, lendo o JSON de cada RDO)
  const contMateriais = {};
  db.prepare('SELECT materiais_json FROM rdos').all().forEach(r => {
    try {
      JSON.parse(r.materiais_json || '[]').forEach(m => {
        contMateriais[m.nome] = (contMateriais[m.nome] || 0) + Number(m.qtd || 0);
      });
    } catch (e) {}
  });
  const materiaisTop = Object.entries(contMateriais).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([nome, qtd]) => ({ nome, qtd }));

  res.json({
    ok: true,
    tecnicos: heartbeats,
    rdos_recentes: rdosRecentes,
    indicadores: { totalRdos, totalObras, atrasosHoje, rdosHoje, rdosPorObra, materiaisTop, totalVistorias, vistoriasReprovadas, rdosPendentesVistoria },
    obras: db.prepare('SELECT * FROM obras ORDER BY nome').all()
  });
});

// ---- Exportação de relatório em Excel (puxa de todos os técnicos) ----
// Filtros opcionais via querystring: ?obra=Nome&data_inicio=2026-01-01&data_fim=2026-01-31&tecnico=Nome
app.get('/api/export/excel', checkDashboardAuth, async (req, res) => {
  try {
    const { obra, data_inicio, data_fim, tecnico } = req.query;

    let sql = 'SELECT * FROM rdos WHERE 1=1';
    const params = [];
    if (obra) { sql += ' AND obra_nome = ?'; params.push(obra); }
    if (tecnico) { sql += ' AND tecnico = ?'; params.push(tecnico); }
    if (data_inicio) { sql += ' AND data_servico >= ?'; params.push(data_inicio); }
    if (data_fim) { sql += ' AND data_servico <= ?'; params.push(data_fim); }
    sql += ' ORDER BY data_servico DESC, recebido_em DESC';

    const rdos = db.prepare(sql).all(...params);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RDO de Campo · IPQ Tecnologia';
    wb.created = new Date();

    // --- Aba 1: RDOs (uma linha por relatório) ---
    const wsRdo = wb.addWorksheet('RDOs');
    wsRdo.columns = [
      { header: 'Data', key: 'data_servico', width: 12 },
      { header: 'Técnico', key: 'tecnico', width: 20 },
      { header: 'Obra', key: 'obra_nome', width: 22 },
      { header: 'Local', key: 'local', width: 20 },
      { header: 'Atividade', key: 'atividade', width: 28 },
      { header: 'Equipe', key: 'equipe', width: 24 },
      { header: 'Materiais usados', key: 'materiais', width: 34 },
      { header: 'Entrada manhã', key: 'entrada_manha', width: 13 },
      { header: 'Saída manhã', key: 'saida_manha', width: 13 },
      { header: 'Entrada tarde', key: 'entrada_tarde', width: 13 },
      { header: 'Saída tarde', key: 'saida_tarde', width: 13 },
      { header: 'Parou/atrasou', key: 'parou', width: 13 },
      { header: 'Motivo da parada', key: 'motivo_parada', width: 26 },
      { header: 'Switch instalado', key: 'switch_instalado', width: 15 },
      { header: 'Switch — nomenclatura', key: 'switch_nomenclatura', width: 20 },
      { header: 'Switch — local', key: 'switch_local', width: 18 },
      { header: 'Câmera instalada', key: 'camera_instalada', width: 15 },
      { header: 'Câmera — nomenclatura', key: 'camera_nomenclatura', width: 20 },
      { header: 'Câmera — local', key: 'camera_local', width: 18 },
      { header: 'Qtd. fotos', key: 'qtd_fotos', width: 10 },
      { header: 'Recebido em', key: 'recebido_em', width: 18 },
    ];
    wsRdo.getRow(1).font = { bold: true };
    wsRdo.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E7ED' } };
    wsRdo.autoFilter = { from: 'A1', to: 'U1' };

    // --- Aba 2: Materiais (uma linha por material usado, melhor pra somar/filtrar) ---
    const wsMat = wb.addWorksheet('Materiais utilizados');
    wsMat.columns = [
      { header: 'Data', key: 'data_servico', width: 12 },
      { header: 'Técnico', key: 'tecnico', width: 20 },
      { header: 'Obra', key: 'obra_nome', width: 22 },
      { header: 'Local', key: 'local', width: 20 },
      { header: 'Material', key: 'material', width: 30 },
      { header: 'Quantidade', key: 'qtd', width: 12 },
    ];
    wsMat.getRow(1).font = { bold: true };
    wsMat.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E7ED' } };

    // --- Aba 3: Vistorias (fiscalização vinculada a cada RDO) ---
    const wsVist = wb.addWorksheet('Vistorias');
    wsVist.columns = [
      { header: 'Data RDO', key: 'data_servico', width: 12 },
      { header: 'Técnico', key: 'tecnico', width: 20 },
      { header: 'Obra', key: 'obra_nome', width: 22 },
      { header: 'Local', key: 'local', width: 20 },
      { header: 'Status vistoria', key: 'status', width: 16 },
      { header: 'Fiscal', key: 'fiscal', width: 18 },
      { header: 'Data vistoria', key: 'data_vistoria', width: 14 },
      { header: 'Local confere', key: 'local_confere', width: 13 },
      { header: 'Switch conferido', key: 'switch_conferido', width: 15 },
      { header: 'Switch OK', key: 'switch_ok', width: 11 },
      { header: 'Câmera conferida', key: 'camera_conferida', width: 15 },
      { header: 'Câmera OK', key: 'camera_ok', width: 11 },
      { header: 'Observações', key: 'observacoes', width: 34 },
      { header: 'Qtd. fotos', key: 'qtd_fotos', width: 10 },
    ];
    wsVist.getRow(1).font = { bold: true };
    wsVist.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E7ED' } };
    const rotuloStatus = s => s === 'aprovado' ? 'Aprovado' : s === 'reprovado' ? 'Reprovado' : s === 'aprovado_com_ressalva' ? 'Aprovado c/ ressalva' : 'Não vistoriado';
    const rotuloSN = v => v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : '';

    const vistoriasPorRdo = db.prepare('SELECT * FROM vistorias').all()
      .reduce((acc, v) => { acc[v.rdo_uid] = v; return acc; }, {});

    rdos.forEach(r => {
      let equipeTxt = '';
      let materiaisArr = [];
      try { equipeTxt = JSON.parse(r.equipe || '[]').join(', '); } catch (e) { equipeTxt = r.equipe || ''; }
      try { materiaisArr = JSON.parse(r.materiais_json || '[]'); } catch (e) { materiaisArr = []; }
      const materiaisTxt = materiaisArr.map(m => `${m.nome} x${m.qtd}`).join('; ');

      wsRdo.addRow({
        data_servico: r.data_servico, tecnico: r.tecnico, obra_nome: r.obra_nome, local: r.local,
        atividade: r.atividade, equipe: equipeTxt, materiais: materiaisTxt,
        entrada_manha: r.entrada_manha, saida_manha: r.saida_manha,
        entrada_tarde: r.entrada_tarde, saida_tarde: r.saida_tarde,
        parou: r.parou === 'sim' ? 'Sim' : 'Não', motivo_parada: r.motivo_parada,
        switch_instalado: r.switch_instalado === 'sim' ? 'Sim' : 'Não',
        switch_nomenclatura: r.switch_nomenclatura, switch_local: r.switch_local,
        camera_instalada: r.camera_instalada === 'sim' ? 'Sim' : 'Não',
        camera_nomenclatura: r.camera_nomenclatura, camera_local: r.camera_local,
        qtd_fotos: r.qtd_fotos, recebido_em: r.recebido_em,
      });

      materiaisArr.forEach(m => {
        wsMat.addRow({
          data_servico: r.data_servico, tecnico: r.tecnico, obra_nome: r.obra_nome,
          local: r.local, material: m.nome, qtd: Number(m.qtd || 0),
        });
      });

      const v = vistoriasPorRdo[r.uid];
      wsVist.addRow({
        data_servico: r.data_servico, tecnico: r.tecnico, obra_nome: r.obra_nome, local: r.local,
        status: rotuloStatus(v && v.status), fiscal: v ? v.fiscal : '',
        data_vistoria: v ? v.data_vistoria : '', local_confere: v ? rotuloSN(v.local_confere) : '',
        switch_conferido: v ? rotuloSN(v.switch_conferido) : '', switch_ok: v ? rotuloSN(v.switch_ok) : '',
        camera_conferida: v ? rotuloSN(v.camera_conferida) : '', camera_ok: v ? rotuloSN(v.camera_ok) : '',
        observacoes: v ? v.observacoes : '', qtd_fotos: v ? v.qtd_fotos : '',
      });
    });

    const nomeArquivo = `rdo_relatorio_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Erro ao gerar Excel:', err);
    res.status(500).json({ ok: false, erro: 'Falha ao gerar o relatório em Excel.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, hora: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`>> RDO Central rodando em http://localhost:${PORT}`);
  console.log(`>> Banco: ${DB_PATH}`);
});
