// _liga.js — liga firmada para la contraparte deudora (§15.7 del Pliego).
// ════════════════════════════════════════════════════════════════════════════
// Sin sesión, sin usuario, sin contraseña. La liga es un token HMAC que contiene
// solo tres datos: el id del registro de la operación (o), un identificador de
// emisión (j) y la expiración (e). Todo lo demás se deriva en el servidor.
//
// "Un solo uso", en sentido operativo: cada operación tiene UNA liga vigente a la
// vez. Emitir una nueva (cada recordatorio lo hace) sustituye el jti guardado y
// deja sin efecto la anterior; vaciar el campo la revoca de inmediato; y caduca
// por tiempo. No se invalida al abrirla, porque el deudor necesita volver a ella
// después de pagar o si cierra la pantalla: una liga que muere al primer clic
// generaría precisamente la llamada de cobranza que queremos evitar.
//
// Aislamiento (§3.2): la liga solo puede revelar operaciones que compartan
// cliente acreedor Y RFC de la contraparte con la operación de origen. Ambos
// datos se leen del registro, nunca del navegador.
"use strict";
const L = require("./_lib.js");

const SECRETO = () => process.env.LIGA_SECRET;
// LIGA_VIGENCIA_DIAS: mínimo 8 porque la liga del recordatorio D-7 debe seguir
// viva al llegar el vencimiento (el D-0 emite otra). Máximo 60: después de eso
// la liga cubriría un periodo de mora en que ya corresponde el requerimiento
// formal, no un recordatorio. Valor inválido o fuera de rango → 20, con aviso.
const VIGENCIA_MIN = 8, VIGENCIA_MAX = 60, VIGENCIA_DEFAULT = 20;
function VIGENCIA_DIAS() {
  const crudo = process.env.LIGA_VIGENCIA_DIAS;
  if (crudo === undefined || crudo === "") return VIGENCIA_DEFAULT;
  const n = Number(String(crudo).trim());
  if (!Number.isInteger(n) || n < VIGENCIA_MIN || n > VIGENCIA_MAX) {
    console.warn(`LIGA_VIGENCIA_DIAS="${crudo}" fuera de rango (${VIGENCIA_MIN}–${VIGENCIA_MAX}); se usa ${VIGENCIA_DEFAULT}.`);
    return VIGENCIA_DEFAULT;
  }
  return n;
}

function urlBase() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || "";
}

// Emite una liga nueva y deja sin efecto la anterior.
async function emitirLiga(registro) {
  if (!SECRETO()) throw new Error("LIGA_SECRET no configurado");
  const jti = L.idCorto();
  const token = L.firmarToken({
    o: registro.id,
    j: jti,
    e: Date.now() + VIGENCIA_DIAS() * 86400e3
  }, SECRETO());
  await L.airtable("PATCH", L.T.OPERACIONES, {
    id: registro.id,
    cuerpo: { fields: { [L.C.O_LIGA_JTI]: jti } }
  });
  return { token, url: `${urlBase()}/c/${token}` };
}

const CAMPOS_OPERACION = () => [
  L.C.O_FOLIO, L.C.O_FOLIO_PG, L.C.O_FOLIO_CR, L.C.O_CLIENTE_ID,
  L.C.O_COMPRADOR, L.C.O_COMPRADOR_RFC, L.C.O_COMPRADOR_CORREO,
  L.C.O_DESC, L.C.O_CANTIDAD, L.C.O_MONTO_TOTAL, L.C.O_SALDO,
  L.C.O_F_VENC, L.C.O_TASA_MOR, L.C.O_ESTATUS_PAGO,
  L.C.O_FICHA_FIRMA, L.C.O_PAGARE_FIRMA, L.C.O_CONST_ESTATUS,
  L.C.O_SELLO_FICHA, L.C.O_SELLO_PAGARE, L.C.O_SELLO_CONST,
  L.C.O_F_RECEPCION, L.C.O_RECIBE,
  L.C.O_LIGA_JTI, L.C.O_LIGA_CONSULTA, L.C.O_BITACORA
];

