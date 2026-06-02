// api/calculate.js – Serverless endpoint para la calculadora AA
// GET /api/calculate?loan_id=<id>
'use strict';

const { calcularAmortizacionAnticipada } = require('../aa_calculator');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  // Extraer loan_id de la query string
  const url    = new URL(req.url, 'http://localhost');
  const loanId = url.searchParams.get('loan_id');

  if (!loanId || !loanId.trim()) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Parámetro loan_id requerido' }));
  }

  try {
    const result = await calcularAmortizacionAnticipada(loanId.trim());
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
