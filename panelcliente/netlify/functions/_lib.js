// _lib.js — núcleo compartido del Panel del Cliente · SSCAE
// Principio de aislamiento (§3.2 del Pliego): cliente_id se deriva SIEMPRE de la
// sesión firmada, jamás de un parámetro del navegador. Toda consulta a Airtable
// incluye el filtro de cliente sin excepción.
"use strict";
const crypto = require("crypto");

const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.SESION_SECRET;

// ── Nombres exactos de tablas y campos (deben coincidir con Esquema_Campos_SSCAE.xlsx) ──
const T = {
  USUARIOS: "Usuarios de Panel",
  OPERACIONES: "Operaciones",
  CLIENTES: "Prospectos/Clientes"
};
const C = {
  // Usuarios de Panel
  U_NOMBRE: "Nombre", U_CLIENTE: "Cliente", U_ROL: "Rol",
  U_TEL: "Teléfono WhatsApp", U_CORREO: "Correo", U_ACTIVO: "Activo",
  U_HASH: "Código vigente (hash)", U_EXPIRA: "Código expira",
  U_ULTIMO: "Último acceso", U_INTENTOS: "Intentos fallidos",
  // Operaciones
  O_CLIENTE: "Cliente", O_FOLIO: "Folio", O_FOLIO_PG: "Folio Pagaré",
  O_FOLIO_CR: "Folio Constancia", O_SENTIDO: "Sentido",
  O_RESPONSABLE: "Responsable de venta",
  O_COMPRADOR: "Comprador · Nombre", O_COMPRADOR_RFC: "Comprador · RFC",
  O_COMPRADOR_TEL: "Comprador · Teléfono", O_COMPRADOR_CORREO: "Comprador · Correo",
  O_AVAL: "Aval · Nombre",
  O_TIPO: "Tipo de operación", O_DESC: "Descripción",
  O_CANTIDAD: "Cantidad y unidad", O_MONTO_TOTAL: "Monto total",
  O_ANTICIPO: "Monto anticipo", O_SALDO: "Saldo a crédito",
  O_F_CELEBRACION: "Fecha de celebración", O_F_ENTREGA: "Fecha entrega pactada",
  O_LUGAR_ENTREGA: "Lugar de entrega", O_PLAZO: "Plazo de crédito (días)",
  O_F_VENC: "Fecha de vencimiento",
  O_TASA_ORD: "Tasa ordinaria (% mensual)", O_TASA_MOR: "Tasa moratoria (% mensual)",
  O_ESTATUS_PAGO: "Estatus de pago",
  O_FICHA_FIRMA: "Ficha · Estatus firma", O_PAGARE_FIRMA: "Pagaré · Estatus firma",
  O_CONST_ESTATUS: "Constancia · Estatus",
  O_FICHA_MIFIEL: "Ficha · ID Mifiel", O_PAGARE_MIFIEL: "Pagaré · ID Mifiel",
  O_CONST_MIFIEL: "Constancia · ID Mifiel",
  O_EXPEDIENTE: "Expediente completo",
  O_MEDIO_COBRO: "Medio de cobro", O_FECHAS_CARGO: "Fechas de cargo",
  O_CARGOS_FALLIDOS: "Intentos de cargo fallidos",
  O_ESCROW_MODELO: "Modelo escrow", O_ESCROW_MONTO: "Monto escrow",
  O_BITACORA: "Bitácora",
  // Clientes
  CL_NOMBRE: "Nombre del negocio", CL_PAQUETE: "Paquete",
  CL_SUSCRIPCION: "Estatus suscripción", CL_LOGO: "Logotipo"
};

// ── Airtable ──
function escFormula(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

async function airtable(metodo, tabla, { id, params, cuerpo } = {}) {
  let url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(tabla)}`;
  if (id) url += `/${id}`;
  if (params) url += `?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  if (r.status === 429) throw Object.assign(new Error("limite"), { limite: true });
  if (!r.ok) throw new Error(`Airtable ${r.status}`);
  return r.json();
}

async function listar(tabla, filtro, campos, extra = {}) {
  const registros = [];
  let offset;
  do {
    const params = { filterByFormula: filtro, pageSize: "100", ...extra };
    campos.forEach((f, i) => { params[`fields[${i}]`] = f; });
    if (offset) params.offset = offset;
    const pagina = await airtable("GET", tabla, { params });
    registros.push(...pagina.records);
    offset = pagina.offset;
  } while (offset && registros.length < 500); // techo defensivo v1
  return registros;
}

// ── Sesión: token HMAC-SHA256 en cookie HttpOnly, vigencia 24 h (decisión §15.3) ──
const SESION_HORAS = 24;

function b64u(buf) { return Buffer.from(buf).toString("base64url"); }