// Resuelve el token a la operación de origen. Devuelve null ante CUALQUIER
// irregularidad (firma, expiración, revocación, sustitución): el llamador
// responde siempre lo mismo, sin distinguir la causa.
async function resolver(token) {
  const datos = L.leerToken(token, SECRETO());
  if (!datos || !datos.o || !datos.j) return null;
  if (!/^rec[A-Za-z0-9]{14}$/.test(datos.o)) return null;

  const reg = await L.airtable("GET", L.T.OPERACIONES, { id: datos.o }).catch(() => null);
  if (!reg) return null;
  const vigente = reg.fields[L.C.O_LIGA_JTI];
  if (!vigente || !L.igualSeguro(String(vigente), String(datos.j))) return null;

  const clienteId = (reg.fields[L.C.O_CLIENTE_ID] || [])[0];
  const rfc = reg.fields[L.C.O_COMPRADOR_RFC];
  if (!clienteId || !rfc) return null;
  return { registro: reg, clienteId, rfc };
}

// Otras operaciones abiertas de la MISMA contraparte con el MISMO acreedor.
async function operacionesDeLaContraparte(clienteId, rfc, excluirId) {
  const regs = await L.listar(L.T.OPERACIONES,
    `AND(${L.filtroClientePorLookup(clienteId)}, {${L.C.O_COMPRADOR_RFC}} = ${L.escFormula(rfc)}, {${L.C.O_ESTATUS_PAGO}} != 'Liquidada', {${L.C.O_SALDO}} > 0)`,
    CAMPOS_OPERACION(),
    { "sort[0][field]": L.C.O_F_VENC, "sort[0][direction]": "asc" });
  return regs.filter(r => r.id !== excluirId);
}

// Traducción del estado a lenguaje de deudor (sin jerga interna).
function estadoParaDeudor(f) {
  const s = L.semaforo(f);
  switch (s.clave) {
    case "liquidada": return { clave: "liquidada", texto: "Pagada. Gracias." };
    case "disputa":   return { clave: "disputa", texto: "En aclaración" };
    case "vencida":   return { clave: "vencida",
      texto: `Vencida hace ${s.diasMora} día${s.diasMora === 1 ? "" : "s"}` };
    case "porvencer": return { clave: "porvencer",
      texto: s.diasRestantes === 0 ? "Vence hoy" : `Vence en ${s.diasRestantes} día${s.diasRestantes === 1 ? "" : "s"}` };
    default:          return { clave: "vigente", texto: "Al corriente" };
  }
}

// Qué firmó la contraparte, expresado para ella. Solo estados y fechas; nunca
// identificadores internos de Mifiel ni la bitácora.
function documentos(f) {
  const docs = [];
  const firmado = v => v === "Firmada" || v === "Registrada";
  docs.push({
    nombre: "Ficha de Operación",
    firmado: firmado(f[L.C.O_FICHA_FIRMA]),
    constancia: !!f[L.C.O_SELLO_FICHA]
  });
  docs.push({
    nombre: `Pagaré ${f[L.C.O_FOLIO_PG] || ""}`.trim(),
    firmado: firmado(f[L.C.O_PAGARE_FIRMA]),
    constancia: !!f[L.C.O_SELLO_PAGARE]
  });
  if (f[L.C.O_CONST_ESTATUS] && f[L.C.O_CONST_ESTATUS] !== "No aplica") {
    docs.push({
      nombre: "Constancia de Recepción",
      firmado: firmado(f[L.C.O_CONST_ESTATUS]),
      constancia: !!f[L.C.O_SELLO_CONST],
      detalle: f[L.C.O_F_RECEPCION]
        ? `Mercancía recibida el ${f[L.C.O_F_RECEPCION]}${f[L.C.O_RECIBE] ? ` por ${f[L.C.O_RECIBE]}` : ""}`
        : null
    });
  }
  return docs;
}

function resumenOperacion(r) {
  const f = r.fields;
  return {
    folio: f[L.C.O_FOLIO] || "",
    descripcion: f[L.C.O_DESC] || "",
    cantidad: f[L.C.O_CANTIDAD] || "",
    montoTotal: f[L.C.O_MONTO_TOTAL] || 0,
    saldo: Math.max(0, f[L.C.O_SALDO] || 0),
    vencimiento: f[L.C.O_F_VENC] || null,
    tasaMoratoria: L.aPorcentaje(f[L.C.O_TASA_MOR]),
    estado: estadoParaDeudor(f)
  };
}

module.exports = {
  VIGENCIA_DIAS,
  emitirLiga, resolver, operacionesDeLaContraparte,
  resumenOperacion, documentos, estadoParaDeudor, urlBase
};
