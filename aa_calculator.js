// =============================================================================
// BCAS – Calculadora de Amortización Anticipada Total
// Versión 1.0  |  ISA estándar, esquema francés, sin AA parciales previas
//
// Uso como CLI:
//   node aa_calculator.js <loan_id>           → cálculo real (requiere BD)
//   node aa_calculator.js --test              → caso de prueba del spec §5
//
// Como módulo:
//   const { calcularAmortizacionAnticipada, calcularConDatos } = require('./aa_calculator');
// =============================================================================

'use strict';

const Decimal = require('decimal.js');
const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

// Alta precisión para evitar errores de redondeo acumulado
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

// ─── Cargar .env (entorno local) ──────────────────────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k && !process.env[k]) process.env[k] = v;
      }
    });
} catch { /* sin .env – ok en producción */ }

// ─── Parámetros operativos por defecto ────────────────────────────────────────
const DEFAULT_CONFIG = {
  STRIPE_PCT:      '0.0135',   // comisión Stripe por cobro
  LINEA_PCT_ANUAL: '0.06',     // TIN anual de la línea de crédito BCAS
  PAYMENT_METHOD:  'Stripe',   // método de pago AA: 'Stripe' | 'Transferencia' | 'Bizum' | 'Inespay'
  FECHA_HOY:       null,       // null = today() UTC; override en tests
};

// =============================================================================
// UTILIDADES
// =============================================================================

/** Crea un Decimal desde cualquier tipo (number, string, Decimal) */
function d(v) { return new Decimal(String(v)); }

/** Redondea a 2 decimales y devuelve número JS para el output */
function r2(dec) { return parseFloat(dec.toDecimalPlaces(2).toString()); }

/** Redondea a 6 decimales para tasas */
function r6(dec) { return parseFloat(dec.toDecimalPlaces(6).toString()); }

/** Normaliza una fecha a medianoche UTC */
function utcMid(dt) {
  const d2 = new Date(dt);
  d2.setUTCHours(0, 0, 0, 0);
  return d2;
}

/** Diferencia en días entre dos fechas (b − a), redondeada al entero más próximo */
function daysDiff(a, b) {
  return Math.round((utcMid(b) - utcMid(a)) / 86_400_000);
}

// =============================================================================
// NEWTON-RAPHSON: implementación de RATE(nper, pmt, pv)
//
// Resuelve la ecuación de la anualidad francesa:
//   pv = pmt × [1 − (1+r)^(−n)] / r
//
// Convenio BCAS: pmt > 0 (BCAS recibe cuotas), pv > 0 (capital prestado).
// Equivale a RATE(n, −pmt, pv) en Excel (Excel usa pmt negativo).
// =============================================================================
function calcRate(nper, pmt, pv, guess = 0.01, maxIter = 1000, tol = 1e-15) {
  // f(r)  = pv·r − pmt·[1 − (1+r)^(−n)]  = 0
  // f′(r) = pv   − pmt·n·(1+r)^(−n−1)
  let r = guess;
  for (let i = 0; i < maxIter; i++) {
    const invpow = 1 / Math.pow(1 + r, nper);          // (1+r)^(−n)
    const f      = pv * r - pmt * (1 - invpow);
    const df     = pv   - pmt * nper * invpow / (1 + r);
    const delta  = f / df;
    r -= delta;
    if (Math.abs(delta) < tol) break;
  }
  return r;
}

// =============================================================================
// CAPA DE BASE DE DATOS  –  esquema real BCAS
//
// Tablas: loan_stats  (1 fila por préstamo)
//         payin_stats (N filas por préstamo, 1 por cuota)
//
// loan_type = 'installment_payments' (PaP):
//   - pap_* campos contienen P, C y N listos para usar
//
// loan_type = 'isa' (ISA de reparto de ingresos):
//   - payin_stats.principal y .cost son siempre 0
//   - El plan mezcla payin_type='periodic' y 'simple' (migración histórica)
//   - P = total_disbursement; N = total de payins no cancelados; C = cuota − P/N
// =============================================================================

