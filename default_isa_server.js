// default_isa_server.js — Default ISA dashboard
// Reproduces the empleabilidad "default crédito" red line:
//   (cronograma − pagando) / cronograma   over OBLIGADOS CON COBRO ACTIVO
//   = (above & schedule_generated & !paying) / (above & schedule_generated)
// On top of the proven cohort_audit.sql pipeline (same as empleabilidad_v2),
// reconstructing schedule_generated in JS from Railway's MIN(created_at).
// Port: 3039
const http     = require('http');
const { Client } = require('pg');
const url      = require('url');
const fs       = require('fs');
const nodepath = require('path');

// Credenciales de BBDD: se leen de variables de entorno (definidas en un .env
// local, gitignoreado — NUNCA hardcodeadas/commiteadas). Mini-loader sin dependencias.
(() => {
  try {
    for (const line of fs.readFileSync(nodepath.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env: se espera que las vars vengan del entorno */ }
})();

const DB_RAILWAY = process.env.DB_RAILWAY;
const DB_HEROKU  = process.env.DB_HEROKU;
if (!DB_RAILWAY || !DB_HEROKU) {
  console.error('[default-isa] Faltan DB_RAILWAY / DB_HEROKU. Define un .env junto al server (ver .env.example).');
  process.exit(1);
}

const STATE_FILE = nodepath.join(__dirname, 'default_isa_state.json');

// Load cohort_audit.sql — runs on Heroku (real log_bankflip + loan_payment).
const AUDIT_SQL = fs.readFileSync(
  nodepath.join(__dirname, '..', 'liquidity-dashboard', 'queries', 'operations', 'empleabilidad', 'cohort_audit.sql'),
  'utf8'
);

async function queryDB(connStr, sql, params = []) {
  const client = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try   { return (await client.query(sql, params)).rows; }
  finally { await client.end(); }
}
const query  = (sql, p) => queryDB(DB_RAILWAY, sql, p); // identity, schedule_ym, payin detail
const queryH = (sql, p) => queryDB(DB_HEROKU,  sql, p); // audit SQL

// ── Categoría del deudor: labels (de pap-tracker/types.ts DB_STATUS_OPTIONS) ──
const DEUDOR_LABELS = {
  amortization_in_process:     'En amortización',
  default_delinquency_warning: 'Default — apercibimiento',
  default_litigation:          'Default — litigio',
  default_uncollectable:       'Default — incobrable',
};
const deudorLabel = (s) => DEUDOR_LABELS[s] || (s ? s.replace(/_/g, ' ') : '—');

// ── Identity: ISA loans (mirrors cohort_identity.sql filters, like empleab v2) ──
async function getIdentity() {
  return query(`
    SELECT ls.loan_id, ls.email, ls.school_id, ls.financier_id
    FROM loan_stats ls
    WHERE ls.loan_type = 'isa'
      AND ls.loan_status NOT IN (
        'pending_sign','closed_lost','request_rejected',
        'withdrawal','withdrawal_requested','condoned','transferred'
      )
      AND ls.course_end_date IS NOT NULL
      AND ls.course_end_date::date <= CURRENT_DATE
      AND ls.email IS NOT NULL
      AND ls.email NOT LIKE '%@bcasapp.com'
      AND ls.email NOT IN (
        'antonio.charneco98@gmail.com','ortizvelasco.pablo@gmail.com','pablortizprom@gmail.com'
      )
      AND NOT (ls.email ILIKE '%prueba%' OR ls.email ILIKE '%demo%' OR ls.email ILIKE '%test%')
  `);
}

async function getSchoolNames(schoolIds) {
  if (!schoolIds.length) return {};
  const rows = await query(
    `SELECT school_id AS id, INITCAP(name) AS name FROM school_stats WHERE school_id = ANY($1::int[])`,
    [schoolIds]
  ).catch(() => []);
  const map = {};
  for (const r of rows) map[Number(r.id)] = r.name;
  for (const id of schoolIds) if (!map[id]) map[id] = `School ${id}`;
  return map;
}

// schedule_ym por loan = YYYY-MM del primer payin creado (MIN created_at, solo Railway).
// Igual que el builder real (empleabilidad-cohort.ts). Marca "cobro activo".
async function getScheduleYm(loanIds) {
  const map = new Map();
  if (!loanIds.length) return map;
  const rows = await query(
    `SELECT loan_id::text AS loan_id, TO_CHAR(MIN(created_at), 'YYYY-MM') AS schedule_ym
       FROM payin_stats WHERE loan_id = ANY($1::bigint[]) AND created_at IS NOT NULL
       GROUP BY loan_id`,
    [loanIds]
  ).catch(() => []);
  for (const r of rows) map.set(Number(r.loan_id), r.schedule_ym);
  return map;
}

// Payins en claimed/failed agregados por loan (grupo B). Mirror de
// ops_isa_default_detail.sql + agregación estilo pap-tracker queryActivePapLoans.
// Corre en Heroku (DB operacional con las tablas raw loan/user/course/school).
async function getPayinDefaults() {
  const rows = await queryH(`
    WITH defaulted AS (
      SELECT
        ps.loan_id, ps.payin_id, ps.amount, ps.theorical_date, ps.payin_status, ps.provider,
        ls.loan_status, ls.school_id, ls.financier_id, u.email AS user_email,
        COALESCE(s.config->>'name', s.query_name, 'School ' || s.id) AS school_name
      FROM payin_stats ps
      JOIN loan_stats ls ON ls.loan_id = ps.loan_id
      JOIN loan       l  ON l.id       = ps.loan_id
      JOIN "user"     u  ON u.id       = l.user_id
      LEFT JOIN course c ON c.id       = l.course_id
      LEFT JOIN school s ON s.id       = ls.school_id
      WHERE ls.loan_type = 'isa'
        AND ps.payin_status IN ('claimed','failed')
        AND ls.course_end_date IS NOT NULL
        AND ps.loan_id NOT IN (9386, 9398)
        AND l.servicing IS NOT TRUE
        AND ls.loan_status NOT IN (
          'pending_sign','closed_lost','request_rejected','withdrawal','withdrawal_requested'
        )
        AND u.email NOT ILIKE '%@bcasapp.com'
        AND NOT (LOWER(CONCAT(
              COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''),' ',
              COALESCE(c.config->>'name',''),' ',COALESCE(s.config->>'name','')
            )) ~ '(test|demo|prueba)')
    )
    SELECT
      d.loan_id::text AS loan_id,
      MAX(d.user_email) AS email,
      MAX(d.loan_status) AS loan_status,
      MAX(d.school_id)::int AS school_id,
      MAX(d.financier_id)::int AS financier_id,
      MAX(d.school_name) AS school_name,
      COUNT(*) FILTER (WHERE d.payin_status = 'failed')::int  AS failed_count,
      COUNT(*) FILTER (WHERE d.payin_status = 'claimed')::int AS claimed_count,
      ROUND(SUM(d.amount)::numeric, 2) AS total_outstanding,
      MIN(d.theorical_date)::date AS earliest_theorical,
      MAX(d.theorical_date)::date AS latest_theorical,
      json_agg(json_build_object(
        'payin_id', d.payin_id::text,
        'amount', ROUND(d.amount::numeric, 2),
        'theorical_date', TO_CHAR(d.theorical_date::date, 'YYYY-MM-DD'),
        'status', d.payin_status,
        'provider', d.provider
      ) ORDER BY d.theorical_date NULLS LAST, d.payin_id) AS payins
    FROM defaulted d
    GROUP BY d.loan_id
  `);
  return rows;
}

// ── Core: run audit (optionally as_of past date) + compute everything ─────────
// Groups audit cells by loan, reconstructs schedule_generated, builds the
// red-line curve and per-loan current-state membership.
async function computeCore(asOfDate) {
  const identity = await getIdentity();
  const loanIds  = identity.map(r => Number(r.loan_id));
  const emails   = identity.map(r => r.email);
  const salaries = identity.map(() => null);
  const apoSi    = identity.map(() => false);

  const idById = new Map();
  for (const r of identity) idById.set(Number(r.loan_id), {
    email: r.email, school_id: r.school_id != null ? Number(r.school_id) : null,
    financier_id: r.financier_id != null ? Number(r.financier_id) : null,
  });

  const [scheduleByLoan, auditRows] = await Promise.all([
    getScheduleYm(loanIds),
    queryH(AUDIT_SQL, [loanIds, emails, salaries, asOfDate || null, apoSi]),
  ]);

  // Group cells by loan
  const byLoan = new Map();
  for (const row of auditRows) {
    const lid = Number(row.loan_id);
    if (!byLoan.has(lid)) {
      byLoan.set(lid, {
        loan_status: row.loan_status,
        school_id:   row.school_id != null ? Number(row.school_id) : null,
        email:       row.email,
        cells: [],
      });
    }
    byLoan.get(lid).cells.push({
      m:       Number(row.month_post_grad),
      period_ym: row.period_ym,
      medible: Number(row.in_cohort_medible) === 1,
      above:   row.above_threshold === null ? null : Number(row.above_threshold),
      paying:  Number(row.paying_this_period),
      alta:    row.has_active_alta_ss === null ? null : Number(row.has_active_alta_ss),
      rank:    row.empleabilidad_rank === null ? null : Number(row.empleabilidad_rank),
      salary:  Number(row.effective_salary_eur || 0),
      threshold: Number(row.threshold_eur_monthly || 1416.67),
      bucket:  row.bucket,
    });
  }
  for (const l of byLoan.values()) l.cells.sort((a, b) => a.m - b.m);

  // Per-loan: schedule_generated flag + latest observable cell + red-line membership
  const loanInfo = new Map(); // loan_id -> { ...current state, curveCells[] }

  for (const [lid, loan] of byLoan) {
    const sched = scheduleByLoan.get(lid) || null;
    const schedGen = (period_ym) => sched != null && period_ym >= sched;

    // Per-loan curve contributions (only "obligado con cobro activo" cells count
    // in the red-line denominator). Retained so curves can be rebuilt for any
    // filtered subset of loans without re-running the audit.
    const curveCells = [];
    for (const c of loan.cells) {
      if (!c.medible) continue;
      if (c.above === 1 && schedGen(c.period_ym)) {
        curveCells.push({ m: c.m, notPaying: c.paying === 0 });
      }
    }

    // Current state = latest OBSERVABLE month reached
    const obsCells = loan.cells.filter(c => c.medible);
    const last = obsCells.length ? obsCells[obsCells.length - 1] : null;
    // último salario accesible = último salario observable > 0 (o el del last cell)
    let ultimoSalario = null;
    for (let i = obsCells.length - 1; i >= 0; i--) {
      if (obsCells[i].salary > 0) { ultimoSalario = obsCells[i].salary; break; }
    }
    if (ultimoSalario == null && last) ultimoSalario = last.salary;

    const obligadoNow = last ? (last.above === 1 && schedGen(last.period_ym)) : false;
    const inDefaultRedline = obligadoNow && last.paying === 0;

    loanInfo.set(lid, {
      loan_id: lid,
      loan_status: loan.loan_status,
      email: loan.email || (idById.get(lid) || {}).email || null,
      school_id: loan.school_id != null ? loan.school_id : (idById.get(lid) || {}).school_id,
      financier_id: (idById.get(lid) || {}).financier_id ?? null,
      last_month: last ? last.m : null,
      empleabilidad_rank: last ? last.rank : null,
      bucket: last ? last.bucket : null,
      alta_ss: last ? last.alta : null,
      supera_umbral: last ? last.above : null,
      ultimo_salario: ultimoSalario,
      threshold: last ? last.threshold : null,
      obligado_cobro_activo: obligadoNow,
      in_default_redline: inDefaultRedline,
      curveCells,
    });
  }

  return { loanInfo, totalLoans: byLoan.size };
}

// Build the red-line curve (months 0..36) from a set of loanInfo entries.
function buildCurve(loanInfos) {
  const acc = Array.from({ length: 37 }, () => ({ den: 0, num: 0 }));
  for (const li of loanInfos) {
    for (const c of li.curveCells) {
      acc[c.m].den++;
      if (c.notPaying) acc[c.m].num++;
    }
  }
  return acc.map((c, m) => ({
    month: m, n: c.den,
    pct: c.den > 0 ? Math.round(c.num / c.den * 1000) / 10 : null,
  }));
}

// Cross-sectional aggregate (default rate at each loan's latest observable month).
function buildAgg(loanInfos) {
  let den = 0, num = 0;
  for (const li of loanInfos) {
    if (li.obligado_cobro_activo) { den++; if (li.in_default_redline) num++; }
  }
  return { pct: den > 0 ? Math.round(num / den * 1000) / 10 : null, headcount: num, base: den };
}

// ── JSON state persistence ───────────────────────────────────────────────────
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { loans: {}, snapshots: {} }; }
}
function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate + 'T00:00:00Z').getTime();
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((todayUtc - then) / 86400000));
}
function ymOf(d)        { return d.toISOString().slice(0, 7); }
function prevMonthYm(d) { return ymOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))); }
function lastDayPrevMonth(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return x.toISOString().slice(0, 10);
}

