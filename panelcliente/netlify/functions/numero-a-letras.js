// numero-a-letras.js — convierte el saldo a su expresión con letra para el
// Pagaré ("OCHENTA MIL PESOS 00/100"). La llama Zapier (webhook) al armar el
// payload de Mifiel, autenticada con UTILIDADES_SECRET. Cero tareas extra si
// se invoca como paso Webhook dentro del mismo Zap de alta.
"use strict";
const L = require("./_lib.js");

const U = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE",
  "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIÚN", "VEINTIDÓS", "VEINTITRÉS",
  "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const D = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CEN = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
  "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function tresDigitos(n) {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100), resto = n % 100;
  let s = CEN[c];
  if (resto > 0) {
    if (s) s += " ";
    if (resto < 30) s += U[resto];
    else {
      s += D[Math.floor(resto / 10)];
      if (resto % 10) s += " Y " + U[resto % 10];
    }
  }
  return s;
}

function enteroALetras(n) {
  if (n === 0) return "CERO";
  let s = "";
  const millones = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1e3), resto = n % 1e3;
  if (millones) s += (millones === 1 ? "UN MILLÓN" : enteroALetras(millones) + " MILLONES");
  if (miles) s += (s ? " " : "") + (miles === 1 ? "MIL" : tresDigitos(miles) + " MIL");
  if (resto) s += (s ? " " : "") + tresDigitos(resto);
  return s;
}

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });
  const secreto = evento.headers["x-sscae-secreto"] || evento.headers["X-SSCAE-Secreto"];
  if (!secreto || secreto !== process.env.UTILIDADES_SECRET) return L.json(401, { error: "No autorizado." });

  let monto;
  try { monto = Number(JSON.parse(evento.body || "{}").monto); } catch { /* ignorar */ }
  if (!Number.isFinite(monto) || monto < 0 || monto > 999999999.99) {
    return L.json(400, { error: "Envía { monto: número } entre 0 y 999,999,999.99." });
  }
  const entero = Math.floor(monto);
  const centavos = Math.round((monto - entero) * 100);
  // Gramática cambiaria: "UN PESO", "VEINTIÚN PESOS", "UN MILLÓN DE PESOS",
  // "DOS MILLONES DE PESOS" (la preposición DE aparece en millones exactos).
  const palabraPesos = entero === 1 ? "PESO"
    : (entero >= 1e6 && entero % 1e6 === 0 ? "DE PESOS" : "PESOS");
  const letras = `${enteroALetras(entero)} ${palabraPesos} ${String(centavos).padStart(2, "0")}/100`;
  const numero = entero.toLocaleString("en-US") + "." + String(centavos).padStart(2, "0");
  return L.json(200, { monto_letras: letras, monto_numero: numero });
};
