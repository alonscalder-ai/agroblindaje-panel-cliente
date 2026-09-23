// _lib.js — núcleo compartido del Panel del Cliente · SSCAE (arquitectura v2)
// Aislamiento (§3.2 del Pliego): cliente_id se deriva SIEMPRE de la sesión
// firmada, jamás de un parámetro del navegador. Toda consulta a Airtable
// incluye el filtro de cliente sin excepción.
"use strict";
const crypto = require("crypto");

const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const SECRET = process.env.SESION_SECRET;

// ── Nombres exactos de tablas (verificados contra la base) ──
// Se usan los IDs de tabla, no los nombres: la API de Airtable resuelve los
// nombres de forma exacta ("Prospectos / Clientes" lleva espacios alrededor de
// la diagonal) y un renombrado rompería todas las consultas. Los IDs no cambian.
const T = {
  USUARIOS: "tblyzmVinhJHd5wEO",      // Usuarios de Panel
  OPERACIONES: "tblYeAJM66hAyPsOH",   // Operaciones
  CLIENTES: "tbl5rsguvlFosFwS7",      // Prospectos / Clientes
  CONTRATOS: "tblqnXUgrQAbAvqhJ",     // Contratos / Implementaciones
  SESIONES: "tbl1QbdyBKlFACSKa",      // Sesiones de campo
  PAGOS: "tbllIfSrd0qfziDaX",         // Pagos reportados
  SOLICITUDES: "tblWWYXX35Rb2aact",   // Solicitudes de cambio
  CONTRAPARTES: "tblU9p59XqA65XxGC"   // Contrapartes
};

