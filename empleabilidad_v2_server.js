// empleabilidad_v2_server.js — Empleabilidad 2.0: 6 methodologies from real SS data
// Reads from Postgres (same data as production liquidity-dashboard).
// Port: 3038
const http     = require('http');
const { Client } = require('pg');
const url      = require('url');
const fs       = require('fs');
const nodepath = require('path');

const DB_RAILWAY = 'postgresql://javigonzalez:dpQD0mZZXalm6GnGCeqVrkNxwG3IoQQv@yamabiko.proxy.rlwy.net:45316/railway';
const DB_HEROKU  = 'postgres://pati:pcc658e33840e497acfac36e4950d1f9e2430f5275b85471f8e5d0069e0f881d6@ec2-54-217-77-239.eu-west-1.compute.amazonaws.com:5432/ddrvmktb0a7mes';
const DB = process.env.DB_URL || DB_HEROKU;

// Load cohort_audit.sql — runs on Heroku which has the real log_bankflip + loan_payment
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
// Railway: identity (loan_stats with email), filters, school/financier names
const query = (sql, p) => queryDB(DB_RAILWAY, sql, p);
// Heroku: audit SQL (log_bankflip, full SS data)
const queryH = (sql, p) => queryDB(DB_HEROKU, sql, p);

// ── Identity: ISA loans from Postgres (mirrors cohort_identity.sql filters) ──
async function getIdentity() {
  return query(`
    SELECT
      ls.loan_id,
      ls.email,
      ls.school_id,
      ls.financier_id,
      NULL::numeric AS gross_monthly_salary_eur,
      FALSE         AS apo_si
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
        'antonio.charneco98@gmail.com',
        'ortizvelasco.pablo@gmail.com',
        'pablortizprom@gmail.com'
      )
      AND NOT (
        ls.email ILIKE '%prueba%'
        OR ls.email ILIKE '%demo%'
        OR ls.email ILIKE '%test%'
      )
  `);
}

async function getSchoolNames(schoolIds) {
  if (!schoolIds.length) return {};
  // Try course_stats first (has school_id + name). Fall back gracefully.
  const rows = await query(
    `SELECT school_id AS id, INITCAP(name) AS name FROM school_stats WHERE school_id = ANY($1::int[])`,
    [schoolIds]
  ).catch(() => []);
  const map = {};
  for (const r of rows) map[Number(r.id)] = r.name;
  for (const id of schoolIds) if (!map[id]) map[id] = `School ${id}`;
  return map;
}

// ── M1–M6 definitions at horizon H for a sorted per-person month history ──
// history = [{m, above (1/0/null), salary, threshold, alta (1/0/null), medible}] sorted by m asc
function computeMethodFlags(history, H) {
  const mH = history.find(r => r.m === H);
  if (!mH || !mH.medible) return null; // not in cohort

  const hist1H     = history.filter(r => r.m >= 1 && r.m <= H);
  const obsHist1H  = hist1H.filter(r => r.above !== null);
  const threshold  = mH.threshold;

  // M1 Tradicional: above_threshold at month H
  const M1 = mH.above === 1 ? 1 : 0;

  // M2 Continuada: max streak of above==1 in months 1..H >= 3
  let maxStreak = 0, streak = 0;
  for (const r of hist1H) {
    if (r.above === 1)      { streak++; if (streak > maxStreak) maxStreak = streak; }
    else if (r.above === 0) { streak = 0; }
    // NULL (unobservable) = skip, don't reset streak
  }
  const M2 = maxStreak >= 3 ? 1 : 0;

  // M3 Discontinuada: ≥6 months above threshold in rolling 12-month window [H-11, H]
  const win12start = Math.max(1, H - 11);
  const win12above = hist1H.filter(r => r.m >= win12start && r.above === 1).length;
  const M3 = win12above >= 6 ? 1 : 0;

  // M4 Acumulada: mean(effective_salary, observable months 1..H) >= threshold
  let M4 = 0;
  if (obsHist1H.length > 0) {
    const avg = obsHist1H.reduce((s, r) => s + r.salary, 0) / obsHist1H.length;
    M4 = avg >= threshold ? 1 : 0;
  }

  // M5 Carencia (K=3): rolling 3-month avg salary (months H-2..H, observable) >= threshold
  const win3 = history.filter(r => r.m >= Math.max(1, H - 2) && r.m <= H && r.above !== null);
  let M5 = 0;
  if (win3.length > 0) {
    const avg3 = win3.reduce((s, r) => s + r.salary, 0) / win3.length;
    M5 = avg3 >= threshold ? 1 : 0;
  }

  // M6 Promedio meses: ≥50% of observable months 1..H have active alta SS
  let M6 = 0;
  const obs6 = obsHist1H;
  if (obs6.length > 0) {
    const altaPct = obs6.filter(r => r.alta === 1).length / obs6.length;
    M6 = altaPct >= 0.5 ? 1 : 0;
  }

  return { M1, M2, M3, M4, M5, M6 };
}