// Helper: mapear loan_status a estado normalizado
function mapEstado(status) {
  const ACTIVO  = new Set(['amortization_in_process', 'amortization_not_started', 'amortization_stalled']);
  const DEFAULT = new Set(['default_asnef', 'default_delinquency_warning', 'default_conciliation', 'unemployed_default']);
  if (ACTIVO.has(status))        return 'En amortización';
  if (DEFAULT.has(status))       return 'Default';
  return status;
}

async function fetchLoanData(loanId) {
  if (!process.env.DB_URL) throw new Error('DB_URL no configurado');

  const db = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,   // 10 s máx para conectar
    query_timeout:           25000,   // 25 s máx por query
  });
  await db.connect();

  try {
    // ── 1. Datos del préstamo ──────────────────────────────────────────────
    const loanRes = await db.query(
      `SELECT
         loan_id,
         loan_type,
         loan_status,
         total_amount_financed,
         total_disbursement,
         pap_selected_installments,
         pap_installment_cost,
         COALESCE(date_disbursement_1, concession_date) AS fecha_desembolso
       FROM loan_stats
       WHERE loan_id = $1`,
      [loanId]
    );

    if (loanRes.rows.length === 0) {
      const err = new Error(`Loan ID "${loanId}" no encontrado en la base de datos`);
      err.statusCode = 404;
      throw err;
    }
    const row = loanRes.rows[0];

    if (!row.fecha_desembolso) {
      const err = new Error(`Préstamo "${loanId}" sin fecha de desembolso (date_disbursement_1 y concession_date son nulos)`);
      err.statusCode = 422;
      throw err;
    }

    const estado_prestamo = mapEstado(row.loan_status);
    let importe_financiado, coste_por_cuota, num_total_cuotas, tipo_prestamo, cuotas_pagadas;

    // ══════════════════════════════════════════════════════════════════════
    // RAMA A: installment_payments (PaP)
    //   Todos los parámetros disponibles en pap_* de loan_stats.
    //   Las cuotas son siempre payin_type='periodic'.
    // ══════════════════════════════════════════════════════════════════════
    if (row.loan_type === 'installment_payments') {
      if (!row.pap_selected_installments) {
        const err = new Error(`PaP loan "${loanId}" sin número de cuotas (pap_selected_installments nulo)`);
        err.statusCode = 422;
        throw err;
      }
      tipo_prestamo      = 'PaP';
      num_total_cuotas   = parseInt(row.pap_selected_installments, 10);
      importe_financiado = d(row.total_amount_financed);

      // pap_installment_cost puede ser nulo en préstamos legacy: derivar de las cuotas reales
      if (row.pap_installment_cost && parseFloat(row.pap_installment_cost) > 0) {
        coste_por_cuota = d(row.pap_installment_cost);
      } else {
        // Fallback: C = cuota_pagada − P/N, tomada de la primera cuota periódica no cancelada
        const firstPayinRes = await db.query(
          `SELECT amount FROM payin_stats
           WHERE loan_id = $1 AND payin_type = 'periodic' AND payin_status != 'cancelled'
           ORDER BY theorical_date ASC LIMIT 1`,
          [loanId]
        );
        if (firstPayinRes.rows.length === 0) {
          const err = new Error(`PaP loan "${loanId}" sin cuotas periódicas para derivar coste`);
          err.statusCode = 422;
          throw err;
        }
        const cuota_ref = d(firstPayinRes.rows[0].amount);
        coste_por_cuota = cuota_ref.minus(importe_financiado.div(num_total_cuotas));
      }

      // Cuotas cobradas: sólo periódicas
      const paidRes = await db.query(
        `SELECT amount,
                COALESCE(collection_date, theorical_date) AS fecha_cobro
         FROM payin_stats
         WHERE loan_id = $1
           AND payin_type = 'periodic'
           AND payin_status IN ('paid', 'compensated')
         ORDER BY COALESCE(collection_date, theorical_date) ASC`,
        [loanId]
      );
      cuotas_pagadas = paidRes.rows;

    // ══════════════════════════════════════════════════════════════════════
    // RAMA B: isa (Income Share Agreement)
    //   El plan mezcla payin_type='periodic' y 'simple'; todos representan
    //   cuotas mensuales. N = total de payins no cancelados (ambos tipos).
    //   P = total_disbursement; C se deriva.
    // ══════════════════════════════════════════════════════════════════════
    } else if (row.loan_type === 'isa') {
      if (!row.total_disbursement || parseFloat(row.total_disbursement) === 0) {
        const err = new Error(`ISA loan "${loanId}" sin total_disbursement`);
        err.statusCode = 422;
        throw err;
      }
      tipo_prestamo    = 'ISA';
      importe_financiado = d(row.total_disbursement);

      // Plan completo: TODOS los payins no cancelados (periodic + simple)
      const allRes = await db.query(
        `SELECT amount
         FROM payin_stats
         WHERE loan_id = $1
           AND payin_status NOT IN ('cancelled', 'refunded')
         ORDER BY theorical_date ASC`,
        [loanId]
      );

      if (allRes.rows.length === 0) {
        const err = new Error(`ISA loan "${loanId}" sin cuotas en el plan`);
        err.statusCode = 422;
        throw err;
      }
      num_total_cuotas = allRes.rows.length;
      const amount_per_cuota = d(allRes.rows[0].amount);
      // cuota = P/N + C  →  C = cuota − P/N
      coste_por_cuota = amount_per_cuota.minus(importe_financiado.div(num_total_cuotas));

      // Cuotas cobradas: TODOS los tipos pagados (no sólo periodic)
      // Se excluyen las voluntarias para mantener coherencia con el cuadro de amortización
      const paidRes = await db.query(
        `SELECT amount,
                COALESCE(collection_date, theorical_date) AS fecha_cobro
         FROM payin_stats
         WHERE loan_id = $1
           AND payin_status IN ('paid', 'compensated')
           AND voluntary = false
         ORDER BY COALESCE(collection_date, theorical_date) ASC`,
        [loanId]
      );
      cuotas_pagadas = paidRes.rows;

    } else {
      const err = new Error(`Tipo de préstamo no soportado: "${row.loan_type}". Sólo se admiten 'isa' e 'installment_payments'`);
      err.statusCode = 422;
      throw err;
    }

    return {
      loan_id:            String(loanId),
      importe_financiado,
      coste_por_cuota,
      num_total_cuotas,
      fecha_desembolso:   utcMid(row.fecha_desembolso),
      tipo_prestamo,
      estado_prestamo,
      cuotas_pagadas:     cuotas_pagadas.map(r => ({
        fecha_cobro: utcMid(r.fecha_cobro),
        importe:     d(r.amount),
      })),
    };
  } finally {
    await db.end();
  }
}

