// api/modify-if.js – Endpoint para la calculadora de Modificación de IF (PaP Bcasfintech)
// GET /api/modify-if?loan_id=<id>
// Devuelve los datos base del préstamo; el recálculo por nuevo importe se hace en cliente.
'use strict';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  try {
    const { fetchLoanModData } = require('../if_modification');

    const url    = new URL(req.url, 'http://localhost');
    const loanId = url.searchParams.get('loan_id');

    if (!loanId || !loanId.trim()) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Parámetro loan_id requerido' }));
    }

    const result = await fetchLoanModData(loanId.trim());
    res.statusCode = 200;
    res.end(JSON.stringify(result));

  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = err.statusCode || 500;
    }
    res.end(JSON.stringify({ error: err.message || 'Error interno del servidor' }));
  }
};