const METHODS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

// ── Main computation from audit rows ──
function computeAll(auditRows) {
  // Group by loan_id
  const byLoan = new Map();
  for (const row of auditRows) {
    const lid = Number(row.loan_id);
    if (!byLoan.has(lid)) {
      byLoan.set(lid, {
        school_id:   Number(row.school_id),
        loan_status: row.loan_status,
        months: [],
      });
    }
    byLoan.get(lid).months.push({
      m:         Number(row.month_post_grad),
      medible:   Number(row.in_cohort_medible) === 1,
      above:     row.above_threshold === null ? null : Number(row.above_threshold),
      salary:    Number(row.effective_salary_eur   || 0),
      threshold: Number(row.threshold_eur_monthly  || 1416.67),
      alta:      row.has_active_alta_ss === null ? null : Number(row.has_active_alta_ss),
    });
  }
  for (const loan of byLoan.values()) loan.months.sort((a, b) => a.m - b.m);

  // Curve accumulators [37 horizons] for each method
  const curves = {};
  for (const m of METHODS) curves[m] = Array.from({ length: 37 }, (_, i) => ({ month: i, num: 0, den: 0 }));

  // By-school accumulators at H=12 and H=24
  const bySchool = new Map(); // school_id → { c12, c24, M1a12, M1a24, ..., M6a24 }

  let funnelMediable12 = 0, funnelAbove12 = 0;

  for (const [, loan] of byLoan) {
    const sid  = loan.school_id;
    const hist = loan.months;

    for (let H = 0; H <= 36; H++) {
      const flags = computeMethodFlags(hist, H);
      if (!flags) continue; // not in cohort at H

      for (const m of METHODS) {
        curves[m][H].num += flags[m];
        curves[m][H].den++;
      }

      if (H === 12 || H === 24) {
        if (!bySchool.has(sid)) {
          bySchool.set(sid, {
            c12: 0, c24: 0,
            a12: { M1:0, M2:0, M3:0, M4:0, M5:0, M6:0 },
            a24: { M1:0, M2:0, M3:0, M4:0, M5:0, M6:0 },
          });
        }
        const s = bySchool.get(sid);
        if (H === 12) { s.c12++; for (const m of METHODS) s.a12[m] += flags[m]; }
        if (H === 24) { s.c24++; for (const m of METHODS) s.a24[m] += flags[m]; }
      }
    }

    // Funnel: count persons with at least 1 observable month
    const anyMediable = hist.some(r => r.medible);
    if (anyMediable) {
      funnelMediable12++;
      const atMonth12 = computeMethodFlags(hist, 12);
      if (atMonth12 && atMonth12.M1 === 1) funnelAbove12++;
    }
  }

  // Format curves as pct arrays
  const formattedCurves = {};
  for (const m of METHODS) {
    formattedCurves[m] = curves[m].map(({ month, num, den }) => ({
      month,
      n:   den,
      pct: den > 0 ? Math.round(num / den * 1000) / 10 : null,
    }));
  }

  return { curves: formattedCurves, bySchoolRaw: bySchool, totalLoans: byLoan.size };
}