// =============================================================================
// NÚCLEO DEL CÁLCULO
//
// Recibe datos ya cargados (pre-fetched) para poder testearse sin BD.
// =============================================================================
function calcularConDatos(data, cfg = {}) {
  const config = { ...DEFAULT_CONFIG, ...cfg };
  const STRIPE_PCT      = d(config.STRIPE_PCT);
  const LINEA_PCT_ANUAL = d(config.LINEA_PCT_ANUAL);
  const PAYMENT_METHOD  = config.PAYMENT_METHOD || 'Stripe';
  const FECHA_HOY       = utcMid(config.FECHA_HOY || new Date());

  // ── Validaciones ────────────────────────────────────────────────────────
  const errors = [];
  if (!['ISA', 'PaP'].includes(data.tipo_prestamo))
    errors.push({ code: 'UNSUPPORTED_TYPE', message: `Tipo de préstamo no soportado en este release: "${data.tipo_prestamo}"` });
  if (data.estado_prestamo === 'Default')
    errors.push({ code: 'DEFAULT_LOAN',     message: 'Préstamos en default requieren tratamiento legal, no AA' });
  if (data.num_total_cuotas < 2)
    errors.push({ code: 'MIN_CUOTAS',       message: 'El cálculo requiere al menos 2 cuotas en el plan' });
  if (data.cuotas_pagadas.length === 0)
    errors.push({ code: 'NO_PAYMENTS',      message: 'Sin cuotas pagadas; el importe a cobrar sería el principal completo (fuera de scope)' });
  if (data.cuotas_pagadas.length >= data.num_total_cuotas)
    errors.push({ code: 'FULLY_PAID',       message: 'El préstamo ya está totalmente pagado' });

  if (errors.length > 0) return { loan_id: data.loan_id, errors };

  // ── Ordenar cuotas por fecha real de cobro ─────────────────────────────
  const cuotas = [...data.cuotas_pagadas].sort((a, b) => a.fecha_cobro - b.fecha_cobro);
  const k      = cuotas.length;

  const P = data.importe_financiado;
  const C = data.coste_por_cuota;
  const N = data.num_total_cuotas;

  // ── Paso 1: TAE contractual ───────────────────────────────────────────
  //
  // Convención BCAS: desembolso + 1ª cuota = t=0
  // → préstamo de N cuotas se modela como anualidad de (N−1) periodos
  //   sobre un principal efectivo de (P − cuota_mensual)

  const cuota_mensual      = P.div(N).plus(C);          // PMT bruto
  const principal_efectivo = P.minus(cuota_mensual);    // PV efectivo
  const n_ef               = N - 1;                     // periodos efectivos

  const i_m_raw = calcRate(n_ef, cuota_mensual.toNumber(), principal_efectivo.toNumber());
  const i_m     = d(i_m_raw);   // tasa mensual implícita

  const TAE_contractual = i_m.plus(1).pow(12).minus(1);

  // ── Paso 2: Saldo bruto pendiente ─────────────────────────────────────
  //
  // FV(i_m, k-1, cuota, -P_ef): saldo del cuadro de amortización justo
  // después de la k-ésima cuota pagada. Sin capitalización adicional a hoy.
  //
  //   saldo(k) = P_ef·(1+i)^(k−1) − PMT·[(1+i)^(k−1) − 1] / i
  //
  // Cuando C ≈ 0 el solver devuelve i_m ≈ 0 y la fórmula de la anualidad
  // tendría 0/0. En ese límite degenera en amortización lineal: P − k·cuota.
  // Umbral: si |i_m| < 1e-9 se usa el modelo lineal.

  // ── Paso 2 + 4 combinados: iterar con importes REALES pagados ─────────
  //
  // Usando importes teóricos el saldo quedaría incorrecto si el estudiante
  // pagó más (o menos) que la cuota contractual. Se itera período a período
  // aplicando cada pago real para obtener el saldo pendiente correcto y los
  // intereses de línea devengados sobre ese saldo real.
  //
  // Período 1 (t=0): desembolso y primera cuota simultáneos; sin interés de línea.
  // Período j (j=2..k): interés = saldo_tras_período_anterior × (LINEA_PCT_ANUAL/12)
  //
  // saldo[0] = P − cuotas[0].importe
  // saldo[j] = saldo[j-1] × (1+i_m) − cuotas[j].importe   (j = 1..k-1)

  const tasa_linea_mensual = LINEA_PCT_ANUAL.div(12);
  let saldo_iter           = P.minus(cuotas[0].importe);   // tras primera cuota real
  let intereses_linea_pagados = d(0);

  for (let j = 1; j < k; j++) {
    intereses_linea_pagados = intereses_linea_pagados.plus(saldo_iter.mul(tasa_linea_mensual));
    saldo_iter = saldo_iter.mul(i_m.plus(1)).minus(cuotas[j].importe);
  }

  const saldo_bruto_hoy = saldo_iter;

  const fecha_ultima_cuota      = cuotas[k - 1].fecha_cobro;
  const dias_desde_ultima_cuota = daysDiff(fecha_ultima_cuota, FECHA_HOY);
  const dias_desde_desembolso   = daysDiff(data.fecha_desembolso, FECHA_HOY);

  // ── Paso 3: Stripe retenido en cuotas ya cobradas ─────────────────────
  // BCAS ya pagó esto a Stripe; no se recupera; se suma al importe AA.
  const stripe_retenido = cuotas.reduce(
    (acc, c) => acc.plus(c.importe.mul(STRIPE_PCT)),
    d(0)
  );

  // ── Paso 5: Importe neto y gross-up por método de pago ───────────────
  //
  // importe_neto = saldo bruto + costes ya incurridos por BCAS
  // Si el pago AA se procesa por Stripe, BCAS debe cubrir una comisión
  // adicional sobre el cobro (gross-up = importe_neto / (1 − STRIPE_PCT)).
  // Para otros métodos (Transferencia, Bizum, Inespay) no hay comisión AA.

  const importe_neto = saldo_bruto_hoy.plus(stripe_retenido).plus(intereses_linea_pagados);
  let importe_bruto, comision_pago_aa;
  if (PAYMENT_METHOD === 'Stripe') {
    importe_bruto    = importe_neto.div(d(1).minus(STRIPE_PCT));
    comision_pago_aa = importe_bruto.minus(importe_neto);
  } else {
    importe_bruto    = importe_neto;
    comision_pago_aa = d(0);
  }

  // ── Warnings ─────────────────────────────────────────────────────────
  const warnings = [];

  if (dias_desde_ultima_cuota > 30) {
    warnings.push(
      `Han pasado más de 30 días desde la última cuota (${dias_desde_ultima_cuota} días). ` +
      `Revisar si hay cuotas pendientes no contempladas.`
    );
  }

  const suma_real    = cuotas.reduce((a, c) => a.plus(c.importe), d(0));
  const suma_teorica = cuota_mensual.mul(k);
  const diff_cuotas  = suma_real.minus(suma_teorica).abs();
  if (diff_cuotas.greaterThan(d('0.01'))) {
    warnings.push(
      `Suma de cuotas pagadas (${r2(suma_real)}€) difiere del teórico ` +
      `(${r2(suma_teorica)}€) en ${r2(diff_cuotas)}€. ` +
      `Puede indicar regularizaciones o compensaciones.`
    );
  }

  const dias_1a_vs_desembolso = Math.abs(daysDiff(data.fecha_desembolso, cuotas[0].fecha_cobro));
  if (dias_1a_vs_desembolso > 7) {
    warnings.push(
      `El cálculo asume convención BCAS (1ª cuota a t=0). ` +
      `La 1ª cuota dista ${dias_1a_vs_desembolso} días del desembolso. Revisar el contrato.`
    );
  }

  // ── Resultado ─────────────────────────────────────────────────────────
  return {
    loan_id:                data.loan_id,
    fecha_calculo:          FECHA_HOY.toISOString().slice(0, 10),
    importe_bruto_a_cobrar: r2(importe_bruto),
    breakdown: {
      saldo_bruto_pendiente:   r2(saldo_bruto_hoy),
      stripe_retenido:         r2(stripe_retenido),
      intereses_linea_pagados: r2(intereses_linea_pagados),
      importe_neto_a_recibir:  r2(importe_neto),
      comision_pago_aa:        r2(comision_pago_aa),
    },
    metadata_calculo: {
      TAE_contractual:          r6(TAE_contractual),
      tasa_mensual_implicita:   r6(i_m),
      cuota_mensual:            r2(cuota_mensual),
      cuotas_pagadas:           k,
      cuotas_pendientes:        N - k,
      dias_desde_desembolso,
      dias_desde_ultima_cuota,
      metodo_pago:              PAYMENT_METHOD,
    },
    warnings,
  };
}