function firmarSesion(datos) {
  const payload = b64u(JSON.stringify({ ...datos, exp: Date.now() + SESION_HORAS * 3600e3 }));
  const firma = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

function leerSesion(evento) {
  const cookies = evento.headers.cookie || evento.headers.Cookie || "";
  const m = /(?:^|;\s*)sscae_sesion=([^;]+)/.exec(cookies);
  if (!m) return null;
  const [payload, firma] = m[1].split(".");
  if (!payload || !firma) return null;
  const esperada = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const datos = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (!datos.exp || Date.now() > datos.exp) return null;
  return datos; // { u: usuarioId, c: clienteId, r: rol, n: nombre }
}

function cookieSesion(token) {
  const maxAge = token ? SESION_HORAS * 3600 : 0;
  return `sscae_sesion=${token || ""}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// Revalidación por petición (§4.3): Activo se verifica contra Airtable SIEMPRE.
async function usuarioVigente(sesion) {
  const reg = await airtable("GET", T.USUARIOS, { id: sesion.u }).catch(() => null);
  if (!reg || !reg.fields[C.U_ACTIVO]) return null;
  const clienteId = (reg.fields[C.U_CLIENTE] || [])[0];
  if (!clienteId || clienteId !== sesion.c) return null; // el cliente del token debe coincidir
  return { id: reg.id, rol: reg.fields[C.U_ROL] || "Dirección", nombre: reg.fields[C.U_NOMBRE] || "", clienteId };
}

// ── Filtro por rol (§5): siempre del lado del servidor ──
function filtroRol(rol, usuarioId) {
  switch (rol) {
    case "Ventas":
      return `FIND(${escFormula(usuarioId)}, ARRAYJOIN({${C.O_RESPONSABLE}} & ""))`;
    case "Compras":
      return `{${C.O_SENTIDO}} = 'Compra a proveedor'`;
    case "Cobranza":
      return `{${C.O_ESTATUS_PAGO}} != 'Liquidada'`;
    default:
      return "TRUE()";
  }
}

function filtroCliente(clienteId) {
  // El vínculo Cliente es de un solo registro; ARRAYJOIN lo vuelve comparable.
  return `FIND(${escFormula(clienteId)}, ARRAYJOIN({${C.O_CLIENTE}} & RECORD_ID()))`;
}

// Nota: FIND sobre ARRAYJOIN del linked field usa los NOMBRES, no los ids.
// Para comparar por id de registro vinculado, Airtable no expone el id del link en
// fórmulas directamente; la vía robusta es un campo de fórmula auxiliar en
// Operaciones:  {Cliente Id} = RECORD_ID() del registro vinculado vía lookup.
// Definido en el esquema como campo "Cliente Id" (lookup del RECORD_ID del cliente).
function filtroClientePorLookup(clienteId) {
  return `{Cliente Id} = ${escFormula(clienteId)}`;
}

// ── Semáforo (§7): calculado, nunca almacenado ──
function semaforo(op) {
  const estatus = op[C.O_ESTATUS_PAGO] || "Pendiente";
  if (estatus === "En disputa") return { clave: "disputa", etiqueta: "En disputa" };
  if (estatus === "Liquidada") return { clave: "liquidada", etiqueta: "Liquidada" };
  const venc = op[C.O_F_VENC];
  if (!venc) return { clave: "vigente", etiqueta: "Vigente" };
  // Comparación de fechas civiles en Querétaro (UTC-6 fijo): una operación
  // está vencida a partir del día natural SIGUIENTE a su fecha de vencimiento.
  const hoyQro = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  const dias = Math.round((Date.parse(venc) - Date.parse(hoyQro)) / 86400e3);
  if (dias < 0) return { clave: "vencida", etiqueta: "Vencida", diasMora: -dias };
  if (dias === 0) return { clave: "porvencer", etiqueta: "Vence hoy", diasRestantes: 0 };
  if (dias <= 7) return { clave: "porvencer", etiqueta: "Por vencer", diasRestantes: dias };
  return { clave: "vigente", etiqueta: "Vigente", diasRestantes: dias };
}

function expedienteIncompleto(op) {
  const pendiente = v => v && v !== "Firmada" && v !== "Registrada" && v !== "No aplica";
  return pendiente(op[C.O_FICHA_FIRMA]) || pendiente(op[C.O_PAGARE_FIRMA]) || pendiente(op[C.O_CONST_ESTATUS]);
}

// ── Respuestas: mensajes genéricos, nunca errores de Airtable al navegador (§8.1) ──
function json(status, cuerpo, headersExtra = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headersExtra },
    body: JSON.stringify(cuerpo)
  };
}

const ERROR_GENERICO = json(500, { error: "No fue posible completar la consulta. Intenta de nuevo en unos segundos." });
const NO_SESION = json(401, { error: "Tu sesión terminó. Vuelve a entrar." });

// Guardián estándar de endpoints autenticados
async function conSesion(evento, fn) {
  try {
    const sesion = leerSesion(evento);
    if (!sesion) return NO_SESION;
    const usuario = await usuarioVigente(sesion);
    if (!usuario) return json(401, { error: "El acceso fue desactivado. Contacta a tu administrador." }, { "Set-Cookie": cookieSesion(null) });
    return await fn(usuario);
  } catch (e) {
    if (e && e.limite) return json(503, { error: "El sistema está ocupado. Reintenta en un momento." });
    console.error(e.message);
    return ERROR_GENERICO;
  }
}

// Caché en memoria (60 s) para el resumen — sobrevive en instancias calientes
const cache = new Map();
function conCache(clave, ttlMs, calc) {
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return Promise.resolve(calc()).then(v => { cache.set(clave, { t: Date.now(), v }); return v; });
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

module.exports = {
  T, C, airtable, listar, escFormula,
  firmarSesion, leerSesion, cookieSesion, usuarioVigente,
  filtroRol, filtroClientePorLookup, semaforo, expedienteIncompleto,
  json, conSesion, conCache, sha256, ERROR_GENERICO
};
