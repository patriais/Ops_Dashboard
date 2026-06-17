// =============================================================
// BCAS - Centro de Operaciones
// Uso: node ops_dashboard.js
// =============================================================

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

// Load .env for local development
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  });
} catch {}

// =============================================================
// CONFIG
// =============================================================
const HS_TOKEN = process.env.HS_TOKEN;
const DB_URL   = process.env.DB_URL;

if (!HS_TOKEN || !DB_URL) {
  console.error('Error: faltan variables de entorno HS_TOKEN y/o DB_URL');
  console.error('Crea un fichero .env con esas variables o exportalas antes de ejecutar.');
  process.exit(1);
}
const OUT_DIR  = path.join(__dirname, 'public');
const OUTPUT   = path.join(OUT_DIR, 'index.html');

// =============================================================
// AUTH
// =============================================================
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-please-set-in-vercel';

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pwd, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pwd, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(pwd, salt, 100000, 64, 'sha512').toString('hex') === hash;
}
function signToken(email, isAdmin) {
  const payload = Buffer.from(JSON.stringify({ email, isAdmin, exp: Date.now() + 7*24*60*60*1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (expected !== sig) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const eq = c.indexOf('=');
    if (eq > 0) out[c.slice(0, eq).trim()] = decodeURIComponent(c.slice(eq + 1).trim());
  });
  return out;
}
function getAuthUser(req) {
  return verifyToken(parseCookies(req).ops_tok);
}
function setCookieHeader(token) {
  return 'ops_tok=' + token + '; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax' +
    (process.env.VERCEL ? '; Secure' : '');
}
function clearCookieHeader() {
  return 'ops_tok=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
}

// ── users DB ───────────────────────────────────────────────────
async function dbQuery(sql, params) {
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try { return (await db.query(sql, params || [])).rows; }
  finally { await db.end(); }
}
let _usersReady = false;
async function ensureUsersTable() {
  if (_usersReady) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS ops_users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const count = (await dbQuery('SELECT COUNT(*)::int AS n FROM ops_users'))[0].n;
  if (count === 0) {
    const adminPwd = process.env.ADMIN_PASSWORD;
    if (adminPwd) {
      await dbQuery(
        'INSERT INTO ops_users (email, password_hash, is_admin) VALUES ($1, $2, true)',
        ['patricia.ais@bcasapp.com', hashPassword(adminPwd)]
      );
    }
  }
  _usersReady = true;
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function buildLoginPage(error) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Bcas Ops — Acceso</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px;width:360px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h2{font-size:20px;font-weight:700;color:#111827;margin-bottom:6px}
p{font-size:13px;color:#6b7280;margin-bottom:28px}
label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px}
input{width:100%;border:1px solid #e5e7eb;border-radius:7px;padding:9px 12px;font-size:14px;color:#111827;outline:none;margin-bottom:16px}
input:focus{border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.1)}
button{width:100%;background:#0d9488;color:#fff;border:none;border-radius:7px;padding:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
button:hover{background:#0f766e}
.err{background:#fee2e2;color:#be123c;border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:16px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.logo-icon{width:38px;height:38px;background:#0d9488;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px}
</style></head><body>
<div class="box">
  <div class="logo"><div class="logo-icon">B</div><div><div style="font-weight:700;color:#111827">Bcas Ops</div><div style="font-size:11px;color:#9ca3af">Centro de operaciones</div></div></div>
  ${error ? '<div class="err">' + error + '</div>' : ''}
  <form method="POST" action="/api/login">
    <label>Email corporativo</label>
    <input type="email" name="email" placeholder="nombre@bcasapp.com" required autocomplete="username">
    <label>Contraseña</label>
    <input type="password" name="pwd" placeholder="••••••••" required autocomplete="current-password">
    <button type="submit">Entrar</button>
  </form>
</div>
</body></html>`;
}

async function parseFormBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const out = {};
      body.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent((v||'').replace(/\+/g, ' '));
      });
      resolve(out);
    });
  });
}

const DASHBOARDS = [
  {
    id:             'reclamaciones',
    name:           'Reclamaciones Legal',
    icon:           'RE',
    category:       'Reclamaciones',
    pipelineId:     '3845142727',
    staleAlertDays: 5,
    stageMap: {
      '5422927042': 'Sin asignar',
      '5424979163': 'Asignado',
      '5444889823': 'En gestión',
      '5422927043': 'Pendiente de resolución del organismo',
      '5422927044': 'Requerimiento adicional',
      '5424886986': 'Resolución',
      '5429547203': 'Archivado / desistido',
    },
    closedStages:    ['5424886986', '5429547203'],
    stageEntryProps: {
      '5422927042': 'hs_date_entered_5422927042',
      '5424979163': 'hs_date_entered_5424979163',
      '5444889823': 'hs_date_entered_5444889823',
      '5422927043': 'hs_date_entered_5422927043',
      '5422927044': 'hs_date_entered_5422927044',
      '5424886986': 'hs_date_entered_5424886986',
      '5429547203': 'hs_date_entered_5429547203',
    },
    typeMap: {
      withdrawal:               'Desistimiento',
      rgpd:                     'GDPR',
      consumer_claim:           'Reclamación de consumo',
      non_judicial_claim:       'Reclamación no judicial',
      judicial_claim:           'Requerimiento judicial',
      contractual_modification: 'Modificación contractual',
      informacion_request:      'Solicitud de información',
      other:                    'Otros',
    },
    ownerMap: {
      '737499105':  'Jaime Nunez',
      '1430947002': 'Lara Maino',
      '1295768209': 'Alan Marini',
      '2136671500': 'Julieta Darias',
      '2024313463': 'David Morera',
      '1988214614': 'German Blanco',
      '737483001':  'Manuel Avello',
      '29234237':   'Pablo Ortiz',
      '31766869':   'Mariana Gonzalez',
      '33849520':   'Lara Garcia',
      '33137020':   'Camila Garcia',
      '737482466':  'Javier Ausin',
      '12207485':   'Antonio Fernandez',
    },
  },
  // Añade aqui nuevos dashboards copiando el bloque de arriba
];

// =============================================================
// HELPERS
// =============================================================
function hsGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function hsPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function businessDays(from, to) {
  let days = 0, cur = new Date(from);
  cur.setHours(0,0,0,0);
  const end = new Date(to); end.setHours(0,0,0,0);
  while (cur < end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) days++;
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function toChartJson(map, topN = 99) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([label, value]) => ({ label, value }));
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// =============================================================
// FETCH TICKETS (paginado)
// =============================================================
async function fetchTickets(cfg) {
  const tickets = [];
  let after = null;
  const props = [
    'subject','hs_pipeline_stage','hubspot_owner_id',
    'createdate','hs_lastmodifieddate','request_type',
    ...Object.values(cfg.stageEntryProps),
  ];
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: cfg.pipelineId }] }],
      properties: props,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hsPost('/crm/v3/objects/tickets/search', body);
    if (resp.results) tickets.push(...resp.results);
    after = resp.paging?.next?.after ?? null;
  } while (after);
  return tickets;
}

// =============================================================
// GET CONTACT EMAILS VIA ASSOCIATIONS (batch)
// =============================================================
async function getContactEmails(ticketIds) {
  // Returns { ticketId -> email }
  const result = {};
  if (!ticketIds.length) return result;

  // Batch associations: tickets -> contacts
  const CHUNK = 100;
  const contactIdsByTicket = {};

  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    const body  = { inputs: chunk.map(id => ({ id: String(id) })) };
    const resp  = await hsPost('/crm/v4/associations/tickets/contacts/batch/read', body);
    if (resp.results) {
      resp.results.forEach(r => {
        const contactIds = (r.to || []).map(t => t.toObjectId);
        if (contactIds.length) contactIdsByTicket[r.from.id] = contactIds[0]; // primer contacto
      });
    }
  }

  // Batch read contacts -> email
  const uniqueContactIds = [...new Set(Object.values(contactIdsByTicket))];
  if (!uniqueContactIds.length) return result;

  for (let i = 0; i < uniqueContactIds.length; i += CHUNK) {
    const chunk = uniqueContactIds.slice(i, i + CHUNK);
    const body  = { inputs: chunk.map(id => ({ id: String(id) })), properties: ['email'] };
    const resp  = await hsPost('/crm/v3/objects/contacts/batch/read', body);
    if (resp.results) {
      const emailById = {};
      resp.results.forEach(c => { if (c.properties.email) emailById[c.id] = c.properties.email; });
      // Map ticket -> email
      for (const [ticketId, contactId] of Object.entries(contactIdsByTicket)) {
        if (emailById[String(contactId)]) result[ticketId] = emailById[String(contactId)];
      }
    }
  }

  return result;
}

// =============================================================
// QUERY DB: email -> school name
// =============================================================
async function getSchoolsByEmail(emails) {
  // Returns { email -> { school, loanId } }
  if (!emails.length) return {};
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const res = await db.query(
    `SELECT DISTINCT ON (ls.email) ls.email, ss.name AS school, ls.loan_id
     FROM loan_stats ls
     JOIN school_stats ss ON ls.school_id = ss.school_id
     WHERE ls.email = ANY($1)
     ORDER BY ls.email, ls.loan_id DESC`,
    [emails]
  );
  await db.end();
  const map = {};
  res.rows.forEach(r => { map[r.email.toLowerCase()] = { school: r.school, loanId: r.loan_id }; });
  return map;
}

// =============================================================
// PROCESS ONE DASHBOARD
// =============================================================
async function processDashboard(cfg) {
  process.stdout.write(`  Cargando ${cfg.name}...`);
  const tickets = await fetchTickets(cfg);
  process.stdout.write(` ${tickets.length} tickets\n`);

  // Get contact emails
  process.stdout.write(`  Obteniendo emails de contactos...`);
  const ticketIds      = tickets.map(t => t.id);
  const emailByTicket  = await getContactEmails(ticketIds);
  const uniqueEmails   = [...new Set(Object.values(emailByTicket).map(e => e.toLowerCase()))];
  process.stdout.write(` ${Object.keys(emailByTicket).length} con contacto\n`);

  // Query DB
  process.stdout.write(`  Consultando base de datos...`);
  const schoolByEmail = await getSchoolsByEmail(uniqueEmails);
  process.stdout.write(` ${Object.keys(schoolByEmail).length} matches\n`);

  // Aggregations
  const byStage = {}, byOwner = {}, byType = {}, bySchool = {};
  const resDays = [];
  const today   = new Date();

  const rows = tickets.map(t => {
    const s   = t.properties.hs_pipeline_stage;
    const sn  = cfg.stageMap[s] || `Etapa ${s}`;
    const o   = t.properties.hubspot_owner_id;
    const on  = (o && cfg.ownerMap[o]) ? cfg.ownerMap[o] : (o ? `Agente ${o}` : 'Sin asignar');
    const r   = t.properties.request_type;
    const rn  = (r && cfg.typeMap[r]) ? cfg.typeMap[r] : 'Sin categorizar';
    const email   = emailByTicket[t.id];
    const dbData  = email ? (schoolByEmail[email.toLowerCase()] || null) : null;
    const school  = dbData ? dbData.school : 'N/A';
    const loanId  = dbData ? String(dbData.loanId) : 'N/A';
    const subj = (t.properties.subject || '').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const dt   = fmtDate(t.properties.createdate);

    byStage[sn]  = (byStage[sn]  || 0) + 1;
    byOwner[on]  = (byOwner[on]  || 0) + 1;
    byType[rn]   = (byType[rn]   || 0) + 1;
    bySchool[school] = (bySchool[school] || 0) + 1;

    // Resolution time
    let rt = 'En curso';
    if (cfg.closedStages.includes(s)) {
      const msC = Object.entries(cfg.stageEntryProps)
        .filter(([sid]) => cfg.closedStages.includes(sid))
        .map(([, prop]) => t.properties[prop])
        .find(v => v);
      if (msC && t.properties.createdate) {
        const days = (new Date(+msC) - new Date(t.properties.createdate)) / 86400000;
        if (days >= 0) { rt = `${Math.round(days * 10) / 10} d`; resDays.push(days); }
      }
    }

    // Stale alert
    let stale = false;
    if (!cfg.closedStages.includes(s) && cfg.stageEntryProps[s]) {
      const msE = t.properties[cfg.stageEntryProps[s]];
      if (msE && businessDays(new Date(+msE), today) >= cfg.staleAlertDays) stale = true;
    }

    return { lid: loanId, s: subj, st: sn, o: on, ty: rn, sc: school, d: dt, rt, al: stale };
  });

  const total      = tickets.length;
  const closed     = tickets.filter(t => cfg.closedStages.includes(t.properties.hs_pipeline_stage)).length;
  const open       = total - closed;
  const unassigned = tickets.filter(t => !t.properties.hubspot_owner_id).length;
  const noType     = byType['Sin categorizar'] || 0;
  const avgR       = resDays.length ? `${Math.round(resDays.reduce((a,b)=>a+b,0)/resDays.length*10)/10} d` : '-';

  return {
    total, open, closed, unassigned, noType, avgR,
    sJ: toChartJson(byStage),
    oJ: toChartJson(byOwner, 15),
    tJ: toChartJson(byType),
    scJ: toChartJson(bySchool, 20),
    rJ: rows,
    typeOptions:  Object.values(cfg.typeMap).sort(),
    stageOptions: Object.values(cfg.stageMap),
  };
}

// =============================================================
// BUILD HTML
// =============================================================
function buildHtml(dashData, now, user) {
  // Nav
  const categories = {};
  DASHBOARDS.forEach(cfg => {
    if (!categories[cfg.category]) categories[cfg.category] = [];
    categories[cfg.category].push({ id: cfg.id, name: cfg.name, icon: cfg.icon });
  });

  const navJ     = JSON.stringify(Object.entries(categories).map(([cat, items]) => ({ cat, items })));
  const dashMapJ = JSON.stringify(Object.fromEntries(Object.entries(dashData)));
  const firstId  = DASHBOARDS[0].id;

  const css = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:#f9fafb;color:#111827;display:flex;height:100vh;overflow:hidden}
#sb{width:240px;min-width:240px;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;overflow-y:auto;transition:width .2s}
#sb.col{width:56px;min-width:56px}
.sbh{padding:16px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b}
.sbh b{font-size:13px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;letter-spacing:.01em}
.sbt{background:none;border:none;color:#475569;cursor:pointer;font-size:18px;padding:2px 5px;flex-shrink:0}
.sbt:hover{color:#fff}
.sbs{margin-top:6px}
.sbc{display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#475569;cursor:pointer;user-select:none}
.sbc:hover{color:#94a3b8}
.sbc .ar{font-size:10px;transition:transform .2s}
.sbc.open .ar{transform:rotate(90deg)}
.sbi{overflow:hidden;transition:max-height .25s ease;max-height:500px}
.sbi.closed{max-height:0}
.sbn{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;border-radius:6px;margin:1px 6px;transition:background .15s;white-space:nowrap;overflow:hidden}
.sbn:hover{background:#1e293b}
.sbn.act{background:#0d9488}
.sbic{width:28px;height:28px;border-radius:6px;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#475569;flex-shrink:0}
.sbn.act .sbic{background:rgba(255,255,255,.15);color:#fff}
.sbnm{font-size:12.5px;font-weight:500;color:#94a3b8;overflow:hidden;text-overflow:ellipsis}
.sbn.act .sbnm{color:#fff;font-weight:600}
#sb.col .sbn{justify-content:center;padding:8px}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.top{background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.top h1{font-size:14px;font-weight:600;color:#111827}
.top small{font-size:11px;color:#9ca3af}
.cnt{flex:1;overflow-y:auto;padding:20px 24px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:14px}
.kpi{background:#fff;border-radius:8px;padding:16px 18px;border:1px solid #e5e7eb}
.kpi .l{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:8px}
.kpi .v{font-size:26px;font-weight:700;color:#111827;line-height:1}
.k5 .v{font-size:18px;padding-top:2px;color:#0d9488}
.charts{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:14px}
.card{background:#fff;border-radius:8px;padding:18px 20px;border:1px solid #e5e7eb}
.card h2{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;margin-bottom:14px}
.cw{position:relative;height:220px}
.tc{background:#fff;border-radius:8px;padding:18px 24px;border:1px solid #e5e7eb}
.tc h2{font-size:13px;font-weight:600;color:#111827;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.tc h2 em{font-style:normal;font-weight:400;font-size:11px;color:#9ca3af;text-transform:none;letter-spacing:0}
.fi{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end}
.fi label{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:3px}
.fi input,.fi select{border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;font-size:12px;background:#fff;outline:none;color:#374151;min-width:130px}
.fi input:focus,.fi select:focus{border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.08)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 12px;background:#f9fafb;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;font-size:10px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#f9fafb}
.b{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}
.bo{background:#f0fdf4;color:#15803d}.bc{background:#f0fdf4;color:#15803d}.bt{background:#f0f9ff;color:#0369a1}.bn{background:#fff1f2;color:#be123c}
.bs{background:#f0fdfa;color:#0f766e}
.emp{text-align:center;padding:32px;color:#9ca3af;font-size:13px}
.ac{display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid #e5e7eb;color:#374151;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s}
.ac.on{background:#fee2e2;color:#be123c;border-color:#fecaca}
.ac:hover{background:#f9fafb}
.tbar{display:flex;gap:0;flex-wrap:wrap;border-bottom:1px solid #e5e7eb;margin-bottom:16px}
.tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:10px 20px;font-size:13px;font-weight:500;color:#6b7280;cursor:pointer;transition:color .15s;white-space:nowrap}
.tab:hover{color:#111827}
.tab.act{color:#0d9488;border-bottom-color:#0d9488;font-weight:600}
.stbar{display:flex;gap:6px;flex-wrap:wrap;padding:0 0 12px;margin-bottom:8px}
.subtab{background:#fff;border:1px solid #e5e7eb;padding:4px 14px;font-size:11px;font-weight:500;color:#6b7280;cursor:pointer;border-radius:6px;transition:all .15s}
.subtab:hover{background:#f0fdfa;border-color:#99f6e4;color:#0f766e}
.subtab.act{background:#0d9488;color:#fff;border-color:#0d9488}
.card-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:8px}
.calc-in{flex:1;border:1px solid #e5e7eb;border-radius:6px;padding:7px 11px;font-size:13px;color:#374151;outline:none}
.calc-in:focus{border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.08)}
.calc-btn{background:#0d9488;color:#fff;border:none;border-radius:6px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.calc-btn:hover{background:#0f766e}
.brow{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f3f4f6}
.mrow{display:flex;justify-content:space-between;padding:4px 0}
.r{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:18px;padding:0 5px;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.3px}
.r-Ap{background:#dbeafe;color:#1d4ed8}.r-A{background:#d1fae5;color:#065f46}.r-B{background:#fef3c7;color:#92400e}.r-C{background:#fee2e2;color:#991b1b}.r-D{background:#f3f4f6;color:#6b7280}.r-SD{background:#fce7f3;color:#9d174d}
.dp{font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px}.dp.pos{background:#d1fae5;color:#059669}.dp.neg{background:#fee2e2;color:#dc2626}
.ebar{display:inline-block;width:40px;height:4px;background:#f3f4f6;border-radius:2px;overflow:hidden;vertical-align:middle;margin-left:4px}
.efill{height:100%;border-radius:2px}
.rbox{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px}
.rbox-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.rsv.ok{color:#059669}.rsv.ko{color:#dc2626}
.sec-hd{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e5e7eb}
.sec-bg{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
.sec-g{background:#d1fae5;color:#065f46}.sec-r{background:#fee2e2;color:#991b1b}
.imp-up{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:#dbeafe;color:#1d4ed8}
.imp-eq{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:#f3f4f6;color:#6b7280}
.imp-dn{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:#fce7f3;color:#9d174d}`;

  const toolsHtml = `
    <div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>Herramientas</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        <div class="sbn" id="nav-calc" onclick="loadCalc()">
          <div class="sbic">AA</div>
          <span class="sbnm">Calculadora AA</span>
        </div>
        <div class="sbn" id="nav-modif" onclick="loadModIF()">
          <div class="sbic">IF</div>
          <span class="sbnm">Modificación IF</span>
        </div>
      </div>
    </div>
    <div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>Analytics</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        <div class="sbn" id="nav-empl" onclick="loadEmpleabilidad()">
          <div class="sbic">EM</div>
          <span class="sbnm">Empleabilidad</span>
        </div>
      </div>
    </div>
    <div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>Escuelas</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        <div class="sbn" id="nav-germany" onclick="loadIframe('germany','/escuelas/cartera-alemania','Cartera Alemania')">
          <div class="sbic">DE</div>
          <span class="sbnm">Cartera Alemania</span>
        </div>
      </div>
    </div>
    ${user && user.isAdmin ? `<div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>Admin</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        <div class="sbn" id="nav-settings" onclick="loadSettings()">
          <div class="sbic" style="font-size:14px">&#9881;</div>
          <span class="sbnm">Ajustes</span>
        </div>
      </div>
    </div>` : ''}`;

  const sidebarHtml = Object.entries(categories).map(([cat, items]) => `
    <div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>${cat}</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        ${items.map(item => `
        <div class="sbn${item.id === firstId ? ' act' : ''}" id="nav-${item.id}" onclick="loadDash('${item.id}')">
          <div class="sbic">${item.icon}</div>
          <span class="sbnm">${item.name}</span>
        </div>`).join('')}
      </div>
    </div>`).join('') + toolsHtml + `
`;

  const js = `
const NAV=${navJ};
const DASH=${dashMapJ};
const CL=['Resolución','Archivado / desistido'];
const C=['#0d9488','#14b8a6','#2dd4bf','#5eead4','#e07b74','#f97316','#60a5fa','#a78bfa','#34d399','#fb923c','#6366f1','#ec4899'];
const TABS=[
  {id:'reclamaciones',label:'Reclamaciones',types:['Reclamación no judicial','Requerimiento judicial','Reclamación de consumo'],
   subtabs:[{id:'all',label:'Todas',types:null},{id:'judicial',label:'Proceso judicial',types:['Requerimiento judicial']},{id:'consumo',label:'Consumo',types:['Reclamación de consumo']},{id:'no_judicial',label:'Proceso no judicial',types:['Reclamación no judicial']}]},
  {id:'gdpr',label:'GDPR',types:['GDPR'],subtabs:null},
  {id:'otros',label:'Otros',types:['Otros','Desistimiento','Modificación contractual'],subtabs:null},
  {id:'info',label:'Solicitud de información',types:['Solicitud de información'],subtabs:null},
  {id:'sin_cat',label:'Sin categorizar',types:['Sin categorizar'],subtabs:null}
];
let curCharts=[],onlyAlert=false,curId='',curTab='reclamaciones',curSubtab='all',curTabRows=[];

function mkD(id,d){var el=document.getElementById(id);if(!el)return;var c=new Chart(el,{type:'doughnut',data:{labels:d.map(function(x){return x.label;}),datasets:[{data:d.map(function(x){return x.value;}),backgroundColor:C,borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:10},padding:7,boxWidth:10}}}}});curCharts.push(c);}
function mkB(id,d){var el=document.getElementById(id);if(!el)return;var c=new Chart(el,{type:'bar',data:{labels:d.map(function(x){return x.label;}),datasets:[{data:d.map(function(x){return x.value;}),backgroundColor:C,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{grid:{color:'#edf2f7'},ticks:{font:{size:10}}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});curCharts.push(c);}
function chJ(rows,key){var m={};rows.forEach(function(r){if(r[key])m[r[key]]=(m[r[key]]||0)+1;});return Object.entries(m).sort(function(a,b){return b[1]-a[1];}).map(function(e){return{label:e[0],value:e[1]};});}
function uniq(key){return[...new Set(curTabRows.map(function(r){return r[key];}))].filter(Boolean).sort();}
function addOpts(sid,vals){var el=document.getElementById(sid);if(!el)return;vals.forEach(function(v){var o=document.createElement('option');o.value=v;o.textContent=v;el.appendChild(o);});}

function getTabRows(all,tabId,subId){
  var tab=TABS.find(function(t){return t.id===tabId;});
  if(!tab)return all;
  var sub=tab.subtabs&&subId!=='all'?tab.subtabs.find(function(s){return s.id===subId;}):null;
  var types=sub?sub.types:tab.types;
  return all.filter(function(r){return types&&types.includes(r.ty);});
}

function calcKpis(rows){
  var rd=rows.map(function(r){var v=parseFloat(r.rt);return isNaN(v)?null:v;}).filter(function(v){return v!==null;});
  var sum=rd.reduce(function(a,b){return a+b;},0);
  return{
    total:rows.length,
    open:rows.filter(function(r){return !CL.includes(r.st);}).length,
    closed:rows.filter(function(r){return CL.includes(r.st);}).length,
    unassigned:rows.filter(function(r){return r.o==='Sin asignar';}).length,
    noType:rows.filter(function(r){return r.ty==='Sin categorizar';}).length,
    avgR:rd.length?(Math.round(sum/rd.length*10)/10)+' d':'-'
  };
}

function loadDash(id){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];onlyAlert=false;curId=id;curTab='reclamaciones';curSubtab='all';
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-'+id);if(nav)nav.classList.add('act');
  var d=DASH[id];if(!d)return;
  var title='';NAV.forEach(function(g){g.items.forEach(function(i){if(i.id===id)title=i.name;});});
  document.getElementById('dashTitle').textContent=title;
  var tabHtml=TABS.map(function(t){return '<button class="tab'+(t.id==='reclamaciones'?' act':'')+'\" data-tabid=\"'+t.id+'\" onclick=\"switchTab(this.dataset.tabid)\">'+t.label+'</button>';}).join('');
  var recTab=TABS[0];
  var stHtml=recTab.subtabs.map(function(s){return '<button class="subtab'+(s.id==='all'?' act':'')+'\" data-subid=\"'+s.id+'\" onclick=\"switchSubtab(this.dataset.subid)\">'+s.label+'</button>';}).join('');
  document.getElementById('content').innerHTML=
    '<div class="tbar">'+tabHtml+'</div>'+
    '<div class="stbar" id="stbar">'+stHtml+'</div>'+
    '<div id="kpiArea"></div>'+
    '<div id="chartArea"></div>'+
    '<div id="tableArea"></div>';
  renderTab();
}

function switchTab(tabId){
  curTab=tabId;curSubtab='all';
  document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('act',b.dataset.tabid===tabId);});
  var stbar=document.getElementById('stbar');
  if(stbar){
    stbar.style.display=tabId==='reclamaciones'?'':'none';
    if(tabId==='reclamaciones'){document.querySelectorAll('.subtab').forEach(function(b,i){b.classList.toggle('act',i===0);});}
  }
  renderTab();
}

function switchSubtab(subId){
  curSubtab=subId;
  document.querySelectorAll('.subtab').forEach(function(b){b.classList.toggle('act',b.dataset.subid===subId);});
  renderTab();
}

function renderTab(){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];onlyAlert=false;
  var d=DASH[curId];if(!d)return;
  curTabRows=getTabRows(d.rJ,curTab,curSubtab);
  var k=calcKpis(curTabRows);
  document.getElementById('kpiArea').innerHTML=
    '<div class="kpis">'+
    '<div class="kpi k0"><div class="l">Total tickets</div><div class="v">'+k.total+'</div></div>'+
    '<div class="kpi k1"><div class="l">Abiertos</div><div class="v">'+k.open+'</div></div>'+
    '<div class="kpi k2"><div class="l">Cerrados</div><div class="v">'+k.closed+'</div></div>'+
    '<div class="kpi k3"><div class="l">Sin asignar</div><div class="v">'+k.unassigned+'</div></div>'+
    '<div class="kpi k4"><div class="l">Sin categorizar</div><div class="v">'+k.noType+'</div></div>'+
    '<div class="kpi k5"><div class="l">T. medio resolucion</div><div class="v">'+k.avgR+'</div></div>'+
    '</div>';
  document.getElementById('chartArea').innerHTML=
    '<div class="charts">'+
    '<div class="card"><h2>Por tipo de solicitud</h2><div class="cw"><canvas id="cT"></canvas></div></div>'+
    '<div class="card"><h2>Por estado</h2><div class="cw"><canvas id="cS"></canvas></div></div>'+
    '<div class="card"><h2>Por responsable</h2><div class="cw"><canvas id="cO"></canvas></div></div>'+
    '<div class="card"><h2>Por escuela</h2><div class="cw"><canvas id="cSc"></canvas></div></div>'+
    '</div>';
  mkD('cT',chJ(curTabRows,'ty'));
  mkD('cS',chJ(curTabRows,'st'));
  mkB('cO',chJ(curTabRows,'o'));
  mkD('cSc',chJ(curTabRows,'sc'));
  document.getElementById('tableArea').innerHTML=
    '<div class="tc">'+
    '<h2>Todos los tickets <em id="cnt"></em></h2>'+
    '<div class="fi">'+
    '<div><label>Buscar</label><input id="fSe" type="text" placeholder="Asunto..." oninput="rnd()"></div>'+
    '<div><label>Tipo solicitud</label><select id="fT" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Estado</label><select id="fSt" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Responsable</label><select id="fO" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Escuela</label><select id="fSc" onchange="rnd()"><option value="">Todas</option></select></div>'+
    '<div><button class="ac" id="btnAl" onclick="toggleAl()">⚠️ Solo alertas</button></div>'+
    '</div>'+
    '<table><thead><tr><th>Loan ID</th><th>Escuela</th><th>Asunto</th><th>Tipo solicitud</th><th>Estado</th><th>Responsable</th><th>Fecha</th><th>T. resolucion</th></tr></thead><tbody id="tb"></tbody></table>'+
    '</div>';
  addOpts('fT',uniq('ty'));
  addOpts('fSt',d.stageOptions);
  addOpts('fO',uniq('o'));
  addOpts('fSc',uniq('sc'));
  rnd();
}

function toggleAl(){onlyAlert=!onlyAlert;var b=document.getElementById('btnAl');if(b)b.classList.toggle('on',onlyAlert);rnd();}

function rnd(){
  var s=(document.getElementById('fSe')||{}).value||'';
  var ft=(document.getElementById('fT')||{}).value||'';
  var fs=(document.getElementById('fSt')||{}).value||'';
  var fo=(document.getElementById('fO')||{}).value||'';
  var fsc=(document.getElementById('fSc')||{}).value||'';
  var f=curTabRows.filter(function(r){
    return(!s||(r.s||'').toLowerCase().includes(s.toLowerCase()))&&
    (!ft||r.ty===ft)&&(!fs||r.st===fs)&&(!fo||r.o===fo)&&(!fsc||r.sc===fsc)&&
    (!onlyAlert||r.al);
  });
  var cnt=document.getElementById('cnt');if(cnt)cnt.textContent=f.length+' resultado'+(f.length!==1?'s':'');
  var tb=document.getElementById('tb');if(!tb)return;
  if(!f.length){tb.innerHTML='<tr><td colspan=8 class="emp">Sin resultados</td></tr>';return;}
  tb.innerHTML=f.map(function(r){
    return '<tr style="'+(r.al?'background:#fffbeb':'')+'">'
      +'<td style="font-family:monospace;font-size:11px;color:#4a5568">'+r.lid+'</td>'
      +'<td><span class="b '+(r.sc==='N/A'?'bn':'bs')+'">'+r.sc+'</span></td>'
      +'<td title="'+r.s+'">'+(r.al?'⚠️ ':'')+(r.s||'(sin asunto)')+'</td>'
      +'<td><span class="b '+(r.ty==='Sin categorizar'?'bn':'bt')+'">'+r.ty+'</span></td>'
      +'<td><span class="b '+(CL.includes(r.st)?'bc':'bo')+'">'+r.st+'</span></td>'
      +'<td>'+r.o+'</td>'
      +'<td>'+r.d+'</td>'
      +'<td style="color:'+(r.rt==='En curso'?'#3182ce':'#276749')+';font-weight:600">'+r.rt+'</td>'
      +'</tr>';
  }).join('');
}

function toggleSb(){document.getElementById('sb').classList.toggle('col');}
function toggleCat(el){el.classList.toggle('open');el.nextElementSibling.classList.toggle('closed');}

function fmtEur(n){return n.toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';}
function mkBrow(lbl,val,main){
  return '<div class="brow">'+
    '<span style="font-size:12px;color:#374151">'+lbl+'</span>'+
    '<span style="font-size:'+(main?'16':'13')+'px;font-weight:'+(main?'700':'500')+';color:'+(main?'#0d9488':'#6b7280')+'">'+fmtEur(val)+'</span>'+
  '</div>';
}
function mkMeta(lbl,val){
  return '<div class="mrow">'+
    '<span style="font-size:11px;color:#6b7280">'+lbl+'</span>'+
    '<span style="font-size:11px;font-weight:600;color:#374151">'+val+'</span>'+
  '</div>';
}

function loadCalc(){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-calc');if(nav)nav.classList.add('act');
  document.getElementById('dashTitle').textContent='Calculadora AA';
  document.getElementById('content').innerHTML=
    '<div style="max-width:560px">'+
    '<div class="card" style="margin-bottom:16px">'+
    '<h2 style="margin-bottom:6px">Amortización Anticipada Total</h2>'+
    '<p style="font-size:12px;color:#9ca3af;margin-bottom:14px">Importe exacto que debe pagar el alumno hoy para cancelar el préstamo anticipadamente.</p>'+
    '<div style="display:flex;gap:8px">'+
    '<input id="calcIn" class="calc-in" type="text" placeholder="Loan ID...">'+
    '<button id="calcBtn" class="calc-btn">Calcular</button>'+
    '</div>'+
    '</div>'+
    '<div id="calcRes"></div>'+
    '</div>';
  var inp=document.getElementById('calcIn');
  var btn=document.getElementById('calcBtn');
  if(btn)btn.addEventListener('click',doCalc);
  if(inp){inp.addEventListener('keydown',function(e){if(e.key==='Enter')doCalc();});inp.focus();}
}

function doCalc(){
  var lid=(document.getElementById('calcIn')||{}).value||'';
  lid=lid.trim();
  if(!lid)return;
  var res=document.getElementById('calcRes');
  if(!res)return;
  res.innerHTML='<div class="card" style="text-align:center;padding:32px;color:#9ca3af;font-size:13px">Calculando...</div>';
  fetch('/api/calculate?loan_id='+encodeURIComponent(lid))
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.errors||data.error){
        var msg=(data.errors&&data.errors[0])?data.errors[0].message:(data.error||'Error desconocido');
        res.innerHTML='<div class="card" style="border-color:#fecaca;padding:16px"><p style="color:#be123c;font-size:13px;margin:0">'+msg+'</p></div>';
        return;
      }
      var m=data.metadata_calculo;
      var warn=data.warnings&&data.warnings.length
        ?'<div style="background:#fffbeb;border:1px solid #fef08a;border-radius:6px;padding:10px 14px;margin-top:12px">'+
          data.warnings.map(function(w){return '<p style="font-size:11px;color:#92400e;margin:2px 0">⚠️ '+w+'</p>';}).join('')+
          '</div>'
        :'';
      res.innerHTML=
        '<div class="card" style="padding:0;overflow:hidden">'+
          '<div class="tbar" style="margin:0;padding:0 20px">'+
            '<button class="tab ctab act" data-ctab="tae" onclick="switchCalcTab(this)">A igual TAE</button>'+
            '<button class="tab ctab" data-ctab="full" onclick="switchCalcTab(this)">Incl. cte de gestión</button>'+
            '<button class="tab ctab" data-ctab="reduce" onclick="switchCalcTab(this)">Reducir cuotas</button>'+
          '</div>'+
          '<div id="cpanel-tae" style="padding:18px 20px">'+
            '<div style="text-align:center;padding:8px 0 20px">'+
              '<div class="card-lbl">Saldo bruto pendiente</div>'+
              '<div style="font-size:44px;font-weight:700;color:#0d9488;line-height:1.1">'+fmtEur(data.breakdown.saldo_bruto_pendiente)+'</div>'+
              '<div style="font-size:11px;color:#9ca3af;margin-top:6px">'+data.fecha_calculo+' &nbsp;·&nbsp; Loan ID: <b>'+data.loan_id+'</b></div>'+
            '</div>'+
            '<div style="border-top:1px solid #e5e7eb;padding-top:14px">'+
              '<div class="card-lbl">Datos del cálculo</div>'+
              mkMeta('TAE contractual',(m.TAE_contractual*100).toFixed(2)+'%')+
              mkMeta('Cuota mensual',fmtEur(m.cuota_mensual))+
              mkMeta('Cuotas pagadas / total',m.cuotas_pagadas+' / '+(m.cuotas_pagadas+m.cuotas_pendientes))+
              mkMeta('Días desde desembolso',m.dias_desde_desembolso)+
              mkMeta('Días desde última cuota',m.dias_desde_ultima_cuota)+
            '</div>'+
            warn+
          '</div>'+
          '<div id="cpanel-full" style="display:none;padding:18px 20px">'+
            '<div style="text-align:center;padding:8px 0 20px">'+
              '<div class="card-lbl">Importe bruto a cobrar</div>'+
              '<div style="font-size:44px;font-weight:700;color:#0d9488;line-height:1.1">'+fmtEur(data.importe_bruto_a_cobrar)+'</div>'+
              '<div style="font-size:11px;color:#9ca3af;margin-top:6px">'+data.fecha_calculo+' &nbsp;·&nbsp; Loan ID: <b>'+data.loan_id+'</b></div>'+
            '</div>'+
            '<div style="border-top:1px solid #e5e7eb;padding-top:14px;margin-bottom:6px">'+
              '<div class="card-lbl">Desglose</div>'+
              mkBrow('Saldo bruto pendiente',data.breakdown.saldo_bruto_pendiente,true)+
              mkBrow('Comisión Stripe cuotas pagadas',data.breakdown.stripe_retenido,false)+
              mkBrow('Intereses línea de crédito',data.breakdown.intereses_linea_pagados,false)+
              mkBrow('Importe neto a recibir',data.breakdown.importe_neto_a_recibir,true)+
              mkBrow('Comisión procesamiento pago AA',data.breakdown.comision_pago_aa,false)+
            '</div>'+
            '<div style="border-top:1px solid #e5e7eb;padding-top:14px;margin-top:8px">'+
              '<div class="card-lbl">Datos del cálculo</div>'+
              mkMeta('TAE contractual',(m.TAE_contractual*100).toFixed(2)+'%')+
              mkMeta('Cuota mensual',fmtEur(m.cuota_mensual))+
              mkMeta('Cuotas pagadas / total',m.cuotas_pagadas+' / '+(m.cuotas_pagadas+m.cuotas_pendientes))+
              mkMeta('Método de pago',m.metodo_pago)+
              mkMeta('Días desde desembolso',m.dias_desde_desembolso)+
              mkMeta('Días desde última cuota',m.dias_desde_ultima_cuota)+
            '</div>'+
            warn+
          '</div>'+
          '<div id="cpanel-reduce" style="display:none;padding:18px 20px">'+
            '<p style="font-size:11px;color:#9ca3af;margin:0 0 14px;line-height:1.5">El alumno no paga un importe único: termina el préstamo en <b>menos cuotas</b> pagando una cuota mensual más alta. Se mantiene el mismo TAE contractual sobre el saldo pendiente, de modo que BCAS queda indemne.</p>'+
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'+
              '<label style="font-size:12px;color:#374151;flex:1">Nuevas cuotas restantes</label>'+
              '<input id="redIn" class="calc-in" type="number" min="1" max="'+m.cuotas_pendientes+'" step="1" value="'+m.cuotas_pendientes+'" style="max-width:90px;text-align:center" oninput="recomputeReduce()">'+
            '</div>'+
            '<div style="font-size:11px;color:#9ca3af;margin-bottom:16px">Plan actual: quedan <b>'+m.cuotas_pendientes+'</b> cuota'+(m.cuotas_pendientes>1?'s':'')+' de '+fmtEur(m.cuota_mensual)+'</div>'+
            '<div id="redOut"></div>'+
          '</div>'+
        '</div>';
      window._calc={saldo:data.breakdown.saldo_bruto_pendiente,i:m.tasa_mensual_implicita,pend:m.cuotas_pendientes,cuotaOrig:m.cuota_mensual,tae:m.TAE_contractual};
      recomputeReduce();
    })
    .catch(function(e){
      res.innerHTML='<div class="card" style="border-color:#fecaca;padding:16px"><p style="color:#be123c;font-size:13px;margin:0">Error de conexión: '+e.message+'</p></div>';
    });
}

function switchCalcTab(btn){
  var t=btn.dataset.ctab;
  document.querySelectorAll('.ctab').forEach(function(b){b.classList.toggle('act',b.dataset.ctab===t);});
  ['tae','full','reduce'].forEach(function(p){
    var el=document.getElementById('cpanel-'+p);
    if(el)el.style.display=t===p?'':'none';
  });
}

function recomputeReduce(){
  var c=window._calc;if(!c)return;
  var inp=document.getElementById('redIn'),out=document.getElementById('redOut');
  if(!inp||!out)return;
  var M=parseInt(inp.value,10);
  if(!M||M<1){out.innerHTML='<div style="font-size:12px;color:#be123c">Introduce un número de cuotas válido (≥ 1).</div>';return;}
  if(M>c.pend){M=c.pend;inp.value=M;}
  var i=c.i,saldo=c.saldo;
  var nuevaCuota=Math.abs(i)<1e-9?saldo/M:saldo*i/(1-Math.pow(1+i,-M));
  var totalNuevo=nuevaCuota*M;
  var totalPlan=c.cuotaOrig*c.pend;
  var ahorro=totalPlan-totalNuevo;
  var deltaCuota=nuevaCuota-c.cuotaOrig;
  out.innerHTML=
    '<div style="text-align:center;padding:8px 0 18px">'+
      '<div class="card-lbl">Nueva cuota mensual</div>'+
      '<div style="font-size:44px;font-weight:700;color:#0d9488;line-height:1.1">'+fmtEur(nuevaCuota)+'</div>'+
      '<div style="font-size:11px;color:#9ca3af;margin-top:6px">terminar en <b>'+M+'</b> cuota'+(M>1?'s':'')+' &nbsp;·&nbsp; '+(deltaCuota>=0?'+':'')+fmtEur(deltaCuota)+' vs cuota actual</div>'+
    '</div>'+
    '<div style="border-top:1px solid #e5e7eb;padding-top:14px">'+
      '<div class="card-lbl">Comparativa</div>'+
      mkBrow('Total a pagar (nuevo plan)',totalNuevo,true)+
      mkBrow('Total restante (plan actual)',totalPlan,false)+
      mkBrow('Ahorro en intereses para el alumno',ahorro,false)+
    '</div>'+
    '<div style="border-top:1px solid #e5e7eb;padding-top:14px;margin-top:8px">'+
      '<div class="card-lbl">Datos del cálculo</div>'+
      mkMeta('Saldo pendiente (base)',fmtEur(saldo))+
      mkMeta('TAE contractual mantenido',(c.tae*100).toFixed(2)+'%')+
      mkMeta('Cuota mensual original',fmtEur(c.cuotaOrig))+
    '</div>';
}

function loadModIF(){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-modif');if(nav)nav.classList.add('act');
  document.getElementById('dashTitle').textContent='Modificación IF';
  document.getElementById('content').innerHTML=
    '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">'+
    '<div style="flex:0 0 520px;max-width:520px">'+
    '<div class="card" style="margin-bottom:16px">'+
    '<h2 style="margin-bottom:6px">Modificación del importe financiado</h2>'+
    '<p style="font-size:12px;color:#9ca3af;margin-bottom:14px">Solo préstamos PaP de Bcasfintech. El préstamo se reconfigura como si se hubiera concedido por el nuevo importe desde el inicio: las cuotas ya abonadas se descuentan del nuevo total a devolver y el saldo se reparte entre las cuotas pendientes.</p>'+
    '<div style="display:flex;gap:8px">'+
    '<input id="modIn" class="calc-in" type="text" placeholder="Loan ID...">'+
    '<button id="modBtn" class="calc-btn">Buscar</button>'+
    '</div>'+
    '</div>'+
    '<div id="modRes"></div>'+
    '</div>'+
    '<div id="modMsg" style="flex:1;min-width:340px;position:sticky;top:16px"></div>'+
    '</div>';
  var inp=document.getElementById('modIn');
  var btn=document.getElementById('modBtn');
  if(btn)btn.addEventListener('click',doModIF);
  if(inp){inp.addEventListener('keydown',function(e){if(e.key==='Enter')doModIF();});inp.focus();}
}

function doModIF(){
  var lid=(document.getElementById('modIn')||{}).value||'';
  lid=lid.trim();
  if(!lid)return;
  var res=document.getElementById('modRes');
  if(!res)return;
  res.innerHTML='<div class="card" style="text-align:center;padding:32px;color:#9ca3af;font-size:13px">Buscando...</div>';
  fetch('/api/modify-if?loan_id='+encodeURIComponent(lid))
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.error){
        res.innerHTML='<div class="card" style="border-color:#fecaca;padding:16px"><p style="color:#be123c;font-size:13px;margin:0">'+data.error+'</p></div>';
        return;
      }
      window._modif=data;
      res.innerHTML=
        '<div class="card" style="padding:0;overflow:hidden">'+
          '<div style="padding:18px 20px;border-bottom:1px solid #e5e7eb">'+
            '<div class="card-lbl">Préstamo actual</div>'+
            mkMeta('Loan ID',data.loan_id)+
            mkMeta('Financiador',data.financier_name)+
            mkMeta('Importe financiado',fmtEur(data.importe_financiado_actual))+
            mkMeta('Coste por cuota ('+data.pct_coste_cuota.toFixed(2)+'%)',data.student_paga_coste?fmtEur(data.coste_cuota_actual):'0,00 € (lo asume la escuela)')+
            mkMeta('Cuota actual',fmtEur(data.cuota_actual))+
            mkMeta('Cuotas pagadas / total',data.cuotas_pagadas+' / '+data.num_cuotas)+
            mkMeta('Importe ya abonado',fmtEur(data.importe_pagado))+
          '</div>'+
          '<div style="padding:18px 20px">'+
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'+
              '<label style="font-size:12px;color:#374151;flex:1">Incremento del importe financiado (€)</label>'+
              '<input id="modAmt" class="calc-in" type="number" min="0" step="1" value="0" placeholder="0" style="max-width:130px;text-align:center" oninput="recomputeModIF()">'+
            '</div>'+
            '<div style="font-size:11px;color:#9ca3af;margin-bottom:8px">IF inicial <b>'+fmtEur(data.importe_financiado_actual)+'</b> + incremento = nuevo IF (se calcula abajo).</div>'+
            (data.cuotas_pendientes<1?'<div style="font-size:11px;color:#be123c;margin-bottom:8px">No quedan cuotas pendientes: el préstamo ya está pagado.</div>':'<div style="font-size:11px;color:#9ca3af;margin-bottom:8px">El saldo se repartirá entre <b>'+data.cuotas_pendientes+'</b> cuota'+(data.cuotas_pendientes>1?'s':'')+' pendiente'+(data.cuotas_pendientes>1?'s':'')+'.</div>')+
            '<div id="modOut"></div>'+
          '</div>'+
        '</div>';
      recomputeModIF();
    })
    .catch(function(e){
      res.innerHTML='<div class="card" style="border-color:#fecaca;padding:16px"><p style="color:#be123c;font-size:13px;margin:0">Error de conexión: '+e.message+'</p></div>';
    });
}

function recomputeModIF(){
  var b=window._modif;if(!b)return;
  var inp=document.getElementById('modAmt'),out=document.getElementById('modOut');
  if(!inp||!out)return;
  var msgEl=document.getElementById('modMsg');
  var clearMsg=function(){if(msgEl)msgEl.innerHTML='';};
  var inc=parseFloat(inp.value);
  if(isNaN(inc)){clearMsg();out.innerHTML='<div style="font-size:12px;color:#be123c">Introduce el incremento del IF (un número en €).</div>';return;}
  var r2=function(x){return Math.round(x*100)/100;};
  var A=r2(b.importe_financiado_actual+inc);   // nuevo IF = IF inicial + incremento
  if(A<=0){clearMsg();out.innerHTML='<div style="font-size:12px;color:#be123c">El nuevo IF resultante debe ser &gt; 0 (incremento demasiado negativo).</div>';return;}
  var rate=b.student_paga_coste?b.pct_coste_cuota/100:0;
  var costeCuota=A*rate;
  var totalCoste=r2(costeCuota*b.num_cuotas);
  var totalDevolver=r2(A+totalCoste);
  var saldo=r2(totalDevolver-b.importe_pagado);
  var nPend=b.cuotas_pendientes;
  var nuevaCuota=nPend>0?r2(saldo/nPend):0;
  var deltaCuota=nuevaCuota-b.cuota_actual;
  out.innerHTML=
    '<div style="text-align:center;padding:6px 0 18px">'+
      '<div class="card-lbl">Nueva cuota (pendientes)</div>'+
      '<div style="font-size:44px;font-weight:700;color:#0d9488;line-height:1.1">'+(nPend>0?fmtEur(nuevaCuota):'—')+'</div>'+
      (nPend>0?'<div style="font-size:11px;color:#9ca3af;margin-top:6px"><b>'+nPend+'</b> cuota'+(nPend>1?'s':'')+' de '+fmtEur(nuevaCuota)+' &nbsp;·&nbsp; '+(deltaCuota>=0?'+':'')+fmtEur(deltaCuota)+' vs cuota actual</div>':'')+
    '</div>'+
    '<div style="border-top:1px solid #e5e7eb;padding-top:14px">'+
      '<div class="card-lbl">Nuevo préstamo</div>'+
      mkBrow('IF inicial',b.importe_financiado_actual,false)+
      mkBrow('Incremento aplicado',r2(inc),false)+
      mkBrow('Nuevo importe financiado',r2(A),true)+
      mkBrow('Coste por cuota',r2(costeCuota),false)+
      mkBrow('Total coste financiero ('+b.num_cuotas+' cuotas)',totalCoste,false)+
      mkBrow('Total a devolver',totalDevolver,true)+
    '</div>'+
    '<div style="border-top:1px solid #e5e7eb;padding-top:14px;margin-top:8px">'+
      '<div class="card-lbl">Reparto del saldo</div>'+
      mkBrow('Importe ya abonado ('+b.cuotas_pagadas+' cuota'+(b.cuotas_pagadas!==1?'s':'')+')',b.importe_pagado,false)+
      mkBrow('Saldo pendiente a repartir',saldo,true)+
      mkMeta('Cuotas pendientes',nPend)+
      mkMeta('Nueva cuota','= '+fmtEur(saldo)+' / '+nPend+(nPend>0?' = '+fmtEur(nuevaCuota):''))+
    '</div>';

  // ── Mensaje listo para copiar/pegar (derecha) ──────────────────
  if(msgEl){
    var cw=function(n){return n===1?'cuota':'cuotas';};
    if(nPend<1){
      msgEl.innerHTML='<div class="card"><div class="card-lbl" style="margin-bottom:8px">Mensaje para el alumno</div>'+
        '<div style="font-size:12px;color:#9ca3af">No quedan cuotas pendientes; no hay reparto que comunicar.</div></div>';
    }else{
      var paidPer=b.cuotas_pagadas>0?r2(b.importe_pagado/b.cuotas_pagadas):0;
      var msg=
        '• Nuevo importe financiado: '+fmtEur(A)+'\\n'+
        '• Coste por cuota: '+fmtEur(r2(costeCuota))+'\\n'+
        '• Total coste financiero ('+b.num_cuotas+' '+cw(b.num_cuotas)+'): '+fmtEur(totalCoste)+'\\n'+
        '• Total a devolver: '+fmtEur(totalDevolver)+'\\n\\n';
      if(b.cuotas_pagadas>0){
        msg+='La alumna ya ha abonado '+b.cuotas_pagadas+' '+cw(b.cuotas_pagadas)+' de '+fmtEur(paidPer)+
             ' (total: '+fmtEur(b.importe_pagado)+'), por lo que el saldo pendiente es de '+fmtEur(saldo)+
             ', repartido en '+nPend+' '+cw(nPend)+' de '+fmtEur(nuevaCuota)+'.';
      }else{
        msg+='El saldo pendiente es de '+fmtEur(saldo)+', repartido en '+nPend+' '+cw(nPend)+' de '+fmtEur(nuevaCuota)+'.';
      }
      var ta=document.createElement('textarea');
      ta.id='modMsgTxt';ta.readOnly=true;ta.value=msg;
      ta.setAttribute('style','width:100%;box-sizing:border-box;height:210px;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:13px;color:#374151;line-height:1.6;resize:vertical;font-family:inherit;background:#f9fafb');
      msgEl.innerHTML='<div class="card">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'+
          '<div class="card-lbl" style="margin:0">Mensaje para el alumno</div>'+
          '<button class="calc-btn" style="padding:5px 14px;font-size:12px" onclick="copyModMsg(this)">Copiar</button>'+
        '</div></div>';
      msgEl.firstChild.appendChild(ta);
    }
  }
}

function copyModMsg(btn){
  var t=document.getElementById('modMsgTxt');if(!t)return;
  t.focus();t.select();try{t.setSelectionRange(0,99999);}catch(e){}
  var done=function(){var o=btn.textContent;btn.textContent='¡Copiado!';setTimeout(function(){btn.textContent=o;},1500);};
  var fail=function(){try{document.execCommand('copy');done();}catch(e){btn.textContent='Selecciona y copia';}};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value).then(done,fail);}else{fail();}
}

function loadIframe(navId, url, title){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-'+navId);if(nav)nav.classList.add('act');
  document.getElementById('dashTitle').textContent=title;
  document.getElementById('content').innerHTML=
    '<iframe src="'+url+'" style="width:100%;height:calc(100vh - 56px);border:none;display:block;margin:-20px -24px;width:calc(100% + 48px)" allowfullscreen></iframe>';
}

function loadEmpleabilidad(){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-empl');if(nav)nav.classList.add('act');
  document.getElementById('dashTitle').textContent='Empleabilidad';
  var T={12:{'A+':90,A:80,B:70,C:60,D:50},18:{'A+':94,A:85,B:77,C:70,D:62},24:{'A+':95,A:90,B:85,C:80,D:75},30:{'A+':97,A:93,B:88,C:85,D:80}};
  var RO=['A+','A','B','C','D'];
  var RC={'A+':'r-Ap',A:'r-A',B:'r-B',C:'r-C',D:'r-D','Sub-D':'r-SD'};
  var EMPL=[
    // name|rating|n|f3m|f1m|e12|e18|e24|e30  (eXX = null → sin dato)
    {name:'EDEM',              rating:'A+',n:11, f3m:4, f1m:1, e12:90.9,e18:93.1,e24:97.5, e30:98.0},
    {name:'Mos',               rating:'A+',n:41, f3m:9, f1m:3, e12:70.7,e18:82.4,e24:100.0,e30:null},
    {name:'Hack A Boss',       rating:'A', n:380,f3m:52,f1m:18,e12:62.5,e18:60.2,e24:59.0, e30:61.3},
    {name:'The Bridge',        rating:'A', n:166,f3m:28,f1m:9, e12:48.4,e18:55.1,e24:63.4, e30:68.0},
    {name:'Quatermain',        rating:'A', n:142,f3m:21,f1m:7, e12:75.4,e18:80.6,e24:88.0, e30:91.2},
    {name:'Assembler',         rating:'A', n:77, f3m:14,f1m:4, e12:67.0,e18:76.3,e24:90.0, e30:92.5},
    {name:'Oxygen Network',    rating:'A', n:20, f3m:5, f1m:2, e12:94.0,e18:82.5,e24:66.7, e30:null},
    {name:'Pontia',            rating:'A', n:16, f3m:3, f1m:1, e12:81.3,e18:76.4,e24:69.2, e30:72.0},
    {name:'Europeanbitech',    rating:'A', n:11, f3m:2, f1m:0, e12:81.8,e18:null,e24:null,  e30:null},
    {name:'Upgrade Hub',       rating:'B', n:100,f3m:18,f1m:6, e12:46.4,e18:51.2,e24:58.0, e30:63.4},
    {name:'4geeks',            rating:'B', n:95, f3m:16,f1m:5, e12:50.8,e18:54.3,e24:58.0, e30:62.1},
    {name:'Vomiack',           rating:'B', n:80, f3m:13,f1m:4, e12:57.3,e18:63.5,e24:71.4, e30:75.0},
    {name:'University Of Sales',rating:'B',n:79, f3m:11,f1m:3, e12:49.4,e18:53.2,e24:58.3, e30:61.0},
    {name:'Nuclio',            rating:'B', n:66, f3m:10,f1m:3, e12:54.2,e18:57.8,e24:62.5, e30:66.3},
    {name:'Geekshubs',         rating:'B', n:42, f3m:7, f1m:2, e12:54.8,e18:60.4,e24:67.6, e30:71.2},
    {name:'Thepower',          rating:'B', n:38, f3m:6, f1m:2, e12:39.9,e18:51.3,e24:66.7, e30:72.5},
    {name:'Keepcoding',        rating:'B', n:30, f3m:5, f1m:1, e12:53.3,e18:53.6,e24:53.8, e30:56.0},
    {name:'Neoland',           rating:'B', n:17, f3m:3, f1m:1, e12:52.9,e18:55.8,e24:60.0, e30:null},
    {name:'Codertech',         rating:'B', n:16, f3m:3, f1m:1, e12:62.6,e18:65.4,e24:69.2, e30:null},
    {name:'Immune',            rating:'B', n:16, f3m:2, f1m:0, e12:56.3,e18:64.1,e24:75.0, e30:null},
    {name:'Product Hackers',   rating:'B', n:10, f3m:2, f1m:1, e12:70.0,e18:83.3,e24:100.0,e30:null},
    {name:'Reboot',            rating:'B', n:7,  f3m:1, f1m:0, e12:57.1,e18:61.2,e24:66.7, e30:null},
    {name:'Anti Dev',          rating:'B', n:6,  f3m:1, f1m:0, e12:83.3,e18:68.5,e24:50.0, e30:null},
    {name:'Gammatech',         rating:'C', n:49, f3m:8, f1m:2, e12:51.0,e18:52.8,e24:54.8, e30:58.0},
    {name:'Multioly',          rating:'C', n:47, f3m:7, f1m:2, e12:53.2,e18:58.4,e24:65.0, e30:69.3},
    {name:'Atalaib',           rating:'C', n:22, f3m:4, f1m:1, e12:54.5,e18:57.2,e24:61.5, e30:null},
    {name:'Instituto Tm',      rating:'C', n:19, f3m:3, f1m:1, e12:42.1,e18:58.7,e24:78.5, e30:null},
    {name:'Yinus',             rating:'C', n:11, f3m:2, f1m:0, e12:90.9,e18:77.3,e24:60.0, e30:null},
    {name:'Ained',             rating:'C', n:15, f3m:2, f1m:1, e12:60.0,e18:75.0,e24:100.0,e30:null},
    {name:'Campsite',          rating:'C', n:5,  f3m:1, f1m:0, e12:60.0,e18:72.0,e24:90.0, e30:null},
    {name:'E-Com Growth Partners',rating:'D',n:19,f3m:3,f1m:1, e12:42.1,e18:48.3,e24:null, e30:null},
    {name:'Stemdo',            rating:'D', n:17, f3m:2, f1m:1, e12:36.3,e18:42.0,e24:null, e30:null},
    {name:'Id Bootcamps',      rating:'D', n:7,  f3m:1, f1m:0, e12:14.3,e18:38.5,e24:66.7, e30:null},
    {name:'Founder',           rating:'D', n:3,  f3m:1, f1m:0, e12:100.0,e18:100.0,e24:100.0,e30:100.0}
  ];
  // filter state: empty set = all selected
  window._emplFN =new Set(); // N total: 'lt30','30-50','gt50'
  window._emplFR =new Set(); // Ratings: 'A+','A','B','C','D'
  window._emplF3M=new Set(); // Fin. L3M: 'lt30','30-50','gt50'
  window._emplF1M=new Set(); // Fin. L1M: 'lt10','10-40','gt40'
  window._emplPeriod=12;     // active classification period: 12|18|24|30

  function nBucket(n){return n<30?'lt30':n<=50?'30-50':'gt50';}
  function b3m(v){return v<30?'lt30':v<=50?'30-50':'gt50';}
  function b1m(v){return v<10?'lt10':v<=40?'10-40':'gt40';}
  function passFilter(s){
    var okN  =window._emplFN.size===0  ||window._emplFN.has(nBucket(s.n));
    var okR  =window._emplFR.size===0  ||window._emplFR.has(s.rating);
    var ok3M =window._emplF3M.size===0 ||window._emplF3M.has(b3m(s.f3m));
    var ok1M =window._emplF1M.size===0 ||window._emplF1M.has(b1m(s.f1m));
    return okN&&okR&&ok3M&&ok1M;
  }
  function rP(r){return r?'<span class="r '+(RC[r]||'r-D')+'">'+r+'</span>':'<span style="color:#d1d5db">&#8212;</span>';}
  function dH(a,t){
    if(a===null)return '<span style="color:#d1d5db;font-size:11px">s/d</span>';
    var d=a-t,cls=d>=0?'pos':'neg',s=d>=0?'+':'',bar=Math.min(Math.abs(d)/30*100,100);
    return '<span class="dp '+cls+'">'+s+d.toFixed(1)+'pp</span>'
      +'<span class="ebar"><span class="efill" style="width:'+bar+'%;background:'+(d>=0?'#34d399':'#f87171')+'"></span></span>';
  }
  function fP(v){return v!==null?v.toFixed(1)+'%':'<span style="color:#d1d5db;font-style:italic;font-size:11px">s/d</span>';}
  function eVal(s,m){return {12:s.e12,18:s.e18,24:s.e24,30:s.e30}[m];}
  function isAb(s){var v=eVal(s,window._emplPeriod);return v!==null&&v!==undefined&&v>=T[window._emplPeriod][s.rating];}

  var w12=EMPL.filter(function(s){return s.e12!==null;});
  var avgE12=(w12.reduce(function(a,b){return a+b.e12;},0)/w12.length);
  var aboveAll=EMPL.filter(isAb);
  var belowAll=EMPL.filter(function(s){return!isAb(s);});

  var rboxH=RO.map(function(r){
    var g=EMPL.filter(function(s){return s.rating===r;});
    var gw12=g.filter(function(s){return s.e12!==null;});
    var gw24=g.filter(function(s){return s.e24!==null;});
    var avg12=gw12.length?(gw12.reduce(function(a,b){return a+b.e12;},0)/gw12.length):null;
    var avg24=gw24.length?(gw24.reduce(function(a,b){return a+b.e24;},0)/gw24.length):null;
    var ok12=g.filter(function(s){return s.e12!==null&&s.e12>=T[12][r];}).length;
    var t12=T[12][r],t24=T[24][r];
    var stat=function(lbl,val,cls){return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid #f3f4f6"><span style="font-size:11px;color:#9ca3af">'+lbl+'</span><span class="rsv '+cls+'" style="font-size:12px;font-weight:600">'+val+'</span></div>';};
    return '<div class="rbox">'+
      '<div class="rbox-head">'+rP(r)+'<div><div style="font-size:13px;font-weight:700">Rating '+r+'</div><div style="font-size:11px;color:#9ca3af">'+g.length+' escuelas</div></div></div>'+
      stat('Target 12m',t12+'%','')+stat('Media real 12m',avg12!==null?avg12.toFixed(1)+'%':'&#8212;',avg12!==null&&avg12>=t12?'ok':'ko')+
      stat('Target 24m',t24+'%','')+stat('Media real 24m',avg24!==null?avg24.toFixed(1)+'%':'&#8212;',avg24!==null&&avg24>=t24?'ok':'ko')+
      stat('Cumplen 12m',ok12+'/'+gw12.length,ok12===gw12.length?'ok':'ko')+'</div>';
  }).join('');

  var PERIODS=[12,18,24,30];
  var PBG={12:'#f0fdf4',18:'#fefce8',24:'#eff6ff',30:'#fdf4ff'};
  var PCL={12:'#f9fff9',18:'#fffef0',24:'#f0f7ff',30:'#fdf0ff'};

  function buildTH(){
    var cols='<thead><tr><th>Escuela</th><th>Rating</th>'+
      '<th style="text-align:right;background:#fafafa">Fin. L3M</th>'+
      '<th style="text-align:right;background:#fafafa">Fin. L1M</th>'+
      '<th style="text-align:right">N total</th>';
    PERIODS.forEach(function(m){
      var isActive=m===window._emplPeriod;
      var bdr=isActive?'border-bottom:2px solid #0d9488;':'';
      cols+='<th style="background:'+PBG[m]+';'+bdr+'">Empl. '+m+'m</th>'+
            '<th style="background:'+PBG[m]+'">Target</th>'+
            '<th style="background:'+PBG[m]+'">&#916; '+m+'m</th>';
    });
    return cols+'</tr></thead>';
  }

  function nCell(v){return '<td style="text-align:right;color:#374151;font-size:12px;font-weight:600;background:#fafafa">'+v+'</td>';}
  function mkRow(s){
    var cols='<tr>'+
      '<td style="font-weight:600">'+s.name+'</td><td>'+rP(s.rating)+'</td>'+
      nCell(s.f3m)+nCell(s.f1m)+
      '<td style="text-align:right;color:#9ca3af;font-size:12px">'+s.n+'</td>';
    PERIODS.forEach(function(m){
      var v=eVal(s,m),t=T[m][s.rating],bg=PCL[m];
      var isActive=m===window._emplPeriod;
      var fw=isActive?'font-weight:700;':'';
      cols+='<td style="background:'+bg+';'+fw+'">'+fP(v)+'</td>'+
            '<td style="background:'+bg+';color:#9ca3af">'+t+'%</td>'+
            '<td style="background:'+bg+'">'+dH(v,t)+'</td>';
    });
    return cols+'</tr>';
  }

  function chip(set,key,label,ac,ic){
    var act=set.has(key);
    return '<button onclick="window._emplToggle(&quot;'+ac+'&quot;,&quot;'+key+'&quot;)" style="padding:4px 11px;border-radius:20px;border:1.5px solid '+(act?ic:'#d1d5db')+';background:'+(act?ic+'22':'white')+';color:'+(act?ic:'#6b7280')+';font-size:11px;font-weight:600;cursor:pointer;margin-right:5px">'+label+'</button>';
  }
  function chipR(r){
    var act=window._emplFR.has(r);
    var bg={'A+':'#dbeafe','A':'#d1fae5','B':'#fef3c7','C':'#fee2e2','D':'#f3f4f6'}[r]||'#f3f4f6';
    var col={'A+':'#1d4ed8','A':'#065f46','B':'#92400e','C':'#991b1b','D':'#6b7280'}[r]||'#6b7280';
    return '<button onclick="window._emplToggle(&quot;R&quot;,&quot;'+r+'&quot;)" style="padding:4px 11px;border-radius:20px;border:1.5px solid '+(act?col:'#d1d5db')+';background:'+(act?bg:'white')+';color:'+(act?col:'#6b7280')+';font-size:11px;font-weight:700;cursor:pointer;margin-right:5px">'+r+'</button>';
  }
  function sep(){return '<div style="width:1px;height:20px;background:#e8eaf0;flex-shrink:0"></div>';}

  function filterBar(){
    return '<div style="display:flex;align-items:flex-start;gap:10px;background:white;border:1px solid #e8eaf0;border-radius:10px;padding:12px 16px;margin-bottom:16px;flex-wrap:wrap;row-gap:10px">'+
      '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">'+
        '<span style="font-size:10px;font-weight:700;color:#9ca3af;white-space:nowrap;letter-spacing:.4px">N TOTAL</span>'+
        chip(window._emplFN,'lt30','&lt; 30','N','#0d9488')+
        chip(window._emplFN,'30-50','30–50','N','#0d9488')+
        chip(window._emplFN,'gt50','&gt; 50','N','#0d9488')+
      '</div>'+
      sep()+
      '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">'+
        '<span style="font-size:10px;font-weight:700;color:#9ca3af;white-space:nowrap;letter-spacing:.4px">FIN. L3M</span>'+
        chip(window._emplF3M,'lt30','&lt; 30','3M','#7c3aed')+
        chip(window._emplF3M,'30-50','30–50','3M','#7c3aed')+
        chip(window._emplF3M,'gt50','&gt; 50','3M','#7c3aed')+
      '</div>'+
      sep()+
      '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">'+
        '<span style="font-size:10px;font-weight:700;color:#9ca3af;white-space:nowrap;letter-spacing:.4px">FIN. L1M</span>'+
        chip(window._emplF1M,'lt10','&lt; 10','1M','#ea580c')+
        chip(window._emplF1M,'10-40','10–40','1M','#ea580c')+
        chip(window._emplF1M,'gt40','&gt; 40','1M','#ea580c')+
      '</div>'+
      sep()+
      '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">'+
        '<span style="font-size:10px;font-weight:700;color:#9ca3af;white-space:nowrap;letter-spacing:.4px">RATING</span>'+
        RO.map(chipR).join('')+
      '</div>'+
      '<button onclick="window._emplReset()" style="margin-left:auto;font-size:11px;color:#9ca3af;background:none;border:none;cursor:pointer;text-decoration:underline;align-self:center">Limpiar</button>'+
    '</div>';
  }

  function periodSelector(){
    var btns=PERIODS.map(function(m){
      var act=m===window._emplPeriod;
      return '<button onclick="window._emplSetPeriod('+m+')" style="padding:5px 14px;border-radius:6px;border:none;background:'+(act?'#0d9488':'transparent')+';color:'+(act?'white':'#6b7280')+';font-size:12px;font-weight:'+(act?'700':'500')+';cursor:pointer">'+m+'m</button>';
    }).join('');
    return '<div style="display:inline-flex;align-items:center;gap:2px;background:#f3f4f6;border-radius:8px;padding:3px">'+btns+'</div>';
  }

  function renderTables(){
    var p=window._emplPeriod;
    var vis=EMPL.filter(passFilter);
    var ab=vis.filter(isAb).sort(function(a,b){
      var da=(eVal(b,p)||0)-T[p][b.rating], db=(eVal(a,p)||0)-T[p][a.rating];
      return da-db;
    });
    var bl=vis.filter(function(s){return!isAb(s);}).sort(function(a,b){
      return ((eVal(a,p)||0)-T[p][a.rating])-((eVal(b,p)||0)-T[p][b.rating]);
    });
    var TH=buildTH();
    var empty='<tr><td colspan="17" style="text-align:center;color:#9ca3af;padding:20px;font-style:italic">Sin resultados para los filtros seleccionados</td></tr>';
    document.getElementById('empl-above-badge').textContent=ab.length+' escuelas';
    document.getElementById('empl-below-badge').textContent=bl.length+' escuelas';
    document.getElementById('empl-above-desc').textContent='Empl. '+p+'m ≥ target del rating asignado';
    document.getElementById('empl-below-desc').textContent='Clasificación por Empl. '+p+'m · mayor brecha primero';
    document.getElementById('empl-above-body').innerHTML=ab.length?ab.map(mkRow).join(''):empty;
    document.getElementById('empl-below-body').innerHTML=bl.length?bl.map(mkRow).join(''):empty;
    document.getElementById('empl-above-thead').innerHTML=TH;
    document.getElementById('empl-below-thead').innerHTML=TH;
    document.getElementById('empl-filterbar').innerHTML=filterBar();
    document.getElementById('empl-period-sel').innerHTML=periodSelector();
  }

  window._emplToggle=function(type,key){
    var s={N:window._emplFN,R:window._emplFR,'3M':window._emplF3M,'1M':window._emplF1M}[type];
    if(s){if(s.has(key))s.delete(key);else s.add(key);}
    renderTables();
  };
  window._emplSetPeriod=function(p){window._emplPeriod=p;renderTables();};
  window._emplReset=function(){window._emplFN.clear();window._emplFR.clear();window._emplF3M.clear();window._emplF1M.clear();renderTables();};

  document.getElementById('content').innerHTML=
    '<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:9px 14px;margin-bottom:16px;font-size:11px;color:#92400e">&#9888; Datos mock &#8212; pendiente integraci&#243;n con BBDD de ratings y empleabilidad real</div>'+
    '<div class="kpis" style="grid-template-columns:repeat(5,1fr)">'+
      '<div class="kpi"><div class="l">Total escuelas</div><div class="v">'+EMPL.length+'</div></div>'+
      '<div class="kpi"><div class="l">En l&#237;nea / por encima</div><div class="v" style="color:#059669">'+aboveAll.length+'</div></div>'+
      '<div class="kpi"><div class="l">Por debajo objetivo</div><div class="v" style="color:#dc2626">'+belowAll.length+'</div></div>'+
      '<div class="kpi"><div class="l">Empl. media real 12m</div><div class="v" style="font-size:18px;color:#0d9488">'+avgE12.toFixed(1)+'%</div></div>'+
      '<div class="kpi"><div class="l">Benchmark target (B)</div><div class="v" style="font-size:18px;color:#0d9488">70%</div></div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px">'+rboxH+'</div>'+
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'+
      '<span style="font-size:12px;font-weight:600;color:#6b7280">Clasificar por periodo:</span>'+
      '<div id="empl-period-sel"></div>'+
    '</div>'+
    '<div id="empl-filterbar"></div>'+
    '<div class="tc" style="margin-bottom:16px;padding:0;overflow:hidden">'+
      '<div class="sec-hd"><span style="font-size:14px">&#10004;</span><span style="font-size:13px;font-weight:700">Por Encima o En L&#237;nea con el Objetivo</span><span class="sec-bg sec-g" id="empl-above-badge"></span><span style="font-size:11px;color:#9ca3af;margin-left:auto" id="empl-above-desc"></span></div>'+
      '<table id="empl-above-table"><thead id="empl-above-thead"></thead><tbody id="empl-above-body"></tbody></table></div>'+
    '<div class="tc" style="padding:0;overflow:hidden">'+
      '<div class="sec-hd"><span style="font-size:14px">&#9888;</span><span style="font-size:13px;font-weight:700">Por Debajo del Objetivo</span><span class="sec-bg sec-r" id="empl-below-badge"></span><span style="font-size:11px;color:#9ca3af;margin-left:auto" id="empl-below-desc"></span></div>'+
      '<table id="empl-below-table"><thead id="empl-below-thead"></thead><tbody id="empl-below-body"></tbody></table></div>';
  renderTables();
}

loadDash('${firstId}');


${user && user.isAdmin ? `
function loadSettings() {
  setActive('settings');
  document.getElementById('dashTitle').textContent = 'Ajustes';
  var c = document.getElementById('content');
  c.innerHTML = '<p style="color:#9ca3af;padding:16px">Cargando usuarios...</p>';
  fetch('/api/users', {credentials:'same-origin'})
    .then(function(r){ return r.json(); })
    .then(function(users) {
      var rows = users.map(function(u) {
        var d = new Date(u.created_at).toLocaleDateString('es-ES');
        var del = u.email === '${user.email}' ? '' :
          '<button onclick="deleteUser(\\'' + u.email + '\\')" style="background:#fee2e2;color:#be123c;border:none;border-radius:5px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer">Eliminar</button>';
        return '<tr><td style="font-weight:500">' + u.email + '</td><td>' + (u.is_admin ? '<span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">Admin</span>' : '<span style="color:#9ca3af;font-size:11px">Usuario</span>') + '</td><td style="color:#6b7280">' + d + '</td><td>' + del + '</td></tr>';
      }).join('');
      c.innerHTML =
        '<div class="tc" style="margin-bottom:20px"><div class="sec-hd" style="justify-content:space-between"><span style="font-size:13px;font-weight:700">Usuarios con acceso</span><span class="sec-bg sec-g">' + users.length + ' usuarios</span></div>' +
        '<table><thead><tr><th>Email</th><th>Rol</th><th>Alta desde</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="tc"><div class="sec-hd"><span style="font-size:13px;font-weight:700">Dar acceso</span></div>' +
        '<div style="padding:16px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">' +
        '<div><div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:4px">Email (@bcasapp.com)</div><input id="su-email" type="email" placeholder="nombre@bcasapp.com" style="border:1px solid #e5e7eb;border-radius:6px;padding:7px 11px;font-size:13px;min-width:240px;outline:none"></div>' +
        '<div><div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:4px">Contrase&#241;a inicial</div><input id="su-pwd" type="text" placeholder="contrase&#241;a temporal" style="border:1px solid #e5e7eb;border-radius:6px;padding:7px 11px;font-size:13px;min-width:180px;outline:none"></div>' +
        '<div style="display:flex;align-items:center;gap:6px;padding-bottom:1px"><input type="checkbox" id="su-admin"><label for="su-admin" style="font-size:12px;font-weight:600;color:#374151;cursor:pointer">Admin</label></div>' +
        '<button onclick="addUser()" style="background:#0d9488;color:#fff;border:none;border-radius:6px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer">A&#241;adir</button>' +
        '</div><div id="su-msg" style="padding:0 16px 12px;font-size:12px"></div></div>' +
        '<div class="tc" style="margin-top:20px"><div class="sec-hd"><span style="font-size:13px;font-weight:700">Cerrar sesi&#243;n</span></div>' +
        '<div style="padding:16px"><button onclick="doLogout()" style="background:#f3f4f6;color:#374151;border:none;border-radius:6px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer">Salir</button></div></div>';
    });
}
function deleteUser(email) {
  if (!confirm('Eliminar acceso a ' + email + '?')) return;
  fetch('/api/users', {method:'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})})
    .then(function(){ loadSettings(); });
}
function addUser() {
  var email = document.getElementById('su-email').value.trim();
  var pwd   = document.getElementById('su-pwd').value.trim();
  var admin = document.getElementById('su-admin').checked;
  var msg   = document.getElementById('su-msg');
  if (!email || !pwd) { msg.style.color='#be123c'; msg.textContent='Completa email y contrase&#241;a.'; return; }
  if (!email.endsWith('@bcasapp.com')) { msg.style.color='#be123c'; msg.textContent='Solo correos @bcasapp.com.'; return; }
  fetch('/api/users', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,pwd:pwd,isAdmin:admin})})
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { msg.style.color='#be123c'; msg.textContent=d.error; }
      else { loadSettings(); }
    });
}
function doLogout() {
  fetch('/api/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.reload();});
}
` : ''}`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Bcas Ops</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>${css}</style></head><body>
<div id="sb">
  <div class="sbh"><b>Bcas Ops</b><button class="sbt" onclick="toggleSb()">&#8942;</button></div>
  ${sidebarHtml}
</div>
<div id="main">
  <div class="top"><h1 id="dashTitle">Cargando...</h1><small>Actualizado: ${now}</small>${user ? `<span style="font-size:11px;color:#9ca3af;margin-left:auto">${user.email}</span>` : ''}</div>
  <div class="cnt" id="content"></div>
</div>
<script>${js}</script>
</body></html>`;
}

// =============================================================
// MAIN
// =============================================================
async function main() {
  console.log('\nBcas - Centro de Operaciones');
  console.log('─────────────────────────────');

  const dashData = {};
  for (const cfg of DASHBOARDS) {
    dashData[cfg.id] = await processDashboard(cfg);
  }

  console.log('\nGenerando HTML...');
  const now  = new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const html = buildHtml(dashData, now);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, html, 'utf8');
  const LOCAL = path.join(__dirname, 'ops_dashboard.html');
  fs.writeFileSync(LOCAL, html, 'utf8');
  console.log(`Dashboard guardado: ${OUTPUT}`);
  console.log(`Copia local:        ${LOCAL}`);

  // Open in browser (only locally)
  if (!process.env.VERCEL) {
    const { exec } = require('child_process');
    exec(`start "" "${OUTPUT}"`);
  }
  console.log('Listo.\n');
}

// CLI: node ops_dashboard.js
if (require.main === module) {
  main().catch(e => { console.error('Error:', e); process.exit(1); });
}

// Serverless handler (Vercel)
module.exports = async (req, res) => {
  const urlObj = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const p = urlObj.pathname;
  const method = req.method;

  try {
    await ensureUsersTable();
  } catch (e) {
    console.error('ensureUsersTable error:', e.message);
  }

  // ── GET /api/make-admin (one-time use — remove after use) ────
  if (p === '/api/make-admin') {
    await ensureUsersTable();
    await dbQuery(
      `INSERT INTO ops_users (email, password_hash, is_admin) VALUES ($1, $2, true)
       ON CONFLICT (email) DO UPDATE SET is_admin=true`,
      ['patricia.ais@bcasapp.com', (await dbQuery('SELECT password_hash FROM ops_users WHERE email=$1', ['patricia.ais@bcasapp.com']))[0]?.password_hash || 'x']
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, msg: 'patricia.ais@bcasapp.com is now admin' }));
    return;
  }

  // ── POST /api/login ──────────────────────────────────────────
  if (p === '/api/login' && method === 'POST') {
    const body = await parseFormBody(req);
    const email = (body.email || '').toLowerCase().trim();
    const pwd   = body.pwd || '';
    if (!email.endsWith('@bcasapp.com')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(buildLoginPage('Solo se permiten correos @bcasapp.com.'));
      return;
    }
    const rows = await dbQuery('SELECT * FROM ops_users WHERE email=$1', [email]);
    if (!rows.length || !verifyPassword(pwd, rows[0].password_hash)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(buildLoginPage('Email o contrase&#241;a incorrectos.'));
      return;
    }
    const token = signToken(email, rows[0].is_admin);
    res.setHeader('Set-Cookie', setCookieHeader(token));
    res.setHeader('Location', '/');
    res.statusCode = 302;
    res.end();
    return;
  }

  // ── POST /api/logout ─────────────────────────────────────────
  if (p === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', clearCookieHeader());
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }

  // ── Auth check ───────────────────────────────────────────────
  const user = getAuthUser(req);
  if (!user) {
    if (p.startsWith('/api/')) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'No autenticado' }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(buildLoginPage());
    return;
  }

  // ── GET /api/users ───────────────────────────────────────────
  if (p === '/api/users' && method === 'GET') {
    if (!user.isAdmin) { res.statusCode = 403; res.end('[]'); return; }
    const users = await dbQuery('SELECT email, is_admin, created_at FROM ops_users ORDER BY created_at');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(users));
    return;
  }

  // ── POST /api/users (add) ────────────────────────────────────
  if (p === '/api/users' && method === 'POST') {
    if (!user.isAdmin) { res.statusCode = 403; res.end('{}'); return; }
    const body = await readBody(req);
    const email   = (body.email || '').toLowerCase().trim();
    const pwd     = body.pwd || '';
    const isAdmin = !!body.isAdmin;
    if (!email.endsWith('@bcasapp.com') || !pwd) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Email inválido o contraseña vacía.' }));
      return;
    }
    try {
      await dbQuery(
        'INSERT INTO ops_users (email, password_hash, is_admin) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET password_hash=$2, is_admin=$3',
        [email, hashPassword(pwd), isAdmin]
      );
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── DELETE /api/users ────────────────────────────────────────
  if (p === '/api/users' && method === 'DELETE') {
    if (!user.isAdmin) { res.statusCode = 403; res.end('{}'); return; }
    const body = await readBody(req);
    const email = (body.email || '').toLowerCase().trim();
    if (email === user.email) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({error:'No puedes eliminarte a ti misma.'})); return; }
    await dbQuery('DELETE FROM ops_users WHERE email=$1', [email]);
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }

  // ── Main dashboard ───────────────────────────────────────────
  try {
    const dashData = {};
    for (const cfg of DASHBOARDS) {
      dashData[cfg.id] = await processDashboard(cfg);
    }
    const now = new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const html = buildHtml(dashData, now, user);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(html);
  } catch (e) {
    res.statusCode = 500;
    res.end(`<pre>Error: ${e.message}\n${e.stack}</pre>`);
  }
};
