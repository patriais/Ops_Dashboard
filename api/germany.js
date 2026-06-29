// api/germany.js — Serverless function: Cartera Alemania + Portugal
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DB_URL      = process.env.DB_URL;
const HS_TOKEN    = process.env.HS_TOKEN;
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-please-set-in-vercel';

// ── Vista compartida (externa): gate por contraseña ──────────────────────────
// La cartera Alemania se comparte con terceros (p.ej. due diligence). Se protege
// con una contraseña única (env SHARE_PASSWORD) y se OCULTA toda PII de alumnos
// (emails + contacto). El detalle con PII vive en la plataforma interna.
const SHARE_PASSWORD = process.env.SHARE_PASSWORD || '';
const SHARE_TTL_MS = 7 * 24 * 3600 * 1000;

function signShare() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SHARE_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function isUnlocked(req) {
  const tok = parseCookies(req).share_tok;
  if (!tok) return false;
  const dot = tok.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = tok.slice(0, dot), sig = tok.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (sig !== expected) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}
function lockPage(error) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cartera Alemania · BCAS</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:36px 34px;width:340px;text-align:center}
.logo{width:46px;height:46px;background:#1e3a5f;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;margin:0 auto 16px}
h1{font-size:16px;font-weight:700;margin-bottom:4px}.sub{font-size:12px;color:#94a3b8;margin-bottom:22px}
input{width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:11px 13px;font-size:14px;color:#e2e8f0;outline:none;margin-bottom:12px}
input:focus{border-color:#3b82f6}button{width:100%;background:#3b82f6;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:700;color:#fff;cursor:pointer}
button:hover{background:#2563eb}.err{color:#f87171;font-size:12px;margin-bottom:10px;min-height:14px}</style></head>
<body><div class="box"><div class="logo">DE</div>
<h1>🇩🇪 Cartera Alemania · BCAS</h1><div class="sub">Acceso restringido — introduce la contraseña</div>
<div class="err">${error || ''}</div>
<input id="pw" type="password" placeholder="Contraseña" autofocus onkeydown="if(event.key==='Enter')go()">
<button onclick="go()">Acceder</button></div>
<script>
async function go(){const pw=document.getElementById('pw').value;
const r=await fetch('api/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pw})});
if(r.ok)location.reload();else{document.querySelector('.err').textContent='Contraseña incorrecta';}}
</script></body></html>`;
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
  const token = parseCookies(req).ops_tok;
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

const https = require('https');
function hsPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = require('https').request({
      hostname: 'api.hubapi.com', path, method: 'POST',
      headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function getHsContact(email) {
  if (!HS_TOKEN) return null;
  const r = await hsPost('/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['firstname', 'lastname', 'hs_linkedin_url'],
  });
  if (!r.results || !r.results[0]) return null;
  const p = r.results[0].properties;
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  const linkedin_url = p.hs_linkedin_url ||
    (name ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}` : null);
  return { name, linkedin_url };
}
const SCHOOLS_DE = [243, 244, 287, 208];
const SCHOOL_PT  = 412;
const ALL_SCHOOLS = [...SCHOOLS_DE, SCHOOL_PT];

// Excluded from ALL metrics: solicitud cerrada + pendiente de firma
const EXCL = `AND l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected')`;
const EXCL_BARE = `AND loan_status NOT IN ('pending_sign','closed_lost','request_rejected')`;

function newClient() {
  return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}
async function query(sql, params = []) {
  const db = newClient();
  await db.connect();
  try { return (await db.query(sql, params)).rows; }
  finally { await db.end(); }
}

async function getKpiSummary() {
  return query(`
    SELECT l.school_id, l.loan_type, l.loan_status,
      COUNT(*) AS n,
      SUM(l.total_amount_financed) AS financed,
      COALESCE(SUM(po_paid.disbursed),0) AS disbursed,
      COALESCE(SUM(po_pend.pending),0) AS pte_desembolso,
      COALESCE(SUM(paid.paid_amount),0) AS recobrado,
      SUM(COALESCE(l.total_outstanding_balance,0)) AS pte_recobro
    FROM loan_stats l
    LEFT JOIN (
      SELECT ps.loan_id, SUM(ps.amount) AS paid_amount
      FROM payin_stats ps WHERE ps.payin_status='paid' GROUP BY ps.loan_id
    ) paid ON l.loan_id = paid.loan_id
    LEFT JOIN (
      SELECT loan_id, SUM(amount) AS disbursed
      FROM payout_stats WHERE status='paid' GROUP BY loan_id
    ) po_paid ON l.loan_id = po_paid.loan_id
    LEFT JOIN (
      SELECT loan_id, SUM(amount) AS pending
      FROM payout_stats WHERE status='pending' GROUP BY loan_id
    ) po_pend ON l.loan_id = po_pend.loan_id
    WHERE l.school_id = ANY($1) ${EXCL}
    GROUP BY l.school_id, l.loan_type, l.loan_status
    ORDER BY l.school_id, l.loan_type, l.loan_status
  `, [ALL_SCHOOLS]);
}

async function getBySchool() {
  return query(`
    SELECT l.school_id,
      COUNT(*) AS n,
      SUM(l.total_amount_financed) AS financed,
      SUM(COALESCE(l.total_outstanding_balance,0)) AS outstanding,
      COUNT(*) FILTER (WHERE l.loan_status IN ('amortization_in_process','amortization_stalled')) AS en_amortizacion,
      COUNT(*) FILTER (WHERE l.loan_status IN ('default_asnef','default_delinquency_warning')) AS en_default,
      COALESCE(SUM(paid.paid_amount),0) AS recobrado
    FROM loan_stats l
    LEFT JOIN (
      SELECT ps.loan_id, SUM(ps.amount) AS paid_amount
      FROM payin_stats ps WHERE ps.payin_status='paid' GROUP BY ps.loan_id
    ) paid ON l.loan_id = paid.loan_id
    WHERE l.school_id = ANY($1) ${EXCL}
    GROUP BY l.school_id ORDER BY financed DESC
  `, [ALL_SCHOOLS]);
}

async function getStatus() {
  return query(`
    SELECT school_id, loan_status, loan_type,
      COUNT(*) AS n, SUM(total_amount_financed) AS financed,
      SUM(total_outstanding_balance) AS outstanding
    FROM loan_stats WHERE school_id = ANY($1) ${EXCL_BARE}
    GROUP BY school_id, loan_status, loan_type ORDER BY n DESC
  `, [ALL_SCHOOLS]);
}

async function getMonthly() {
  return query(`
    SELECT school_id,
      TO_CHAR(DATE_TRUNC('month', concession_date),'YYYY-MM') AS month,
      loan_type, COUNT(*) AS n, SUM(total_amount_financed) AS amount
    FROM loan_stats
    WHERE school_id = ANY($1) AND concession_date IS NOT NULL ${EXCL_BARE}
    GROUP BY 1,2,3 ORDER BY 1,2,3
  `, [ALL_SCHOOLS]);
}

async function getGraduation() {
  const EXCL_GRAD = `AND l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected','withdrawal')`;
  return query(`
    SELECT
      l.school_id,
      COUNT(*)                                                                                 AS total,
      COUNT(*) FILTER (WHERE l.course_end_date <= NOW())                                     AS graduated,
      COUNT(*) FILTER (WHERE l.course_end_date <= NOW()
        AND l.loan_status IN ('amortization_in_process','amortization_stalled','prepaid','amortized')) AS grad_paying,
      COUNT(*) FILTER (WHERE l.course_end_date <= NOW()
        AND l.loan_status NOT IN ('amortization_in_process','amortization_stalled','prepaid','amortized')) AS grad_not_paying,
      COUNT(*) FILTER (WHERE l.course_end_date > NOW() OR l.course_end_date IS NULL)         AS studying,
      COUNT(*) FILTER (WHERE (l.course_end_date > NOW() OR l.course_end_date IS NULL)
        AND l.loan_status IN ('amortization_in_process','amortization_stalled','prepaid','amortized')) AS study_paying,
      COUNT(*) FILTER (WHERE (l.course_end_date > NOW() OR l.course_end_date IS NULL)
        AND l.loan_status NOT IN ('amortization_in_process','amortization_stalled','prepaid','amortized')) AS study_not_paying
    FROM loan_stats l
    WHERE l.school_id = ANY($1) ${EXCL_GRAD}
    GROUP BY l.school_id ORDER BY l.school_id
  `, [ALL_SCHOOLS]);
}

async function getPayins() {
  return query(`
    SELECT l.school_id, p.payin_status, COUNT(*) AS n, SUM(p.amount) AS total
    FROM payin_stats p
    JOIN loan_stats l ON p.loan_id = l.loan_id
    WHERE l.school_id = ANY($1) ${EXCL}
    GROUP BY l.school_id, p.payin_status ORDER BY total DESC
  `, [ALL_SCHOOLS]);
}

async function getLoans({ loan_type, loan_status, graduated, search, page, size }) {
  const conds = [
    'l.school_id = ANY($1)',
    `l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected')`,
  ];
  const params = [ALL_SCHOOLS];
  let pi = 2;
  if (loan_type && loan_type !== 'all')     { conds.push(`l.loan_type=$${pi++}`);   params.push(loan_type); }
  if (loan_status && loan_status !== 'all') { conds.push(`l.loan_status=$${pi++}`); params.push(loan_status); }
  if (graduated === 'yes') conds.push(`l.course_end_date <= NOW()`);
  if (graduated === 'no')  conds.push(`(l.course_end_date > NOW() OR l.course_end_date IS NULL)`);
  if (search) {
    // Vista compartida: búsqueda sin email (PII). Solo por ID de préstamo o curso.
    conds.push(`(l.loan_id::text=$${pi} OR cs.name ILIKE $${pi})`);
    params.push(`%${search}%`); pi++;
  }
  const where = conds.join(' AND ');
  const pg = Math.max(1, parseInt(page)||1);
  const sz = Math.min(9999, parseInt(size)||50);
  const [countRow] = await query(
    `SELECT COUNT(*) AS total FROM loan_stats l LEFT JOIN course_stats cs ON l.course_id=cs.course_id WHERE ${where}`, params
  );
  params.push(sz, (pg-1)*sz);
  const rows = await query(`
    SELECT l.loan_id, l.school_id, l.loan_type, l.loan_status,
      cs.name AS course, l.total_amount_financed, l.total_disbursement,
      l.total_outstanding_balance, l.concession_date, l.course_end_date
    FROM loan_stats l LEFT JOIN course_stats cs ON l.course_id=cs.course_id
    WHERE ${where} ORDER BY l.concession_date DESC NULLS LAST
    LIMIT $${pi} OFFSET $${pi+1}
  `, params);
  return { total: parseInt(countRow.total), page: pg, size: sz, rows };
}

function json(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(data);
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const p = url.pathname.replace(/^\/escuelas\/cartera-alemania/, '') || '/';

  try {
    // ── Unlock: valida la contraseña compartida y emite cookie firmada ──
    if (p === '/api/unlock') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      if (!SHARE_PASSWORD) return res.status(503).json({ error: 'SHARE_PASSWORD no configurada' });
      let pw = '';
      try { pw = (JSON.parse((await readBody(req)) || '{}').pw) || ''; } catch { pw = ''; }
      if (pw !== SHARE_PASSWORD) return res.status(401).json({ error: 'invalid' });
      res.setHeader('Set-Cookie',
        `share_tok=${signShare()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SHARE_TTL_MS / 1000}`);
      return res.status(200).json({ ok: true });
    }

    // ── Gate: sin cookie válida no se sirve ni la página ni los datos ──
    if (!isUnlocked(req)) {
      if (p === '/' || p === '') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(lockPage());
      }
      return res.status(401).json({ error: 'locked' });
    }

    if (p === '/' || p === '') {
      const html = fs.readFileSync(path.join(__dirname, '..', 'germany_dashboard.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }
    if (p === '/api/kpi-summary') return json(res, await getKpiSummary());
    if (p === '/api/by-school')   return json(res, await getBySchool());
    if (p === '/api/status')      return json(res, await getStatus());
    if (p === '/api/monthly')     return json(res, await getMonthly());
    if (p === '/api/payins')      return json(res, await getPayins());
    if (p === '/api/graduation')  return json(res, await getGraduation());
    if (p === '/api/all') {
      const [summary, bySchool, status, monthly, payins, graduation, loans] = await Promise.all([
        getKpiSummary(), getBySchool(), getStatus(), getMonthly(), getPayins(), getGraduation(),
        getLoans({ page: 1, size: 50 }),
      ]);
      return json(res, { summary, bySchool, status, monthly, payins, graduation, loans });
    }
    // Contacto/PII deshabilitado en la vista compartida.
    if (p === '/api/hs-contact') {
      return res.status(403).json({ error: 'disabled in shared view' });
    }
    if (p === '/api/loans') {
      const q = url.searchParams;
      return json(res, await getLoans({
        loan_type:   q.get('loan_type'),
        loan_status: q.get('loan_status'),
        graduated:   q.get('graduated'),
        search:      q.get('search'),
        page:        q.get('page'),
        size:        q.get('size'),
      }));
    }
    res.status(404).send('Not found');
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
