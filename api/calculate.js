// api/calculate.js – Serverless endpoint para la calculadora AA
// GET /api/calculate?loan_id=<id>
'use strict';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  // Garantizar que SIEMPRE se envía una respuesta JSON, incluso ante errores de carga
  try {
    // require dentro del handler para que errores de carga sean capturados
    const { calcularAmortizacionAnticipada } = require('../aa_calculator');

    const url    = new URL(req.url, 'http://localhost');
    const loanId = url.searchParams.get('loan_id');

    if (!loanId || !loanId.trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Parámetro loan_id requerido' }));
    }

    const result = await calcularAmortizacionAnticipada(loanId.trim());
    res.statusCode = 200;
    res.end(JSON.stringify(result));

  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = err.statusCode || 500;
    }
    res.end(JSON.stringify({ error: err.message || 'Error interno del servidor' }));
  }
};
