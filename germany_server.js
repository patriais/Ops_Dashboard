// germany_server.js — Dashboard cartera Alemania (+ Portugal toggle)
// Uso: node germany_server.js  →  http://localhost:3032/germany

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const DB_URL = 'postgresql://javigonzalez:dpQD0mZZXalm6GnGCeqVrkNxwG3IoQQv@yamabiko.proxy.rlwy.net:45316/railway';
const PORT   = process.env.PORT || 3033;

const SCHOOLS_DE = [243, 244, 287, 208]; // Ironhack GER, Code University, LeWagonGer, Tomorrow
const SCHOOL_PT  = 412;                  // Ironhack Portugal
const ALL_SCHOOLS = [...SCHOOLS_DE, SCHOOL_PT];

// Statuses excluded from ALL metrics (solicitud cerrada + pendiente de firma)
const EXCL_SQL = `AND l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected')`;

const SCHOOL_NAMES = {
  243: 'Ironhack Germany',
  244: 'Code University',
  287: 'Le Wagon (GER)',
  208: 'Tomorrow',
  412: 'Ironhack Portugal',
};

function newClient() {
  return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

async function query(sql, params = []) {
  const db = newClient();
  await db.connect();
  try {
    const r = await db.query(sql, params);
    return r.rows;
  } finally {
    await db.end();
  }
}

// ── API handlers ─────────────────────────────────────────────────────────────

async function getKpiSummary() {
  return query(`
    SELECT
      l.school_id,
      l.loan_type,
      l.loan_status,
      COUNT(*)                                                          AS n,
      SUM(l.total_amount_financed)                                      AS financed,
      COALESCE(SUM(po_paid.disbursed), 0)                              AS disbursed,
      COALESCE(SUM(po_pend.pending), 0)                               AS pte_desembolso,
      COALESCE(SUM(paid.paid_amount), 0)                               AS recobrado,
      SUM(COALESCE(l.total_outstanding_balance, 0))                    AS pte_recobro
    FROM loan_stats l
    LEFT JOIN (
      SELECT ps.loan_id, SUM(ps.amount) AS paid_amount
      FROM payin_stats ps
      WHERE ps.payin_status = 'paid'
      GROUP BY ps.loan_id
    ) paid ON l.loan_id = paid.loan_id
    LEFT JOIN (
      SELECT loan_id, SUM(amount) AS disbursed
      FROM payout_stats WHERE status='paid' GROUP BY loan_id
    ) po_paid ON l.loan_id = po_paid.loan_id
    LEFT JOIN (
      SELECT loan_id, SUM(amount) AS pending
      FROM payout_stats WHERE status='pending' GROUP BY loan_id
    ) po_pend ON l.loan_id = po_pend.loan_id
    WHERE l.school_id = ANY($1) ${EXCL_SQL}
    GROUP BY l.school_id, l.loan_type, l.loan_status
    ORDER BY l.school_id, l.loan_type, l.loan_status
  `, [ALL_SCHOOLS]);
}

async function getKpis() {
  const rows = await query(`
    SELECT
      COUNT(*)                                                        AS total_ops,
      SUM(total_amount_financed)                                      AS total_financed,
      COUNT(*) FILTER (WHERE loan_status NOT IN (
        'closed_lost','withdrawal','request_rejected','condoned','amortized'
      ))                                                              AS cartera_viva_n,
      SUM(total_outstanding_balance) FILTER (WHERE loan_status NOT IN (
        'closed_lost','withdrawal','request_rejected','condoned','amortized'
      ))                                                              AS saldo_vivo,
      COUNT(*) FILTER (WHERE loan_status IN (
        'amortization_in_process','amortization_stalled'
      ))                                                              AS en_amortizacion,
      COUNT(*) FILTER (WHERE loan_status IN (
        'default_asnef','default_delinquency_warning'
      ))                                                              AS en_default,
      COUNT(*) FILTER (WHERE loan_type = 'isa')                      AS isa_n,
      COUNT(*) FILTER (WHERE loan_type = 'installment_payments')     AS pap_n,
      AVG(total_amount_financed)                                      AS avg_ticket
    FROM loan_stats WHERE school_id = ANY($1)
      AND loan_status NOT IN ('pending_sign','closed_lost','request_rejected')
  `, [ALL_SCHOOLS]);
  return rows[0];
}

async function getBySchool() {
  return query(`
    SELECT
      l.school_id,
      COUNT(*)                        AS n,
      SUM(l.total_amount_financed)    AS financed,
      SUM(COALESCE(l.total_outstanding_balance, 0)) AS outstanding,
      COUNT(*) FILTER (WHERE l.loan_status IN ('amortization_in_process','amortization_stalled')) AS en_amortizacion,
      COUNT(*) FILTER (WHERE l.loan_status IN ('default_asnef','default_delinquency_warning'))    AS en_default,
      COALESCE(SUM(paid.paid_amount), 0) AS recobrado
    FROM loan_stats l
    LEFT JOIN (
      SELECT ps.loan_id, SUM(ps.amount) AS paid_amount
      FROM payin_stats ps WHERE ps.payin_status = 'paid' GROUP BY ps.loan_id
    ) paid ON l.loan_id = paid.loan_id
    WHERE l.school_id = ANY($1) ${EXCL_SQL}
    GROUP BY l.school_id
    ORDER BY financed DESC
  `, [ALL_SCHOOLS]);
}

async function getByStatus() {
  return query(`
    SELECT school_id, loan_status, loan_type,
      COUNT(*) AS n, SUM(total_amount_financed) AS financed,
      SUM(total_outstanding_balance) AS outstanding
    FROM loan_stats WHERE school_id = ANY($1)
      AND loan_status NOT IN ('pending_sign','closed_lost','request_rejected')
    GROUP BY school_id, loan_status, loan_type ORDER BY n DESC
  `, [ALL_SCHOOLS]);
}

async function getMonthly() {
  return query(`
    SELECT school_id,
      TO_CHAR(DATE_TRUNC('month', concession_date), 'YYYY-MM') AS month,
      loan_type, COUNT(*) AS n, SUM(total_amount_financed) AS amount
    FROM loan_stats
    WHERE school_id = ANY($1) AND concession_date IS NOT NULL
      AND loan_status NOT IN ('pending_sign','closed_lost','request_rejected')
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  `, [ALL_SCHOOLS]);
}

async function getGraduation() {
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
    WHERE l.school_id = ANY($1) ${EXCL_SQL}
    GROUP BY l.school_id ORDER BY l.school_id
  `, [ALL_SCHOOLS]);
}

async function getPayins() {
  return query(`
    SELECT l.school_id, p.payin_status, COUNT(*) AS n, SUM(p.amount) AS total
    FROM payin_stats p
    JOIN loan_stats l ON p.loan_id = l.loan_id
    WHERE l.school_id = ANY($1)
      AND l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected')
    GROUP BY l.school_id, p.payin_status ORDER BY total DESC
  `, [ALL_SCHOOLS]);
}

async function getLoans({ school_ids, loan_type, loan_status, search, page, size }) {
  const ids = school_ids || ALL_SCHOOLS;
  const conds = [`l.school_id = ANY($1)`, `l.loan_status NOT IN ('pending_sign','closed_lost','request_rejected')`];
  const params = [ids];
  let pi = 2;

  if (loan_type && loan_type !== 'all') { conds.push(`l.loan_type = $${pi++}`); params.push(loan_type); }
  if (loan_status && loan_status !== 'all') { conds.push(`l.loan_status = $${pi++}`); params.push(loan_status); }
  if (search) {
    conds.push(`(l.email ILIKE $${pi} OR l.loan_id::text = $${pi} OR cs.name ILIKE $${pi})`);
    params.push(`%${search}%`); pi++;
  }

  const where = conds.join(' AND ');
  const pg = Math.max(1, parseInt(page) || 1);
  const sz = Math.min(100, parseInt(size) || 50);
  const offset = (pg - 1) * sz;

  const [countRow] = await query(
    `SELECT COUNT(*) AS total FROM loan_stats l
     LEFT JOIN course_stats cs ON l.course_id = cs.course_id WHERE ${where}`, params
  );

  params.push(sz, offset);
  const rows = await query(`
    SELECT l.loan_id, l.school_id, l.email, l.loan_type, l.loan_status,
      cs.name AS course,
      l.total_amount_financed, l.total_disbursement, l.total_outstanding_balance,
      l.concession_date
    FROM loan_stats l
    LEFT JOIN course_stats cs ON l.course_id = cs.course_id
    WHERE ${where}
    ORDER BY l.concession_date DESC NULLS LAST
    LIMIT $${pi} OFFSET $${pi + 1}
  `, params);

  return { total: parseInt(countRow.total), page: pg, size: sz, rows };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function err(res, e) {
  console.error(e);
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: e.message }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/germany') {
      const html = fs.readFileSync(path.join(__dirname, 'germany_dashboard.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // Expose school metadata to frontend
    if (p === '/api/meta') return json(res, { schools: SCHOOL_NAMES, de: SCHOOLS_DE, pt: SCHOOL_PT });

    if (p === '/api/kpi-summary') return json(res, await getKpiSummary());
    if (p === '/api/kpis')        return json(res, await getKpis());
    if (p === '/api/by-school')   return json(res, await getBySchool());
    if (p === '/api/status')      return json(res, await getByStatus());
    if (p === '/api/monthly')     return json(res, await getMonthly());
    if (p === '/api/payins')      return json(res, await getPayins());
    if (p === '/api/graduation')  return json(res, await getGraduation());

    if (p === '/api/loans') {
      const q = url.searchParams;
      const includePt = q.get('include_pt') !== 'false';
      const ids = includePt ? ALL_SCHOOLS : SCHOOLS_DE;
      return json(res, await getLoans({
        school_ids: ids,
        loan_type:   q.get('loan_type'),
        loan_status: q.get('loan_status'),
        search:      q.get('search'),
        page:        q.get('page'),
        size:        q.get('size'),
      }));
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    err(res, e);
  }
});

server.listen(PORT, () => {
  console.log(`✓ Germany dashboard → http://localhost:${PORT}/germany`);
});
