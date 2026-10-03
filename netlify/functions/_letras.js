// _letras.js — conversión de importes a su expresión con letra para el Pagaré.
// Gramática cambiaria: "UN PESO", "VEINTIÚN PESOS", "UN MILLÓN DE PESOS".
// En un título de crédito esto no es cosmético: la cantidad con letra prevalece
// sobre la numérica en caso de discrepancia (art. 16 LGTOC).
"use strict";

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

function enteroPuro(n) {
  if (n === 0) return "CERO";
  let s = "";
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1e3);
  const resto = n % 1e3;
  if (millones) s += (millones === 1 ? "UN MILLÓN" : enteroPuro(millones) + " MILLONES");
  if (miles) s += (s ? " " : "") + (miles === 1 ? "MIL" : tresDigitos(miles) + " MIL");
  if (resto) s += (s ? " " : "") + tresDigitos(resto);
  return s;
}

// Devuelve la expresión completa: "OCHENTA MIL PESOS 00/100"
function enteroALetras(monto) {
  const n = Number(monto);
  if (!Number.isFinite(n) || n < 0) return "";
  const entero = Math.floor(n);
  const centavos = Math.round((n - entero) * 100);
  const palabra = entero === 1
    ? "PESO"
    : (entero >= 1e6 && entero % 1e6 === 0 ? "DE PESOS" : "PESOS");
  return `${enteroPuro(entero)} ${palabra} ${String(centavos).padStart(2, "0")}/100`;
}

module.exports = { enteroALetras, enteroPuro };
