// numero-a-letras.js — endpoint de utilería.
// La conversión vive en _letras.js y la usa _documentos.js directamente; este
// endpoint queda para pruebas y para integraciones externas autenticadas.
"use strict";
const L = require("./_lib.js");
const { enteroALetras } = require("./_letras.js");

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });
  const secreto = evento.headers["x-sscae-secreto"] || evento.headers["X-SSCAE-Secreto"];
  if (!secreto || !L.igualSeguro(secreto, process.env.UTILIDADES_SECRET || "")) {
    return L.json(401, { error: "No autorizado." });
  }
  let monto;
  try { monto = Number(JSON.parse(evento.body || "{}").monto); } catch { /* ignorar */ }
  if (!Number.isFinite(monto) || monto < 0 || monto > 999999999.99) {
    return L.json(400, { error: "Envía { monto: número } entre 0 y 999,999,999.99." });
  }
  const entero = Math.floor(monto);
  const centavos = Math.round((monto - entero) * 100);
  return L.json(200, {
    monto_letras: enteroALetras(monto),
    monto_numero: entero.toLocaleString("en-US") + "." + String(centavos).padStart(2, "0")
  });
};