// ── In-memory cache (current run; 30 min TTL) ─────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
async function computeCoreCached(asOfDate) {
  const key = asOfDate || 'current';
  const c = cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  const data = await computeCore(asOfDate);
  cache.set(key, { ts: Date.now(), data });
  return data;
}

// ── Build the dashboard payload ──────────────────────────────────────────────
async function getDashboard({ schoolId, financierId }) {
  const core = await computeCoreCached(null);
  const state = readState();

  // Payin defaults (grupo B) — fresh from Railway, all ISA claimed/failed
  const payinRows = await getPayinDefaults();
  const payinById = new Map();
  for (const r of payinRows) payinById.set(Number(r.loan_id), r);

  const schoolIds = new Set();
  for (const li of core.loanInfo.values()) if (li.school_id != null) schoolIds.add(li.school_id);
  for (const r of payinRows) if (r.school_id != null) schoolIds.add(Number(r.school_id));
  const schoolNames = await getSchoolNames([...schoolIds]);

  // ── Merge into listado rows (union of group A red-line defaulters + group B) ──
  const rowsById = new Map();
  // Group A: red-line defaulters (obligado cobro activo & not paying)
  for (const li of core.loanInfo.values()) {
    if (!li.in_default_redline) continue;
    rowsById.set(li.loan_id, {
      loan_id: li.loan_id, email: li.email, loan_status: li.loan_status,
      school_id: li.school_id, financier_id: li.financier_id,
      grupoA: true, grupoB: false,
      empleabilidad_rank: li.empleabilidad_rank, bucket: li.bucket,
      alta_ss: li.alta_ss, supera_umbral: li.supera_umbral,
      ultimo_salario: li.ultimo_salario, threshold: li.threshold,
      last_month: li.last_month,
    });
  }
  // Group B: ISA loans with claimed/failed payins
  for (const r of payinRows) {
    const lid = Number(r.loan_id);
    let row = rowsById.get(lid);
    if (!row) {
      const li = core.loanInfo.get(lid);
      row = {
        loan_id: lid, email: r.email, loan_status: r.loan_status,
        school_id: r.school_id != null ? Number(r.school_id) : (li ? li.school_id : null),
        financier_id: r.financier_id != null ? Number(r.financier_id) : (li ? li.financier_id : null),
        grupoA: false, grupoB: true,
        empleabilidad_rank: li ? li.empleabilidad_rank : null, bucket: li ? li.bucket : null,
        alta_ss: li ? li.alta_ss : null, supera_umbral: li ? li.supera_umbral : null,
        ultimo_salario: li ? li.ultimo_salario : null, threshold: li ? li.threshold : null,
        last_month: li ? li.last_month : null,
      };
      rowsById.set(lid, row);
    } else {
      row.grupoB = true;
    }
    row.failed_count   = r.failed_count;
    row.claimed_count  = r.claimed_count;
    row.total_outstanding = Number(r.total_outstanding || 0);
    row.fecha_impago   = r.earliest_theorical ? new Date(r.earliest_theorical).toISOString().slice(0, 10) : null;
    row.payins         = r.payins || [];
  }

  // Finalize rows: filters, school name, PaP state, grupo label, days
  const stateLoans = state.loans || {};
  let rows = [...rowsById.values()].map(row => {
    const st = stateLoans[String(row.loan_id)] || {};
    const grupo = row.grupoA && row.grupoB ? 'ambos' : row.grupoA ? 'obligado' : 'payin';
    return {
      ...row,
      school_name: schoolNames[row.school_id] || (row.school_id != null ? `School ${row.school_id}` : '—'),
      grupo,
      failed_count: row.failed_count || 0,
      claimed_count: row.claimed_count || 0,
      total_outstanding: row.total_outstanding || 0,
      fecha_impago: row.fecha_impago || null,
      dias_impago: daysSince(row.fecha_impago || null),
      categoria_deudor: deudorLabel(row.loan_status),
      contacted: !!st.contacted,
      fecha_contacto: st.last_contact_date || null,
      dias_contacto: daysSince(st.last_contact_date || null),
      notas: st.comment || null,
    };
  });

  // Apply UI filters
  if (schoolId)    rows = rows.filter(r => r.school_id === schoolId);
  if (financierId) rows = rows.filter(r => r.financier_id === financierId);

  // Sort: most recent default first, then outstanding desc
  rows.sort((a, b) => {
    const fa = a.fecha_impago || '', fb = b.fecha_impago || '';
    if (fa !== fb) return fb.localeCompare(fa);
    return (b.total_outstanding || 0) - (a.total_outstanding || 0);
  });

  // ── Curve + metrics (filter-aware: rebuild over the filtered loan set) ──
  const allLoanInfos = [...core.loanInfo.values()];
  const filteredLoanInfos = (schoolId || financierId)
    ? allLoanInfos.filter(li => (!schoolId || li.school_id === schoolId) && (!financierId || li.financier_id === financierId))
    : allLoanInfos;
  const curve = buildCurve(filteredLoanInfos);
  const metrics = {
    m12: curve[12] ? curve[12].pct : null,
    m24: curve[24] ? curve[24].pct : null,
    m30: curve[30] ? curve[30].pct : null,
  };

  // ── Monthly benchmark box (portfolio-level, ignores UI filters) ──
  const globalAgg = buildAgg(allLoanInfos);
  const now = new Date();
  const curYm = ymOf(now), prevYm = prevMonthYm(now);
  let prev = (state.snapshots || {})[prevYm] || null;
  if (!prev) {
    // Bootstrap: compute prior month with as_of = last day of previous month.
    try {
      const prevCore = await computeCoreCached(lastDayPrevMonth(now));
      const prevAgg = buildAgg([...prevCore.loanInfo.values()]);
      prev = { pct: prevAgg.pct, headcount: prevAgg.headcount, base: prevAgg.base,
               captured_at: new Date().toISOString(), auto: true };
      const s = readState();
      s.snapshots = s.snapshots || {};
      s.snapshots[prevYm] = prev;
      writeState(s);
    } catch (e) { console.warn('[default-isa] prev snapshot bootstrap failed:', e.message); }
  }
  const monthBox = {
    current_ym: curYm,
    current: { pct: globalAgg.pct, headcount: globalAgg.headcount, base: globalAgg.base },
    prev_ym: prevYm,
    prev: prev ? { pct: prev.pct, headcount: prev.headcount, base: prev.base } : null,
    delta_pct:       prev && globalAgg.pct != null && prev.pct != null ? Math.round((globalAgg.pct - prev.pct) * 10) / 10 : null,
    delta_headcount: prev && prev.headcount != null ? globalAgg.headcount - prev.headcount : null,
  };

  return {
    curve, metrics, monthBox, rows,
    meta: {
      total_isa_loans: core.totalLoans,
      n_obligados_cobro_activo: globalAgg.base,
      n_default_redline: globalAgg.headcount,
      n_listado: rows.length,
      as_of_date: now.toISOString().slice(0, 10),
      filtered: !!(schoolId || financierId),
    },
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const qs = parsed.query;

  try {
    if (p === '/' || p === '/default_isa.html') {
      const html = fs.readFileSync(nodepath.join(__dirname, 'default_isa.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(html);
    }

    if (p === '/api/isa-default' && req.method === 'GET') {
      const schoolId    = qs.school_id    ? Number(qs.school_id)    : null;
      const financierId = qs.financier_id ? Number(qs.financier_id) : null;
      const data = await getDashboard({ schoolId, financierId });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(data));
    }

    if (p === '/api/isa-default/schools') {
      const rows = await query(`
        SELECT ls.school_id, INITCAP(COALESCE(ss.name, ls.school_id::text)) AS name, COUNT(*) AS n
        FROM loan_stats ls
        LEFT JOIN school_stats ss ON ss.school_id = ls.school_id
        WHERE ls.loan_type = 'isa'
          AND ls.loan_status NOT IN ('pending_sign','closed_lost','request_rejected','withdrawal','withdrawal_requested','condoned','transferred')
          AND ls.course_end_date IS NOT NULL AND ls.course_end_date::date <= CURRENT_DATE
          AND ls.email NOT LIKE '%@bcasapp.com'
        GROUP BY ls.school_id, ss.name ORDER BY n DESC
      `);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(rows));
    }

    if (p === '/api/isa-default/financiers') {
      const rows = await query(`
        SELECT ls.financier_id, COALESCE(fs.name, ls.financier_id::text) AS name, COUNT(*) AS n
        FROM loan_stats ls
        LEFT JOIN financier_stats fs ON fs.financier_id = ls.financier_id
        WHERE ls.loan_type = 'isa'
          AND ls.loan_status NOT IN ('pending_sign','closed_lost','request_rejected','withdrawal','withdrawal_requested','condoned','transferred')
          AND ls.course_end_date IS NOT NULL AND ls.course_end_date::date <= CURRENT_DATE
          AND ls.email NOT LIKE '%@bcasapp.com'
        GROUP BY ls.financier_id, fs.name ORDER BY n DESC
      `);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(rows));
    }

    if (p === '/api/isa-default/state' && req.method === 'PATCH') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { loanId, contacted, lastContactDate, comment } = JSON.parse(body || '{}');
          if (loanId == null) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'loanId required' })); }
          const state = readState();
          state.loans = state.loans || {};
          const key = String(loanId);
          const cur = state.loans[key] || {};
          if (contacted !== undefined)        cur.contacted = !!contacted;
          if (lastContactDate !== undefined)  cur.last_contact_date = lastContactDate || null;
          if (comment !== undefined)          cur.comment = comment || null;
          cur.updated_at = new Date().toISOString();
          state.loans[key] = cur;
          writeState(state);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, loan: cur }));
        } catch (e) {
          res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (p === '/api/isa-default/snapshot/capture' && req.method === 'POST') {
      const core = await computeCoreCached(null);
      const agg = buildAgg([...core.loanInfo.values()]);
      const now = new Date();
      const ym = ymOf(now);
      const state = readState();
      state.snapshots = state.snapshots || {};
      state.snapshots[ym] = {
        pct: agg.pct, headcount: agg.headcount, base: agg.base,
        captured_at: now.toISOString(),
      };
      writeState(state);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, ym, snapshot: state.snapshots[ym] }));
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(3039, () => {
  console.log('[default-isa] Listening on http://localhost:3039');
});