// ── Nombres exactos de campos (verificados contra la base) ──
const C = {
  // Usuarios de Panel
  U_NOMBRE: "Nombre", U_CLIENTE: "Cliente", U_ROL: "Rol",
  U_TEL: "Teléfono WhatsApp", U_CORREO: "Correo", U_ACTIVO: "Activo",
  U_HASH: "Código vigente (hash)", U_EXPIRA: "Código expira",
  U_ULTIMO: "Último acceso", U_INTENTOS: "Intentos fallidos",

  // Operaciones — identidad
  O_FOLIO: "Folio", O_FOLIO_PG: "Folio Pagaré", O_FOLIO_CR: "Folio Constancia",
  O_CLIENTE_ID: "Cliente Id",          // lookup RECORD_ID vía Contrato
  O_CONTRATO: "Contrato",
  O_SENTIDO: "Sentido", O_RESPONSABLE: "Responsable de venta",

  // Operaciones — contraparte
  O_COMPRADOR: "Comprador · Nombre", O_COMPRADOR_RFC: "Comprador · RFC",
  O_COMPRADOR_DOM: "Comprador · Domicilio",
  O_COMPRADOR_REP: "Comprador · Representante",
  O_COMPRADOR_TEL: "Comprador · Teléfono", O_COMPRADOR_CORREO: "Comprador · Correo",
  O_SUSCRIPTOR_ID: "Suscriptor · Identificación",

  // Operaciones — aval
  O_AVAL: "Aval · Nombre", O_AVAL_RFC: "Aval · RFC",
  O_AVAL_DOM: "Aval · Domicilio", O_AVAL_REP: "Aval · Representante",
  O_AVAL_IDENT: "Aval · Identificación", O_AVAL_CORREO: "Aval · Correo",

  // Operaciones — objeto y condiciones
  O_TIPO: "Tipo de operación", O_DESC: "Descripción",
  O_CANTIDAD: "Cantidad y unidad", O_MONTO_TOTAL: "Monto total",
  O_ANTICIPO: "Monto anticipo", O_SALDO: "Saldo a crédito",
  O_MONTO_COBRADO: "Monto cobrado (MXN)",
  O_F_CELEBRACION: "Fecha de celebración", O_F_ENTREGA: "Fecha entrega pactada",
  O_F_OPERACION: "Fecha de operación",
  O_LUGAR_ENTREGA: "Lugar de entrega", O_PLAZO: "Plazo de crédito (días)",
  O_F_VENC: "Fecha de vencimiento", O_DIAS_ATRASO: "Días de atraso",
  O_TASA_ORD: "Tasa ordinaria (% mensual)", O_TASA_MOR: "Tasa moratoria (% mensual)",

  // Operaciones — estado
  O_ESTATUS_PAGO: "Estatus de pago",
  O_FICHA_FIRMA: "Ficha · Estatus firma", O_PAGARE_FIRMA: "Pagaré · Estatus firma",
  O_CONST_ESTATUS: "Constancia · Estatus",
  O_FICHA_MIFIEL: "Ficha · ID Mifiel", O_PAGARE_MIFIEL: "Pagaré · ID Mifiel",
  O_CONST_MIFIEL: "Constancia · ID Mifiel",
  O_SELLO_FICHA: "Sello NOM-151 · Ficha",
  O_SELLO_PAGARE: "Sello NOM-151 · Pagaré",
  O_SELLO_CONST: "Sello NOM-151 · Constancia",
  O_HASH_PAGARE: "Hash · Pagaré",

  // Operaciones — cobro y evidencia
  O_CARGO_ACTIVO: "Cargo automático activado", O_FECHAS_CARGO: "Fechas de cargo",
  O_CARGOS_FALLIDOS: "Intentos de cargo fallidos",
  O_ESCROW_ESTADO: "Estado del escrow", O_ESCROW_MONTO: "Monto en escrow (MXN)",
  O_BITACORA: "Bitácora", O_ADJUNTOS: "Adjuntos de evidencia",

  // Operaciones — recepción (Constancia)
  O_F_RECEPCION: "Fecha real de recepción",
  O_RECIBE: "Persona que recibe", O_ESTADO_CALIDAD: "Estado / calidad",
  O_OBSERVACIONES: "Observaciones recepción",
  O_CANT_ENTREGADA: "Cantidad entregada",

  // Clientes
  CL_NOMBRE: "Nombre completo", CL_PAQUETE: "Paquete contratado",
  CL_SUSCRIPCION: "Estatus suscripción", CL_LOGO: "Logotipo",
  CL_LUGAR: "Lugar por defecto", CL_CENTRO: "Centro de mediación",
  CL_SEDE: "Sede de mediación", CL_JURIS: "Jurisdicción",
  CL_RECORD_ID: "Record ID",

  // Sesiones de campo
  S_TEL: "Teléfono", S_FLUJO: "Flujo", S_PASO: "Paso",
  S_DATOS: "Capturado (JSON)", S_USUARIO: "Usuario", S_ACTUALIZADO: "Actualizado",
  S_ULTIMOS: "Últimos mensajes",

  // Pagos reportados
  P_FOLIO: "Folio", P_OPERACION: "Operación", P_MONTO: "Monto reportado",
  P_MEDIO: "Medio de pago", P_COMPROBANTE: "Comprobante", P_REPORTO: "Reportó",
  P_ESTATUS: "Estatus de conciliación", P_NOTAS: "Notas de conciliación",

  // Operaciones — liga de contraparte (§15.7 del Pliego)
  O_LIGA_JTI: "Liga contraparte · jti",
  O_LIGA_CONSULTA: "Liga contraparte · primera consulta",

  // Clientes — contacto para aclaraciones de la contraparte
  CL_TEL: "Teléfono", CL_CONTRATOS: "Contratos / Implementaciones",

  // Contrapartes (catálogo: compradores y avales capturados por formulario)
  K_NOMBRE: "Nombre o razón social", K_TIPO: "Tipo", K_RFC: "RFC",
  K_DOM: "Domicilio", K_REP: "Representante", K_IDENT: "Identificación",
  K_TEL: "Teléfono", K_CORREO: "Correo", K_TOKEN: "Token",
  K_CLIENTE: "Cliente", K_CLIENTE_ID: "Cliente Id",
  K_ESTATUS: "Estatus", K_MOTIVO: "Motivo de rechazo"
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
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    throw new Error(`Airtable ${r.status}: ${detalle.slice(0, 300)}`);
  }
  return r.json();
}

async function listar(tabla, filtro, campos, extra = {}) {
  const registros = [];
  let offset;
  do {
    const params = { pageSize: "100", ...extra };
    if (filtro) params.filterByFormula = filtro;
    (campos || []).forEach((f, i) => { params[`fields[${i}]`] = f; });
    if (offset) params.offset = offset;
    const pagina = await airtable("GET", tabla, { params });
    registros.push(...pagina.records);
    offset = pagina.offset;
  } while (offset && registros.length < 500);
  return registros;
}

