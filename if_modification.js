// =============================================================================
// BCAS – Calculadora de Modificación del Importe Financiado (IF)
// Solo préstamos PaP de Bcasfintech.
//
// Nueva operativa:
//   El préstamo se reconfigura como si se hubiera concedido por el NUEVO importe
//   desde el momento inicial, aplicando el coste por cuota del simulador PaP
//   (pap_percentage_installment_cost) sobre ese nuevo importe. Las cuotas ya
//   abonadas se descuentan del nuevo total a devolver y el saldo restante se
//   reparte entre las cuotas pendientes.
//
// El endpoint devuelve los datos base del préstamo; el cálculo para un nuevo
// importe concreto se hace en cliente (ver computeModIF más abajo, replicado en
// el dashboard) para permitir recálculo interactivo.
//
// Uso CLI:
//   node if_modification.js <loan_id> [nuevo_importe]
// =============================================================================

'use strict';

const Decimal = require('decimal.js');
const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

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

function d(v)  { return new Decimal(String(v)); }
function r2(x) { return parseFloat(d(x).toDecimalPlaces(2).toString()); }

// =============================================================================
// CAPA DE BASE DE DATOS
// =============================================================================
async function fetchLoanModData(loanId) {
  if (!process.env.DB_URL) throw new Error('DB_URL no configurado');

  const db = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    query_timeout:           25000,
  });
  await db.connect();

  try {
    const loanRes = await db.query(
      `SELECT
         loan_id,
         loan_type,
         loan_status,
         financier_name,
         total_amount_financed,
         pap_selected_installments,
         pap_percentage_installment_cost,
         pap_installment_cost,
         pap_installment_amount,
         pap_amount_loan_total_cost,
         pap_total_amount_to_return
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

    // ── Restricciones de scope ──────────────────────────────────────────────
    if (row.loan_type !== 'installment_payments') {
      const err = new Error(`La modificación de IF solo aplica a préstamos PaP (este es "${row.loan_type}")`);
      err.statusCode = 422;
      throw err;
    }
    if (!/^Bcasfintech/i.test(String(row.financier_name || ''))) {
      const err = new Error(`Solo se pueden modificar préstamos de Bcasfintech (financiador: "${row.financier_name || '—'}")`);
      err.statusCode = 422;
      throw err;
    }
    if (!row.pap_selected_installments || parseInt(row.pap_selected_installments, 10) < 1) {
      const err = new Error(`Préstamo "${loanId}" sin número de cuotas (pap_selected_installments)`);
      err.statusCode = 422;
      throw err;
    }

    const P_old = d(row.total_amount_financed);
    const N     = parseInt(row.pap_selected_installments, 10);
    const pct   = d(row.pap_percentage_installment_cost || 0);    // en %, p.ej. 0.80 = 0.80%
    const costeCuotaActual = d(row.pap_installment_cost || 0);

    // ¿El alumno asume el coste? (en algunos deals el coste lo asume la escuela
    // y pap_installment_cost = 0 aunque el % esté informado). Replicamos la
    // estructura real del préstamo original.
    const studentPaysCost = costeCuotaActual.greaterThan(0);

    // ── Cuotas ya abonadas (periódicas) ──────────────────────────────────────
    const paidRes = await db.query(
      `SELECT amount
       FROM payin_stats
       WHERE loan_id = $1
         AND payin_type = 'periodic'
         AND payin_status IN ('paid', 'compensated')`,
      [loanId]
    );
    const cuotasPagadas = paidRes.rows.length;
    const importePagado = paidRes.rows.reduce((acc, r) => acc.plus(d(r.amount)), d(0));

    return {
      loan_id:                  String(loanId),
      financier_name:           row.financier_name,
      loan_status:              row.loan_status,
      importe_financiado_actual: r2(P_old),
      num_cuotas:               N,
      pct_coste_cuota:          parseFloat(pct.toString()),       // 0.80 (%)
      student_paga_coste:       studentPaysCost,
      coste_cuota_actual:       r2(costeCuotaActual),
      cuota_actual:             r2(d(row.pap_installment_amount || 0)),
      total_coste_actual:       r2(d(row.pap_amount_loan_total_cost || 0)),
      total_devolver_actual:    r2(d(row.pap_total_amount_to_return || 0)),
      cuotas_pagadas:           cuotasPagadas,
      cuotas_pendientes:        N - cuotasPagadas,
      importe_pagado:           r2(importePagado),
    };
  } finally {
    await db.end();
  }
}

// =============================================================================
// CÁLCULO (también replicado en cliente para recálculo interactivo)
// =============================================================================
function computeModIF(base, nuevoImporte) {
  const A    = d(nuevoImporte);
  const N    = base.num_cuotas;
  const rate = base.student_paga_coste ? d(base.pct_coste_cuota).div(100) : d(0);

  const costeCuota   = A.mul(rate);                 // sin redondear
  const totalCoste   = costeCuota.mul(N);
  const totalDevolver= A.plus(totalCoste);
  const pagado       = d(base.importe_pagado);
  const saldoPend    = totalDevolver.minus(pagado);
  const nPend        = base.cuotas_pendientes;
  const nuevaCuota   = nPend > 0 ? saldoPend.div(nPend) : d(0);

  return {
    nuevo_importe_financiado: r2(A),
    coste_por_cuota:          r2(costeCuota),
    total_coste_financiero:   r2(totalCoste),
    total_a_devolver:         r2(totalDevolver),
    importe_pagado:           r2(pagado),
    saldo_pendiente:          r2(saldoPend),
    cuotas_pendientes:        nPend,
    nueva_cuota:              r2(nuevaCuota),
  };
}

// =============================================================================
// CLI
// =============================================================================
async function main() {
  const args   = process.argv.slice(2);
  const loanId = args[0];
  const nuevo  = args[1];
  if (!loanId) {
    console.error('Uso: node if_modification.js <loan_id> [nuevo_importe]');
    process.exit(1);
  }
  try {
    const base = await fetchLoanModData(loanId);
    console.log(JSON.stringify(base, null, 2));
    if (nuevo) {
      console.log('\n── Modificación a', nuevo, '€ ──');
      console.log(JSON.stringify(computeModIF(base, nuevo), null, 2));
    }
  } catch (err) {
    console.error(`Error${err.statusCode ? ' ' + err.statusCode : ''}: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
}

module.exports = { fetchLoanModData, computeModIF };