// ── In-memory cache (30 min TTL per filter combo) ──
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

async function getEmpleabilidad({ schoolId, financierId }) {
  const cacheKey = `${schoolId || '*'}:${financierId || '*'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  console.log(`[empleabilidad-v2] Fetching identity…`);
  const t0 = Date.now();
  const identity = await getIdentity();

  // Apply filters
  const filtered = identity.filter(r => {
    if (schoolId   && Number(r.school_id)    !== schoolId)    return false;
    if (financierId && Number(r.financier_id) !== financierId) return false;
    return true;
  });

  if (!filtered.length) throw new Error('No loans match the selected filters');

  const loanIds  = filtered.map(r => Number(r.loan_id));
  const emails   = filtered.map(r => r.email);
  const salaries = filtered.map(() => null);
  const apoSi    = filtered.map(() => false);

  console.log(`[empleabilidad-v2] Running audit SQL on ${loanIds.length} loans…`);
  const auditRows = await queryH(AUDIT_SQL, [loanIds, emails, salaries, null, apoSi]);
  console.log(`[empleabilidad-v2] Got ${auditRows.length} audit rows in ${Date.now() - t0}ms`);

  const { curves, bySchoolRaw, totalLoans } = computeAll(auditRows);

  // School names
  const schoolIds = [...bySchoolRaw.keys()];
  const schoolNames = await getSchoolNames(schoolIds);

  const r1 = (num, den) => den > 0 ? Math.round(num / den * 1000) / 10 : null;
  const bySchool = [...bySchoolRaw.entries()].map(([sid, s]) => ({
    school_id:   sid,
    school_name: schoolNames[sid] || `School ${sid}`,
    cohort_12:   s.c12,
    cohort_24:   s.c24,
    ...Object.fromEntries(METHODS.map(m => [`empl_12_${m.toLowerCase()}`, r1(s.a12[m], s.c12)])),
    ...Object.fromEntries(METHODS.map(m => [`empl_24_${m.toLowerCase()}`, r1(s.a24[m], s.c24)])),
  })).sort((a, b) => b.cohort_12 - a.cohort_12);

  // Funnel from M1 curve (use month=0 for total graduated)
  const m0 = curves.M1[0];
  const m12 = curves.M1[12];
  const funnel = {
    total_isa_loans: totalLoans,
    medible_m0:      m0.n,
    superan_umbral_m12: m12.n > 0
      ? Math.round(auditRows.filter(r => r.month_post_grad == 12 && r.above_threshold == 1).length)
      : 0,
    cohort_12: m12.n,
  };

  const data = {
    curves,
    bySchool,
    funnel,
    meta: {
      identity_rows: loanIds.length,
      audit_rows:    auditRows.length,
      duration_ms:   Date.now() - t0,
      as_of_date:    new Date().toISOString().split('T')[0],
    },
  };
  cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

// ── HTTP server ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const qs = parsed.query;

  try {
    if (p === '/' || p === '/empleabilidad_v2.html') {
      const html = fs.readFileSync(nodepath.join(__dirname, 'empleabilidad_v2.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(html);
    }

    if (p === '/api/empleabilidad') {
      const schoolId    = qs.school_id    ? Number(qs.school_id)    : null;
      const financierId = qs.financier_id ? Number(qs.financier_id) : null;
      const data = await getEmpleabilidad({ schoolId, financierId });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(data));
    }

    if (p === '/api/schools') {
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

    if (p === '/api/financiers') {
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

server.listen(3038, () => {
  console.log('[empleabilidad-v2] Listening on http://localhost:3038');
});