// =============================================================================
// API PÚBLICA
// =============================================================================

/** Calcula la AA total para un loan_id real (hace fetch de BD). */
async function calcularAmortizacionAnticipada(loanId, config = {}) {
  const data = await fetchLoanData(loanId);
  return calcularConDatos(data, config);
}

// =============================================================================
// TEST: caso de prueba del spec §5
// =============================================================================
function runTest() {
  const SEP = '═'.repeat(58);
  console.log('\n' + SEP);
  console.log('  TEST – Caso de prueba BCAS (spec §5)');
  console.log(SEP + '\n');

  const testData = {
    loan_id:            'TEST-001',
    importe_financiado: d('4840.02'),
    coste_por_cuota:    d('36.30'),
    num_total_cuotas:   18,
    fecha_desembolso:   utcMid('2026-05-25'),
    tipo_prestamo:      'ISA',
    estado_prestamo:    'En amortización',
    cuotas_pagadas: [
      { fecha_cobro: utcMid('2026-05-25'), importe: d('305.19') },
      { fecha_cobro: utcMid('2026-06-01'), importe: d('305.19') },
    ],
  };

  const testCfg = {
    STRIPE_PCT:      '0.0135',
    LINEA_PCT_ANUAL: '0.06',
    FECHA_HOY:       utcMid('2026-06-02'),
  };

  const res = calcularConDatos(testData, testCfg);
  console.log(JSON.stringify(res, null, 2));

  // ── Ground truth checks (valores del Excel 20260602_AA_PaP.xlsx) ────────
  const checks = [
    { label: 'TAE_contractual',          got: res.metadata_calculo.TAE_contractual,          exp: 0.2011,   tol: 0.001  },
    { label: 'tasa_mensual_implicita',   got: res.metadata_calculo.tasa_mensual_implicita,   exp: 0.015384, tol: 0.00005 },
    { label: 'cuota_mensual',            got: res.metadata_calculo.cuota_mensual,            exp: 305.19,   tol: 0.01   },
    { label: 'saldo_bruto_pendiente',    got: res.breakdown.saldo_bruto_pendiente,           exp: 4299.40,  tol: 0.10   },
    { label: 'stripe_retenido',          got: res.breakdown.stripe_retenido,                 exp: 8.24,     tol: 0.05   },
    { label: 'intereses_linea_pagados',  got: res.breakdown.intereses_linea_pagados,         exp: 22.67,    tol: 0.05   },
    { label: 'importe_neto_a_recibir',   got: res.breakdown.importe_neto_a_recibir,          exp: 4330.31,  tol: 0.15   },
    { label: 'comision_pago_aa',         got: res.breakdown.comision_pago_aa,                exp: 59.26,    tol: 0.20   },
    { label: 'importe_bruto_a_cobrar',   got: res.importe_bruto_a_cobrar,                    exp: 4389.58,  tol: 0.30   },
  ];

  console.log('\n── Verificación contra ground truth ──────────────────');
  let allOk = true;
  for (const c of checks) {
    const diff = Math.abs(c.got - c.exp);
    const ok   = diff <= c.tol;
    if (!ok) allOk = false;
    const icon = ok ? '✓' : '✗';
    console.log(
      `  ${icon} ${c.label.padEnd(28)} ` +
      `got=${String(c.got).padEnd(12)} exp≈${String(c.exp).padEnd(10)} diff=${diff.toFixed(6)}`
    );
  }
  console.log('\n  ' + (allOk ? '✅  Todos los checks pasan' : '❌  Algunos checks fallaron'));
  console.log(SEP + '\n');
}

// =============================================================================
// CLI
// =============================================================================
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    runTest();
    return;
  }

  const loanId = args[0];
  if (!loanId) {
    console.error('Uso:  node aa_calculator.js <loan_id>');
    console.error('      node aa_calculator.js --test');
    process.exit(1);
  }

  try {
    const result = await calcularAmortizacionAnticipada(loanId);
    console.log(JSON.stringify(result, null, 2));
    if (result.warnings?.length > 0) {
      console.error('\n⚠  Warnings:');
      result.warnings.forEach(w => console.error('   •', w));
    }
  } catch (err) {
    if (err.statusCode === 404) {
      console.error(`Error 404: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { calcularAmortizacionAnticipada, calcularConDatos, fetchLoanData };