// Carga un archivo a un campo de adjuntos (endpoint de contenido de Airtable).
// Necesario para las fotos de WhatsApp: las URLs de Meta son temporales y
// autenticadas, así que no pueden guardarse como enlace.
async function subirAdjunto(recordId, fieldIdOrName, { nombre, tipo, base64 }) {
  const url = `https://content.airtable.com/v0/${BASE}/${recordId}/${encodeURIComponent(fieldIdOrName)}/uploadAttachment`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: tipo, file: base64, filename: nombre })
  });
  if (!r.ok) throw new Error(`Airtable upload ${r.status}`);
  return r.json();
}

// ── Sesión del Panel: HMAC-SHA256 en cookie HttpOnly, 24 h (decisión §15.3) ──
const SESION_HORAS = 24;
const b64u = buf => Buffer.from(buf).toString("base64url");

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
  let datos;
  try { datos = JSON.parse(Buffer.from(payload, "base64url").toString()); }
  catch { return null; }
  if (!datos.exp || Date.now() > datos.exp) return null;
  return datos; // { u, c, r, n }
}

function cookieSesion(token) {
  const maxAge = token ? SESION_HORAS * 3600 : 0;
  return `sscae_sesion=${token || ""}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// Revalidación por petición (§4.3): Activo se verifica SIEMPRE contra Airtable.
async function usuarioVigente(sesion) {
  const reg = await airtable("GET", T.USUARIOS, { id: sesion.u }).catch(() => null);
  if (!reg || !reg.fields[C.U_ACTIVO]) return null;
  const clienteId = (reg.fields[C.U_CLIENTE] || [])[0];
  if (!clienteId || clienteId !== sesion.c) return null;
  return {
    id: reg.id,
    rol: reg.fields[C.U_ROL] || "Dirección",
    nombre: reg.fields[C.U_NOMBRE] || "",
    clienteId
  };
}

// ── Filtros (§5): siempre del lado del servidor ──
function filtroClientePorLookup(clienteId) {
  return `{${C.O_CLIENTE_ID}} = ${escFormula(clienteId)}`;
}

// El rol Ventas NO puede filtrarse en la fórmula: RECORD_ID() de Airtable no
// acepta argumentos y ARRAYJOIN sobre un vínculo devuelve NOMBRES, que no son
// identificadores únicos. Se filtra en código, donde la API sí entrega los IDs
// de los registros vinculados. filtroRol cubre lo que sí es expresable en
// fórmula; filtrarPorRol aplica el resto sobre los registros ya traídos.
function filtroRol(rol) {
  switch (rol) {
    case "Compras":
      return `{${C.O_SENTIDO}} = 'Compra a proveedor'`;
    case "Cobranza":
      return `{${C.O_ESTATUS_PAGO}} != 'Liquidada'`;
    default:
      return "TRUE()";
  }
}

// Segundo filtro, en memoria: sólo el rol Ventas lo necesita.
function filtrarPorRol(registros, rol, usuarioId) {
  if (rol !== "Ventas") return registros;
  return registros.filter(r => {
    const v = (r.fields || {})[C.O_RESPONSABLE];
    return Array.isArray(v) && v.includes(usuarioId);
  });
}

// ── Semáforo (§7): calculado en backend, nunca almacenado ──
function hoyQro() {
  return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
}

function semaforo(op) {
  const estatus = op[C.O_ESTATUS_PAGO] || "Pendiente";
  if (estatus === "En disputa") return { clave: "disputa", etiqueta: "En disputa" };
  if (estatus === "Liquidada") return { clave: "liquidada", etiqueta: "Liquidada" };
  if (estatus === "Incobrable") return { clave: "disputa", etiqueta: "Incobrable" };
  const venc = op[C.O_F_VENC];
  if (!venc) return { clave: "vigente", etiqueta: "Vigente" };
  const dias = Math.round((Date.parse(venc) - Date.parse(hoyQro())) / 86400e3);
  if (dias < 0) return { clave: "vencida", etiqueta: "Vencida", diasMora: -dias };
  if (dias === 0) return { clave: "porvencer", etiqueta: "Vence hoy", diasRestantes: 0 };
  if (dias <= 7) return { clave: "porvencer", etiqueta: "Por vencer", diasRestantes: dias };
  return { clave: "vigente", etiqueta: "Vigente", diasRestantes: dias };
}

function expedienteIncompleto(op) {
  const pendiente = v => v && v !== "Firmada" && v !== "Registrada" && v !== "No aplica";
  return pendiente(op[C.O_FICHA_FIRMA]) ||
         pendiente(op[C.O_PAGARE_FIRMA]) ||
         pendiente(op[C.O_CONST_ESTATUS]);
}

// ── Bitácora ──
function marcaTiempo() {
  return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}
function lineaBitacora(texto) {
  return `${marcaTiempo()} · ${texto}`;
}
function anexarBitacora(previa, texto) {
  return (previa ? previa + "\n" : "") + lineaBitacora(texto);
}

// ── Respuestas HTTP: mensajes genéricos al navegador (§8.1) ──
function json(status, cuerpo, headersExtra = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headersExtra
    },
    body: JSON.stringify(cuerpo)
  };
}

const ERROR_GENERICO = json(500, { error: "No fue posible completar la consulta. Intenta de nuevo en unos segundos." });
const NO_SESION = json(401, { error: "Tu sesión terminó. Vuelve a entrar." });

async function conSesion(evento, fn) {
  try {
    const sesion = leerSesion(evento);
    if (!sesion) return NO_SESION;
    const usuario = await usuarioVigente(sesion);
    if (!usuario) {
      return json(401, { error: "El acceso fue desactivado. Contacta a tu administrador." },
        { "Set-Cookie": cookieSesion(null) });
    }
    return await fn(usuario);
  } catch (e) {
    if (e && e.limite) return json(503, { error: "El sistema está ocupado. Reintenta en un momento." });
    console.error(e.message);
    return ERROR_GENERICO;
  }
}

// Caché en memoria (sobrevive en instancias calientes)
const cache = new Map();
function conCache(clave, ttlMs, calc) {
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return Promise.resolve(calc()).then(v => { cache.set(clave, { t: Date.now(), v }); return v; });
}


// ── Tokens firmados de propósito general ──
// Formato: base64url(JSON) + "." + HMAC-SHA256. Cada uso tiene su propio
// secreto (liga de contraparte, formularios) para que la filtración de uno no
// comprometa a los demás ni a la sesión del Panel.
function firmarToken(datos, secreto) {
  const payload = b64u(JSON.stringify(datos));
  const firma = crypto.createHmac("sha256", secreto).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

function leerToken(token, secreto) {
  if (!token || !secreto || typeof token !== "string") return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [payload, firma] = partes;
  const esperada = crypto.createHmac("sha256", secreto).update(payload).digest("base64url");
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(payload, "base64url").toString()); }
  catch { return null; }
  if (datos.e && Date.now() > datos.e) return null;   // expirado
  return datos;
}

const idCorto = () => crypto.randomBytes(6).toString("base64url");

// ── RFC (Código Fiscal de la Federación, art. 27; formato del SAT) ──
// Persona moral: 3 letras + AAMMDD + homoclave (12). Persona física: 4 + ... (13).
// Se valida estructura y fecha; no se consulta el padrón del SAT.
function validarRFC(rfc) {
  const r = String(rfc || "").toUpperCase().replace(/[\s-]/g, "");
  const m = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/.exec(r);
  if (!m) return { ok: false, valor: r, razon: "formato inválido" };
  const mes = Number(m[3]), dia = Number(m[4]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return { ok: false, valor: r, razon: "fecha inválida" };
  return { ok: true, valor: r, tipo: m[1].length === 3 ? "moral" : "física" };
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Los campos de tipo porcentaje de Airtable llegan como fracción (4 % = 0.04).
const aPorcentaje = n => Math.round(Number(n || 0) * 1000) / 10;   // 0.04 → 4

const dinero = n => "$" + Number(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = {
  T, C, airtable, listar, escFormula, subirAdjunto,
  firmarSesion, leerSesion, cookieSesion, usuarioVigente,
  filtroRol, filtrarPorRol, filtroClientePorLookup,
  semaforo, expedienteIncompleto, hoyQro,
  marcaTiempo, lineaBitacora, anexarBitacora,
  json, conSesion, conCache, sha256, igualSeguro, dinero,
  firmarToken, leerToken, idCorto, validarRFC, aPorcentaje,
  ERROR_GENERICO
};
