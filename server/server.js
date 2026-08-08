// Servidor central do RDO de Campo — recebe sincronizações dos celulares
// dos técnicos e serve os dados para o dashboard do gestor.
//
// Uso:
//   npm install
//   node server.js
//
// Variáveis de ambiente (opcionais):
//   PORT      - porta HTTP (padrão 3000)
//   API_KEY   - chave que os apps devem enviar no header 'x-api-key'
//               (se não definir, uma chave é gerada automaticamente na
//               primeira execução e salva em api_key.txt)
//   DB_PATH   - caminho do arquivo do banco (padrão ./rdo_central.sqlite)

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rdo_central.sqlite');
const API_KEY_FILE = path.join(__dirname, 'api_key.txt');

let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  if (fs.existsSync(API_KEY_FILE)) {
    API_KEY = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
  } else {
    API_KEY = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(API_KEY_FILE, API_KEY);
    console.log('>> Nova API_KEY gerada e salva em api_key.txt — configure essa mesma chave no app de campo e no dashboard.');
  }
}
console.log('>> API_KEY ativa:', API_KEY);

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
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve o app de campo e o dashboard como páginas estáticas, direto dessa
// mesma URL — assim não precisa mandar o .html por WhatsApp pra cada técnico.
app.use('/app-campo', express.static(path.join(__dirname, '..', 'app-campo')));
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.get('/', (req, res) => res.redirect('/app-campo/rdo-campo.html'));

function checkAuth(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ ok: false, erro: 'API key inválida' });
  next();
}

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

  res.json({ ok: true, obras_recebidas: obras.length, rdos_recebidas: rdos.length });
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

// ---- Dados agregados para o dashboard ----
app.get('/api/dashboard', checkAuth, (req, res) => {
  const heartbeats = db.prepare('SELECT * FROM heartbeats ORDER BY atualizado_em DESC').all();
  const rdosRecentes = db.prepare('SELECT * FROM rdos ORDER BY recebido_em DESC LIMIT 100').all();
  const totalRdos = db.prepare('SELECT COUNT(*) c FROM rdos').get().c;
  const totalObras = db.prepare('SELECT COUNT(*) c FROM obras').get().c;
  const hoje = new Date().toISOString().slice(0, 10);
  const atrasosHoje = db.prepare(`SELECT COUNT(*) c FROM rdos WHERE parou='sim' AND data_servico=?`).get(hoje).c;
  const rdosPorObra = db.prepare(`SELECT obra_nome, COUNT(*) c FROM rdos GROUP BY obra_nome ORDER BY c DESC`).all();
  const rdosHoje = db.prepare(`SELECT COUNT(*) c FROM rdos WHERE data_servico=?`).get(hoje).c;

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
    indicadores: { totalRdos, totalObras, atrasosHoje, rdosHoje, rdosPorObra, materiaisTop },
    obras: db.prepare('SELECT * FROM obras ORDER BY nome').all()
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, hora: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`>> RDO Central rodando em http://localhost:${PORT}`);
  console.log(`>> Banco: ${DB_PATH}`);
});
