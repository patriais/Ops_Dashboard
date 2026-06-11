// api/germany.js — Serverless function: Cartera Alemania + Portugal
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DB_URL      = process.env.DB_URL;
const HS_TOKEN    = process.env.HS_TOKEN;
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret-please-set-in-vercel';

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
    conds.push(`(l.email ILIKE $${pi} OR l.loan_id::text=$${pi} OR cs.name ILIKE $${pi})`);
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
    SELECT l.loan_id, l.school_id, l.email, l.loan_type, l.loan_status,
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
    if (p === '/api/hs-contact') {
      const email = url.searchParams.get('email');
      if (!email) return res.status(400).json({ error: 'email required' });
      return json(res, await getHsContact(email) || {});
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
