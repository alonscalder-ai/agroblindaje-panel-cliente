// whatsapp-entrante.js — motor conversacional del canal de campo.
// ════════════════════════════════════════════════════════════════════════════
// Implementa la máquina de estados del §6 del Árbol de Conversación. Corre en
// serverless, no en una plataforma de automatización: cada respuesta del bot
// sería una tarea facturada allá, y un alta completa tiene ~9 (regla §16.6).
//
// Al no conservar memoria entre invocaciones, el estado vive en la tabla
// "Sesiones de campo": leer sesión → validar entrada contra el paso →
// responder → escribir sesión.
//
// Identidad: el número telefónico. Quien escribe desde un número registrado y
// activo opera por SU cliente y nada más — la misma frontera de aislamiento
// del Panel (§1, principio 3 del Árbol).
//
// Al confirmarse cada evento, la MISMA función ejecuta sus consecuencias
// documentales llamando a Mifiel (_documentos.js), sin intermediarios.
"use strict";
const L = require("./_lib.js");
const W = require("./_whatsapp.js");
const DOC = require("./_documentos.js");

const VENTANA_SESION_MS = 24 * 3600e3;   // §2.4: un flujo inconcluso caduca a 24 h

// ─────────────────── Formularios firmados (compradores y avales) ───────────────────
// Datos con valor probatorio —RFC, domicilio de emplazamiento— NO se capturan
// tecleando en el chat. El bot envía una liga a un formulario de Airtable con un
// TOKEN FIRMADO oculto: identifica la sesión, el cliente y el tipo de captura, y
// caduca en 2 horas. La sesión queda EN ESPERA (no se borra): al enviarse el
// formulario, una automatización nativa de Airtable avisa a /api/formulario-recibido,
// que valida y retoma la conversación sola. El vendedor no escribe nada más.
const FORM_VIGENCIA_MS = 2 * 3600e3;
const CAMPOS_FORM = ["Nombre o razón social", "RFC", "Domicilio", "Representante",
  "Identificación", "Teléfono", "Correo"];

function ligaFormulario(tipo, sesionId, usuario, previo = {}) {
  const base = tipo === "Aval" ? process.env.FORM_AVAL_URL : process.env.FORM_CONTRAPARTE_URL;
  if (!base || !process.env.FORMULARIOS_SECRET || !sesionId) return null;
  const token = L.firmarToken({
    s: sesionId, c: usuario.clienteId, u: usuario.id, k: tipo,
    e: Date.now() + FORM_VIGENCIA_MS
  }, process.env.FORMULARIOS_SECRET);
  const q = new URLSearchParams();
  q.set("prefill_Token", token); q.set("hide_Token", "true");
  q.set("prefill_Tipo", tipo);   q.set("hide_Tipo", "true");
  // En un reenvío por datos inválidos, lo ya capturado viaja prellenado: solo
  // hay que corregir el campo señalado, no volver a escribir todo.
  for (const campo of CAMPOS_FORM) {
    if (previo[campo]) q.set(`prefill_${campo}`, String(previo[campo]));
  }
  return `${base}${base.includes("?") ? "&" : "?"}${q.toString()}`;
}

async function enviarLigaFormulario(tel, tipo, sesionId, usuario, previo, encabezado) {
  const liga = ligaFormulario(tipo, sesionId, usuario, previo);
  if (!liga) {
    return W.texto(tel, "El formulario todavía no está configurado. Avisa al despacho; " +
      "mientras tanto escribe *CANCELAR*.");
  }
  const que = tipo === "Aval"
    ? "los datos del aval (nombre, RFC, domicilio, identificación y correo para invitarlo a firmar)"
    : "los datos del comprador (razón social, RFC, domicilio, teléfono y correo)";
  return W.texto(tel,
    `${encabezado ? encabezado + "\n\n" : ""}Llena ${que} en esta liga. Es una sola vez: ` +
    "la próxima venta ya aparecerá en tu lista.\n\n" + liga + "\n\n" +
    "En cuanto lo envíes, sigo contigo aquí mismo; no necesitas escribir nada. " +
    "La liga vence en 2 horas.");
}

// Catálogo de contrapartes validadas del cliente (compradores o avales).
async function catalogo(clienteId, tipo) {
  const regs = await L.listar(L.T.CONTRAPARTES,
    `AND({${L.C.K_CLIENTE_ID}} = ${L.escFormula(clienteId)}, {${L.C.K_TIPO}} = ${L.escFormula(tipo)}, {${L.C.K_ESTATUS}} = 'Validada')`,
    [L.C.K_NOMBRE, L.C.K_RFC, L.C.K_DOM, L.C.K_REP, L.C.K_IDENT, L.C.K_TEL, L.C.K_CORREO])
    .catch(() => []);
  return regs.map(r => r.fields);
}

// Traduce un registro del catálogo a la forma que espera el alta.
const aComprador = k => ({
  [L.C.O_COMPRADOR]: k[L.C.K_NOMBRE], [L.C.O_COMPRADOR_RFC]: k[L.C.K_RFC],
  [L.C.O_COMPRADOR_DOM]: k[L.C.K_DOM], [L.C.O_COMPRADOR_REP]: k[L.C.K_REP],
  [L.C.O_COMPRADOR_TEL]: k[L.C.K_TEL], [L.C.O_COMPRADOR_CORREO]: k[L.C.K_CORREO],
  [L.C.O_SUSCRIPTOR_ID]: k[L.C.K_IDENT]
});
const aAval = k => ({
  nombre: k[L.C.K_NOMBRE], rfc: k[L.C.K_RFC], domicilio: k[L.C.K_DOM],
  representante: k[L.C.K_REP], identificacion: k[L.C.K_IDENT], correo: k[L.C.K_CORREO]
});

// ───────────────────────── Sesiones ─────────────────────────
async function cargarSesion(telefono) {
  const regs = await L.listar(L.T.SESIONES,
    `{${L.C.S_TEL}} = ${L.escFormula(telefono)}`,
    [L.C.S_TEL, L.C.S_FLUJO, L.C.S_PASO, L.C.S_DATOS, L.C.S_ACTUALIZADO, L.C.S_USUARIO, L.C.S_ULTIMOS]);
  if (!regs.length) return null;
  const r = regs[0];
  const actualizado = r.fields[L.C.S_ACTUALIZADO] ? Date.parse(r.fields[L.C.S_ACTUALIZADO]) : 0;
  let datos = {};
  try { datos = JSON.parse(r.fields[L.C.S_DATOS] || "{}"); } catch { datos = {}; }
  return {
    id: r.id,
    flujo: r.fields[L.C.S_FLUJO] || null,
    paso: r.fields[L.C.S_PASO] || null,
    datos,
    actualizado,
    ultimos: String(r.fields[L.C.S_ULTIMOS] || "").split("\n").filter(Boolean),
    caduca: actualizado ? Date.now() - actualizado > VENTANA_SESION_MS : true
  };
}

// Idempotencia (Meta puede reentregar un webhook): el id del mensaje se anota
// ANTES de procesarlo; una segunda entrega del mismo mensaje se ignora.
async function yaProcesado(sesion, telefono, usuarioId, msgId) {
  if (!msgId) return { visto: false, sesion };
  if (sesion && sesion.ultimos && sesion.ultimos.includes(msgId)) return { visto: true, sesion };
  const ultimos = [msgId, ...((sesion && sesion.ultimos) || [])].slice(0, 25).join("\n");
  const fields = { [L.C.S_ULTIMOS]: ultimos };
  if (sesion && sesion.id) {
    await L.airtable("PATCH", L.T.SESIONES, { id: sesion.id, cuerpo: { fields } });
    return { visto: false, sesion };
  }
  const nuevo = await L.airtable("POST", L.T.SESIONES, { cuerpo: { fields: {
    ...fields, [L.C.S_TEL]: W.soloDigitos(telefono).slice(-10), [L.C.S_DATOS]: "{}",
    [L.C.S_ACTUALIZADO]: new Date().toISOString(), [L.C.S_USUARIO]: [usuarioId]
  } } });
  return { visto: false, sesion: { id: nuevo.id, flujo: null, paso: null, datos: {}, ultimos: [msgId], caduca: false } };
}

async function guardarSesion(sesion, telefono, usuarioId, { flujo, paso, datos }) {
  const fields = {
    // Clave de sesión SIEMPRE en 10 dígitos, igual que la busca cargarSesion.
    // (Los llamadores pasan el número completo de WhatsApp para poder responder.)
    [L.C.S_TEL]: W.soloDigitos(telefono).slice(-10),
    [L.C.S_FLUJO]: flujo || null,
    [L.C.S_PASO]: paso || "",
    [L.C.S_DATOS]: JSON.stringify(datos || {}),
    [L.C.S_ACTUALIZADO]: new Date().toISOString()
  };
  if (usuarioId) fields[L.C.S_USUARIO] = [usuarioId];
  if (sesion && sesion.id) {
    return L.airtable("PATCH", L.T.SESIONES, { id: sesion.id, cuerpo: { fields } });
  }
  return L.airtable("POST", L.T.SESIONES, { cuerpo: { fields } });
}

const limpiarSesion = (sesion, telefono, usuarioId) =>
  guardarSesion(sesion, telefono, usuarioId, { flujo: null, paso: "", datos: {} });

// ───────────────────── Utilidades de entrada ─────────────────────
function textoDe(mensaje) {
  if (mensaje.type === "text") return (mensaje.text.body || "").trim();
  if (mensaje.type === "interactive") {
    const i = mensaje.interactive;
    if (i.type === "button_reply") return i.button_reply.id;
    if (i.type === "list_reply") return i.list_reply.id;
  }
  if (mensaje.type === "button") return (mensaje.button.text || "").trim();
  return "";
}

function normalizarMonto(t) {
  const limpio = String(t).replace(/[$\s,]/g, "");
  const n = Number(limpio);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const COMANDOS = {
  CANCELAR: /^cancelar$/i,
  MENU: /^(men[uú]|inicio)$/i,
  AYUDA: /^ayuda$/i,
  ALTA: /^alta$/i,
  ENTREGA: /^entrega$/i,
  PAGO: /^pago$/i,
  ESTATUS: /^estatus\s+(OP-\d{1,8})$/i
};

// ───────────────────────── Menú y ayuda ─────────────────────────
// Quién ejecuta cada rama (títulos de las secciones 3, 4 y 5 del Árbol): el alta,
// el vendedor; la entrega, cualquier persona de campo; el reporte de pago,
// cobranza o dirección. La visibilidad en el Panel la rige el §5 del Pliego.
const PERMISOS = {
  ALTA: ["Dirección", "Ventas"],
  ENTREGA: ["Dirección", "Ventas", "Compras", "Cobranza"],
  PAGO: ["Dirección", "Cobranza"]
};
const puede = (usuario, rama) => PERMISOS[rama].includes(usuario.rol);
const ETIQUETAS = { ALTA: "Nueva operación", ENTREGA: "Registrar entrega", PAGO: "Confirmar pago" };
const NOMBRE_FLUJO = { ALTA: "alta de operación", ENTREGA: "registro de entrega", PAGO: "reporte de pago" };

const menu = (tel, nombre, cliente, usuario) =>
  W.botones(tel,
    `Hola, ${nombre} 👋 Soy el asistente de operaciones de ${cliente}.\n¿Qué necesitas hacer?`,
    ["ALTA", "ENTREGA", "PAGO"].filter(r => !usuario || puede(usuario, r))
      .map(r => ({ id: r, titulo: ETIQUETAS[r] })));

const sinPermiso = (tel, rama) => W.texto(tel,
  `Tu perfil no tiene habilitado el ${NOMBRE_FLUJO[rama]}. Si lo necesitas, pídelo a tu administrador.`);

// ── Preguntas por paso: se reutilizan al avanzar, al corregir y al reintentar ──
const PLAZOS = [
  { id: "PZ_30", titulo: "30 días" }, { id: "PZ_60", titulo: "60 días" },
  { id: "PZ_90", titulo: "90 días" }, { id: "PZ_OTRO", titulo: "Otro" }
];
const MEDIOS = [
  { id: "MP_TRANSFER", titulo: "Transferencia" }, { id: "MP_EFECTIVO", titulo: "Efectivo" },
  { id: "MP_CHEQUE", titulo: "Cheque" }, { id: "MP_OTRO", titulo: "Otro" }
];
function preguntar(tel, paso, datos = {}) {
  const op = (datos.operacion || {}).f || {};
  switch (paso) {
    case "ALTA_DESCRIPCION": return W.texto(tel, "¿Qué le vas a vender? Descríbelo en una línea.\nEjemplo: Fertilizante triple 17, saco de 50 kg");
    case "ALTA_CANTIDAD": return W.texto(tel, "¿Cantidad y unidad?  Ejemplo: 40 sacos");
    case "ALTA_MONTO": return W.texto(tel, "¿Monto total de la operación? Solo el número.");
    case "ALTA_ANTICIPO": return W.texto(tel, "¿Cuánto deja de anticipo? Escribe 0 si no hay anticipo.");
    case "ALTA_PLAZO": return W.lista(tel, "¿Plazo de crédito?", "Elegir plazo", PLAZOS);
    case "ALTA_PLAZO_LIBRE": return W.texto(tel, "¿A cuántos días? Solo el número.");
    case "ALTA_AVAL": return W.botones(tel, "¿La operación lleva aval (obligado solidario)?",
      [{ id: "AVAL_SI", titulo: "Sí, lleva aval" }, { id: "AVAL_NO", titulo: "No lleva aval" }]);
    case "ENT_EVIDENCIA": return W.texto(tel, "Mándame la foto de la remisión firmada o de la mercancía. " +
      "Puedes mandar varias y compartir tu ubicación 📍. Cuando termines, escribe LISTO.");
    case "ENT_ALCANCE": return W.botones(tel, "¿La entrega fue total o parcial?",
      [{ id: "ENT_TOTAL", titulo: "Total" }, { id: "ENT_PARCIAL", titulo: "Parcial" }]);
    case "ENT_CANTIDAD": return W.texto(tel, "¿Qué cantidad se entregó?");
    case "ENT_RECIBE": return W.texto(tel, "¿Quién recibió? Nombre de la persona.");
    case "ENT_ESTADO": return W.botones(tel, "¿Cómo se recibió la mercancía?", [
      { id: "EST_BUENO", titulo: "En buen estado" }, { id: "EST_OBS", titulo: "Con observaciones" },
      { id: "EST_NOCONF", titulo: "No conforme" }]);
    case "ENT_OBSERVACIONES": return W.texto(tel, "Describe brevemente la observación o el problema.");
    case "PAGO_ALCANCE": return W.botones(tel,
      `${op[L.C.O_FOLIO] || ""} · saldo ${L.dinero(op[L.C.O_SALDO])}\n¿Pagó todo o una parte?`,
      [{ id: "PAGO_TODO", titulo: "Todo" }, { id: "PAGO_PARTE", titulo: "Una parte" }]);
    case "PAGO_MONTO": return W.texto(tel, "¿Cuánto recibiste? Solo el número.");
    case "PAGO_MEDIO": return W.lista(tel, "¿Cómo pagó?", "Medio de pago", MEDIOS);
    case "PAGO_COMPROBANTE": return W.texto(tel, datos.medio === "Efectivo"
      ? "Mándame la foto del recibo si tienes. Si no hay comprobante, escribe OMITIR."
      : `Mándame la foto del comprobante de ${String(datos.medio || "pago").toLowerCase()}.`);
    default: return W.texto(tel, "Sigamos. ¿Qué necesitas?");
  }
}

// §2.2 CORREGIR: lista de lo capturado; se reemplaza UN campo y se vuelve al
// resumen, sin repetir el flujo completo.
const CAMPOS_CORREGIBLES = {
  ALTA: [["ALTA_DESCRIPCION", "Descripción"], ["ALTA_CANTIDAD", "Cantidad"],
         ["ALTA_MONTO", "Monto total"], ["ALTA_ANTICIPO", "Anticipo"],
         ["ALTA_PLAZO", "Plazo"], ["ALTA_AVAL", "Aval"]],
  ENTREGA: [["ENT_EVIDENCIA", "Agregar fotos"], ["ENT_ALCANCE", "Total o parcial"],
            ["ENT_RECIBE", "Quién recibió"], ["ENT_ESTADO", "Estado de la mercancía"]],
  PAGO: [["PAGO_ALCANCE", "Monto"], ["PAGO_MEDIO", "Medio de pago"], ["PAGO_COMPROBANTE", "Comprobante"]]
};
async function ofrecerCorreccion(ctx, flujo) {
  await guardarSesion(ctx.sesion, ctx.tel, ctx.usuario.id,
    { flujo, paso: `${flujo}_CORREGIR`, datos: ctx.datos });
  return W.lista(ctx.tel, "¿Qué dato quieres corregir?", "Elegir dato",
    CAMPOS_CORREGIBLES[flujo].map(([paso, titulo]) => ({ id: `ED_${paso}`, titulo })));
}
async function elegirCorreccion(ctx, flujo, entrada, volverAlResumen) {
  const paso = String(entrada).replace(/^ED_/, "");
  if (!CAMPOS_CORREGIBLES[flujo].some(([p]) => p === paso)) return volverAlResumen(ctx, ctx.datos);
  await guardarSesion(ctx.sesion, ctx.tel, ctx.usuario.id,
    { flujo, paso, datos: { ...ctx.datos, __corr: true, __inval: 0 } });
  return preguntar(ctx.tel, paso, ctx.datos);
}

// §2.5: entrada que no corresponde al paso. Se repite la pregunta una vez; a la
// segunda, se ofrece cancelar.
async function noValida(ctx, flujo, paso, aviso) {
  const n = (ctx.datos.__inval || 0) + 1;
  await guardarSesion(ctx.sesion, ctx.tel, ctx.usuario.id,
    { flujo, paso, datos: { ...ctx.datos, __inval: n } });
  if (n >= 2) {
    return W.botones(ctx.tel, `${aviso}\n¿Seguimos o prefieres cancelar?`,
      [{ id: "SEGUIR", titulo: "Seguir" }, { id: "CANCELAR_BTN", titulo: "Cancelar" }]);
  }
  await W.texto(ctx.tel, aviso);
  return preguntar(ctx.tel, paso, ctx.datos);
}

// Limpia marcas internas antes de mostrar un resumen.
const limpio = d => { const { __corr, __inval, ...resto } = d; return resto; };

const ayuda = tel => W.texto(tel,
  "Puedo ayudarte con tres cosas:\n\n" +
  "▪ *ALTA* — dar de alta una venta a crédito\n" +
  "▪ *ENTREGA* — registrar que entregaste mercancía\n" +
  "▪ *PAGO* — reportar un pago que te hicieron\n\n" +
  "También puedes escribir *ESTATUS OP-0144* para consultar una operación.\n" +
  "En cualquier momento, *CANCELAR* descarta lo que estemos haciendo.");

// ───────────────────── Consulta de estatus ─────────────────────
async function responderEstatus(tel, folio, usuario) {
  const regs = await L.listar(L.T.OPERACIONES,
    `AND({${L.C.O_FOLIO}} = ${L.escFormula(folio)}, ${L.filtroClientePorLookup(usuario.clienteId)})`,
    [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_SALDO, L.C.O_F_VENC, L.C.O_ESTATUS_PAGO]);
  if (!regs.length) return W.texto(tel, "No encontré esa operación.");
  const f = regs[0].fields;
  const s = L.semaforo(f);
  return W.texto(tel,
    `*${f[L.C.O_FOLIO]}* · ${f[L.C.O_COMPRADOR] || ""}\n` +
    `Saldo: ${L.dinero(f[L.C.O_SALDO])}\n` +
    `Estado: ${s.etiqueta}${s.diasMora ? ` (${s.diasMora} días de mora)` : ""}\n` +
    `Vence: ${DOC.fmtFecha(f[L.C.O_F_VENC]) || "—"}`);
}

// ───────────────── Catálogos para las listas ─────────────────
async function contrapartesRecientes(clienteId) {
  // 1) Catálogo validado (fuente principal desde que existen los formularios)
  const vistos = new Map();
  for (const k of await catalogo(clienteId, "Comprador")) {
    const f = aComprador(k);
    if (f[L.C.O_COMPRADOR] && !vistos.has(f[L.C.O_COMPRADOR_RFC] || f[L.C.O_COMPRADOR])) {
      vistos.set(f[L.C.O_COMPRADOR_RFC] || f[L.C.O_COMPRADOR], f);
    }
  }
  // 2) Historial de operaciones (compradores anteriores al catálogo)
  if (vistos.size < 9) {
    const regs = await L.listar(L.T.OPERACIONES,
      L.filtroClientePorLookup(clienteId),
      [L.C.O_COMPRADOR, L.C.O_COMPRADOR_RFC, L.C.O_COMPRADOR_DOM, L.C.O_SUSCRIPTOR_ID,
       L.C.O_COMPRADOR_TEL, L.C.O_COMPRADOR_CORREO, L.C.O_COMPRADOR_REP],
      { "sort[0][field]": L.C.O_FOLIO, "sort[0][direction]": "desc" });
    for (const r of regs) {
      const clave = r.fields[L.C.O_COMPRADOR_RFC] || r.fields[L.C.O_COMPRADOR];
      if (clave && !vistos.has(clave)) vistos.set(clave, r.fields);
      if (vistos.size >= 9) break;
    }
  }
  return [...vistos.values()].slice(0, 9).map(f => ({ nombre: f[L.C.O_COMPRADOR], f }));
}

async function entregasPendientes(clienteId) {
  return L.listar(L.T.OPERACIONES,
    `AND(${L.filtroClientePorLookup(clienteId)}, OR({${L.C.O_CONST_ESTATUS}} = 'Pendiente', {${L.C.O_CONST_ESTATUS}} = ''))`,
    [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_CANTIDAD, L.C.O_DESC, L.C.O_LUGAR_ENTREGA],
    { "sort[0][field]": L.C.O_F_ENTREGA, "sort[0][direction]": "asc" });
}

async function operacionesConSaldo(clienteId) {
  return L.listar(L.T.OPERACIONES,
    `AND(${L.filtroClientePorLookup(clienteId)}, {${L.C.O_ESTATUS_PAGO}} != 'Liquidada', {${L.C.O_SALDO}} > 0)`,
    [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_SALDO, L.C.O_F_VENC, L.C.O_ESTATUS_PAGO],
    { "sort[0][field]": L.C.O_F_VENC, "sort[0][direction]": "asc" });
}

// ═════════════════════ RAMA 1 · ALTA ═════════════════════
async function iniciarAlta(tel, usuario, sesion) {
  const lista = await contrapartesRecientes(usuario.clienteId);
  const filas = lista.map((c, i) => ({
    id: `CP_${i}`, titulo: c.nombre, descripcion: c.f[L.C.O_COMPRADOR_RFC] || ""
  }));
  filas.push({ id: "CP_NUEVO", titulo: "➕ Comprador nuevo" });
  await guardarSesion(sesion, tel, usuario.id, {
    flujo: "ALTA", paso: "ALTA_CONTRAPARTE",
    datos: { catalogo: lista.map(c => c.f) }
  });
  return W.lista(tel,
    "¿A quién le vas a vender? Elige de la lista.",
    "Elegir comprador", filas);
}

async function pasoAlta(paso, entrada, mensaje, ctx) {
  const { tel, usuario, sesion, datos } = ctx;
  const guardar = (p, d) => guardarSesion(sesion, tel, usuario.id,
    { flujo: "ALTA", paso: p, datos: { ...datos, __inval: 0, ...d } });
  // Avanza al siguiente paso o, si se está corrigiendo un solo dato, vuelve al resumen.
  const avanzar = async (siguiente, nuevos) => {
    if (datos.__corr) return resumenAlta(ctx, limpio({ ...datos, ...nuevos }));
    await guardar(siguiente, nuevos);
    return preguntar(tel, siguiente, { ...datos, ...nuevos });
  };
  const invalida = aviso => noValida(ctx, "ALTA", paso, aviso);

  switch (paso) {
    case "ALTA_CONTRAPARTE": {
      if (entrada === "CP_NUEVO") {
        await guardar("ALTA_ESPERA_CONTRAPARTE", {});
        return enviarLigaFormulario(tel, "Comprador", sesion && sesion.id, usuario, {});
      }
      const cp = (datos.catalogo || [])[Number(String(entrada).replace("CP_", ""))];
      if (!/^CP_\d+$/.test(entrada) || !cp) {
        const n = (datos.__inval || 0) + 1;
        await guardar("ALTA_CONTRAPARTE", { __inval: n });
        if (n >= 2) return W.botones(tel, "No reconocí esa opción. ¿Empezamos de nuevo o cancelo?",
          [{ id: "ALTA", titulo: "Empezar de nuevo" }, { id: "CANCELAR_BTN", titulo: "Cancelar" }]);
        return W.texto(tel, "Elige al comprador de la lista que te envié, o «Comprador nuevo».");
      }
      await guardar("ALTA_DESCRIPCION", { contraparte: cp });
      await W.texto(tel, `${cp[L.C.O_COMPRADOR]} ✓`);
      return preguntar(tel, "ALTA_DESCRIPCION");
    }

    case "ALTA_DESCRIPCION":
      if (!entrada || entrada.length < 3) return invalida("Necesito una descripción breve del producto o servicio.");
      return avanzar("ALTA_CANTIDAD", { descripcion: entrada });

    case "ALTA_CANTIDAD":
      if (!entrada) return invalida("Escribe la cantidad y la unidad.");
      return avanzar("ALTA_MONTO", { cantidad: entrada });

    case "ALTA_MONTO": {
      const monto = normalizarMonto(entrada);
      if (monto === null || monto <= 0) return invalida("No entendí el monto. Escribe solo el número, por ejemplo: 96000");
      // Si al corregir el monto el anticipo previo ya no cabe, hay que volver a pedirlo.
      if (datos.__corr && (datos.anticipo || 0) > monto) {
        await guardar("ALTA_ANTICIPO", { montoTotal: monto, __corr: true });
        await W.texto(tel, `El anticipo registrado (${L.dinero(datos.anticipo)}) ya supera el nuevo total.`);
        return preguntar(tel, "ALTA_ANTICIPO");
      }
      return avanzar("ALTA_ANTICIPO", { montoTotal: monto });
    }

    case "ALTA_ANTICIPO": {
      const anticipo = normalizarMonto(entrada);
      if (anticipo === null) return invalida("Escribe solo el número. Si no hay anticipo, escribe 0.");
      if (anticipo > datos.montoTotal) {
        return invalida(`El anticipo no puede ser mayor al total (${L.dinero(datos.montoTotal)}).`);
      }
      return avanzar("ALTA_PLAZO", { anticipo });
    }

    case "ALTA_PLAZO": {
      if (entrada === "PZ_OTRO") {
        await guardar("ALTA_PLAZO_LIBRE", {});
        return preguntar(tel, "ALTA_PLAZO_LIBRE");
      }
      const dias = /^PZ_\d+$/.test(entrada) ? Number(entrada.slice(3)) : 0;
      if (!dias) return invalida("Elige el plazo de la lista.");
      return avanzar("ALTA_AVAL", { plazo: dias });
    }

    case "ALTA_PLAZO_LIBRE": {
      const dias = Number(String(entrada).replace(/\D/g, ""));
      if (!dias || dias > 365) return invalida("Escribe un número de días entre 1 y 365.");
      return avanzar("ALTA_AVAL", { plazo: dias });
    }

    case "ALTA_AVAL": {
      if (entrada === "AVAL_SI") {
        const avales = await catalogo(usuario.clienteId, "Aval");
        if (avales.length) {
          await guardar("ALTA_AVAL_ELEGIR", { catalogoAvales: avales.slice(0, 9) });
          const filas = avales.slice(0, 9).map((a, i) => ({
            id: `AV_${i}`, titulo: a[L.C.K_NOMBRE] || "Aval", descripcion: a[L.C.K_RFC] || ""
          }));
          filas.push({ id: "AV_NUEVO", titulo: "➕ Aval nuevo" });
          return W.lista(tel, "¿Quién es el aval?", "Elegir aval", filas);
        }
        await guardar("ALTA_ESPERA_AVAL", {});
        return enviarLigaFormulario(tel, "Aval", sesion && sesion.id, usuario, {});
      }
      if (entrada === "AVAL_NO") return resumenAlta(ctx, limpio({ ...datos, aval: null }));
      return invalida("Elige una de las dos opciones.");
    }

    case "ALTA_AVAL_ELEGIR": {
      if (entrada === "AV_NUEVO") {
        await guardar("ALTA_ESPERA_AVAL", {});
        return enviarLigaFormulario(tel, "Aval", sesion && sesion.id, usuario, {});
      }
      const av = (datos.catalogoAvales || [])[Number(String(entrada).replace("AV_", ""))];
      if (!/^AV_\d+$/.test(entrada) || !av) return W.texto(tel, "Elige un aval de la lista, o «Aval nuevo».");
      return resumenAlta(ctx, limpio({ ...datos, aval: aAval(av) }));
    }

    // En espera del formulario: la conversación sigue viva y nada se pierde.
    case "ALTA_ESPERA_CONTRAPARTE":
    case "ALTA_ESPERA_AVAL": {
      const tipo = paso === "ALTA_ESPERA_AVAL" ? "Aval" : "Comprador";
      if (entrada === "REENVIAR") return enviarLigaFormulario(tel, tipo, sesion && sesion.id, usuario, {});
      if (entrada === "SIN_AVAL" && tipo === "Aval") return resumenAlta(ctx, limpio({ ...datos, aval: null }));
      const opciones = [{ id: "REENVIAR", titulo: "Reenviar la liga" }];
      if (tipo === "Aval") opciones.push({ id: "SIN_AVAL", titulo: "Seguir sin aval" });
      opciones.push({ id: "CANCELAR_BTN", titulo: "Cancelar" });
      return W.botones(tel,
        `Estoy esperando el formulario ${tipo === "Aval" ? "del aval" : "del comprador"}. ` +
        "En cuanto lo envíes, continúo.", opciones);
    }

    case "ALTA_RESUMEN":
      if (entrada === "CONFIRMAR") return confirmarAlta(ctx);
      if (entrada === "CORREGIR") return ofrecerCorreccion(ctx, "ALTA");
      return invalida("Usa los botones: Confirmar, Corregir o Cancelar.");

    case "ALTA_CORREGIR":
      return elegirCorreccion(ctx, "ALTA", entrada, resumenAlta);

    default:
      await limpiarSesion(sesion, tel, usuario.id);
      return W.texto(tel, "Perdí el hilo. Escribe *ALTA* para empezar de nuevo.");
  }
}

async function resumenAlta(ctx, datos) {
  const { tel, usuario, sesion } = ctx;
  const saldo = datos.montoTotal - (datos.anticipo || 0);
  await guardarSesion(sesion, tel, usuario.id,
    { flujo: "ALTA", paso: "ALTA_RESUMEN", datos: { ...datos, saldo } });
  const cp = datos.contraparte;
  return W.botones(tel,
    "Revisa antes de generar los documentos:\n" +
    `▪ Comprador: ${cp[L.C.O_COMPRADOR]}\n` +
    `▪ ${datos.descripcion} · ${datos.cantidad}\n` +
    `▪ Total ${L.dinero(datos.montoTotal)} · Anticipo ${L.dinero(datos.anticipo)}\n` +
    `▪ Saldo a crédito: ${L.dinero(saldo)} a ${datos.plazo} días` +
    (datos.aval ? `\n▪ Aval: ${datos.aval.nombre}` : ""),
    [
      { id: "CONFIRMAR", titulo: "Confirmar" },
      { id: "CORREGIR", titulo: "Corregir" },
      { id: "CANCELAR_BTN", titulo: "Cancelar" }
    ]);
}

async function confirmarAlta(ctx) {
  const { tel, usuario, sesion, datos, cliente, clienteFields } = ctx;
  const C = L.C;
  const cp = datos.contraparte;

  // Antiduplicado (§6): mismo vendedor, misma contraparte y monto en 10 min
  // CREATED_TIME() es nativo de Airtable: no depende de un campo "Creado".
  const recientes = await L.listar(L.T.OPERACIONES,
    `AND(${L.filtroClientePorLookup(usuario.clienteId)}, {${C.O_COMPRADOR}} = ${L.escFormula(cp[C.O_COMPRADOR])}, {${C.O_MONTO_TOTAL}} = ${Number(datos.montoTotal)}, IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -10, 'minutes')))`,
    [C.O_FOLIO]).catch(e => { console.error("antiduplicado:", e.message); return []; });
  const duplicado = recientes.length > 0;
  if (duplicado && !datos.forzar) {
    await guardarSesion(sesion, tel, usuario.id,
      { flujo: "ALTA", paso: "ALTA_RESUMEN", datos: { ...datos, forzar: true } });
    return W.botones(tel,
      "⚠️ Hace menos de 10 minutos diste de alta una operación igual con este comprador " +
      "y el mismo monto. ¿Es una operación distinta?",
      [{ id: "CONFIRMAR", titulo: "Sí, es otra" }, { id: "CANCELAR_BTN", titulo: "Cancelar" }]);
    }

  const hoy = L.hoyQro();
  const fields = {
    [C.O_COMPRADOR]: cp[C.O_COMPRADOR],
    [C.O_COMPRADOR_RFC]: cp[C.O_COMPRADOR_RFC] || "",
    [C.O_COMPRADOR_DOM]: cp[C.O_COMPRADOR_DOM] || "",
    [C.O_COMPRADOR_TEL]: cp[C.O_COMPRADOR_TEL] || "",
    [C.O_COMPRADOR_CORREO]: cp[C.O_COMPRADOR_CORREO] || "",
    [C.O_COMPRADOR_REP]: cp[C.O_COMPRADOR_REP] || "",
    [C.O_TIPO]: "Venta de insumos",
    [C.O_DESC]: datos.descripcion,
    [C.O_CANTIDAD]: datos.cantidad,
    [C.O_MONTO_TOTAL]: datos.montoTotal,
    [C.O_ANTICIPO]: datos.anticipo || 0,
    [C.O_PLAZO]: datos.plazo,
    [C.O_F_CELEBRACION]: hoy,
    [C.O_F_OPERACION]: hoy,          // base de la Fecha de vencimiento hasta la entrega
    [C.O_F_ENTREGA]: hoy,
    [C.O_SUSCRIPTOR_ID]: cp[C.O_SUSCRIPTOR_ID] || "",
    [C.O_SENTIDO]: "Venta a crédito",
    [C.O_ESTATUS_PAGO]: "Pendiente",
    [C.O_FICHA_FIRMA]: "Pendiente",
    [C.O_PAGARE_FIRMA]: "Pendiente",
    [C.O_CONST_ESTATUS]: "Pendiente",
    [C.O_RESPONSABLE]: [usuario.id],
    [C.O_BITACORA]: L.lineaBitacora(`Alta por WhatsApp · ${tel} · ${usuario.nombre}`)
  };
  // El vínculo al Contrato es OBLIGATORIO: por él se hereda el Cliente Id, que es
  // la frontera de aislamiento. Sin él la operación quedaría fuera del Panel.
  const contratos = clienteFields[L.C.CL_CONTRATOS] || [];
  if (!contratos.length) {
    return W.texto(tel, "Tu empresa no tiene un contrato activo registrado, así que no puedo " +
      "dar de alta la operación. Avisa al despacho.");
  }
  fields[C.O_CONTRATO] = [contratos[contratos.length - 1]];   // el más reciente
  if (datos.aval) {
    Object.assign(fields, {
      [C.O_AVAL]: datos.aval.nombre || "", [C.O_AVAL_RFC]: datos.aval.rfc || "",
      [C.O_AVAL_DOM]: datos.aval.domicilio || "", [C.O_AVAL_REP]: datos.aval.representante || "",
      [C.O_AVAL_IDENT]: datos.aval.identificacion || "", [C.O_AVAL_CORREO]: datos.aval.correo || ""
    });
  }

  let creado;
  try {
    creado = await L.airtable("POST", L.T.OPERACIONES, { cuerpo: { fields } });
  } catch (e) {
    console.error("alta:", e.message);
    return W.texto(tel, "No pude registrar la operación. Inténtalo de nuevo en un momento.");
  }

  await limpiarSesion(sesion, tel, usuario.id);

  // Releer para obtener folios y fecha de vencimiento ya calculados por fórmula
  const fresco = await L.airtable("GET", L.T.OPERACIONES, { id: creado.id }).catch(() => creado);
  const folio = fresco.fields[C.O_FOLIO] || "(sin folio)";

  await W.texto(tel,
    `Listo ✅ Operación ${folio} registrada.\n` +
    "La Ficha y el Pagaré van en camino a la firma electrónica del comprador " +
    "(le llegan por correo). Te aviso cuando firme." +
    (fresco.fields[C.O_F_VENC] ? `\nEl saldo vence el ${DOC.fmtFecha(fresco.fields[C.O_F_VENC])}.` : ""));

  // ── Consecuencia documental: Ficha + Pagaré en Mifiel, misma ejecución ──
  const res = await DOC.generarFichaYPagare(fresco, clienteFields);
  if (res.errores.length) {
    console.error("Mifiel alta:", res.errores.join(" | "));
    await W.texto(tel,
      "⚠️ La operación quedó registrada, pero hubo un problema al enviar los " +
      "documentos a firma. El despacho ya fue notificado y lo resuelve.");
  }
  return true;
}

// ═════════════════════ RAMA 2 · ENTREGA ═════════════════════
async function iniciarEntrega(tel, usuario, sesion) {
  // §2.5: si la persona mandó antes una foto sin contexto, se conserva y ya
  // cuenta como evidencia de esta entrega.
  // Solo si es reciente (2 h): una foto de hace días no es evidencia de hoy.
  const reciente = sesion && sesion.actualizado && Date.now() - sesion.actualizado < 2 * 3600e3;
  const fotoSuelta = reciente && sesion.datos && sesion.datos.__fotoSuelta;
  const pendientes = await entregasPendientes(usuario.clienteId);
  if (!pendientes.length) {
    await limpiarSesion(sesion, tel, usuario.id);
    return W.texto(tel, "No tienes entregas pendientes de registrar.");
  }
  const filas = pendientes.slice(0, 10).map((r, i) => ({
    id: `EN_${i}`,
    titulo: `${r.fields[L.C.O_FOLIO]} · ${(r.fields[L.C.O_COMPRADOR] || "").slice(0, 14)}`,
    descripcion: r.fields[L.C.O_CANTIDAD] || r.fields[L.C.O_DESC] || ""
  }));
  await guardarSesion(sesion, tel, usuario.id, {
    flujo: "ENTREGA", paso: "ENT_OPERACION",
    datos: {
      candidatos: pendientes.slice(0, 10).map(r => ({ id: r.id, f: r.fields })),
      fotos: fotoSuelta ? [fotoSuelta] : []
    }
  });
  return W.lista(tel, "¿Cuál entrega vas a registrar?", "Entregas pendientes", filas);
}

async function pasoEntrega(paso, entrada, mensaje, ctx) {
  const { tel, usuario, sesion, datos } = ctx;
  const guardar = (p, d) => guardarSesion(sesion, tel, usuario.id,
    { flujo: "ENTREGA", paso: p, datos: { ...datos, __inval: 0, ...d } });
  const avanzar = async (siguiente, nuevos) => {
    if (datos.__corr) return resumenEntrega(ctx, limpio({ ...datos, ...nuevos }));
    await guardar(siguiente, nuevos);
    return preguntar(tel, siguiente, { ...datos, ...nuevos });
  };
  const invalida = aviso => noValida(ctx, "ENTREGA", paso, aviso);

  switch (paso) {
    case "ENT_OPERACION": {
      const op = (datos.candidatos || [])[Number(String(entrada).replace("EN_", ""))];
      if (!/^EN_\d+$/.test(entrada) || !op) {
        return W.texto(tel, "Elige la entrega de la lista que te envié. Escribe *ENTREGA* para verla de nuevo.");
      }
      const fotos = datos.fotos || [];
      await guardar("ENT_EVIDENCIA", { operacion: op, fotos });
      if (fotos.length) {
        return W.texto(tel, `${op.f[L.C.O_FOLIO]} ✓ Ya tengo la foto que mandaste. ` +
          "Si quieres, manda más o comparte tu ubicación 📍. Cuando termines, escribe LISTO.");
      }
      await W.texto(tel, `${op.f[L.C.O_FOLIO]} ✓`);
      return preguntar(tel, "ENT_EVIDENCIA");
    }

    case "ENT_EVIDENCIA": {
      if (mensaje.type === "image" || mensaje.type === "document") {
        const media = mensaje.image || mensaje.document;
        const fotos = [...(datos.fotos || []), { id: media.id, tipo: mensaje.type }];
        await guardar("ENT_EVIDENCIA", { fotos });
        return W.texto(tel, `Recibí ${fotos.length} archivo(s) ✓ Manda más o escribe LISTO.`);
      }
      if (mensaje.type === "location") {
        await guardar("ENT_EVIDENCIA", {
          ubicacion: { lat: mensaje.location.latitude, lon: mensaje.location.longitude }
        });
        return W.texto(tel, "Ubicación registrada 📍 Manda las fotos o escribe LISTO.");
      }
      if (!/^listo$/i.test(entrada)) return invalida("Manda al menos una foto y luego escribe LISTO.");
      if (!(datos.fotos || []).length) return invalida("Necesito al menos una foto de la entrega para continuar.");
      if (datos.__corr) return resumenEntrega(ctx, limpio(datos));
      await guardar("ENT_ALCANCE", {});
      await W.texto(tel, `Recibí ${datos.fotos.length} foto(s)${datos.ubicacion ? " y la ubicación" : ""} ✓`);
      return preguntar(tel, "ENT_ALCANCE");
    }

    case "ENT_ALCANCE":
      if (entrada === "ENT_PARCIAL") {
        // La cantidad es parte del mismo dato: se pide también al corregir.
        await guardar("ENT_CANTIDAD", { tipoEntrega: "Parcial" });
        return preguntar(tel, "ENT_CANTIDAD");
      }
      if (entrada === "ENT_TOTAL") return avanzar("ENT_RECIBE", { tipoEntrega: "Total", cantidadEntregada: null });
      return invalida("Elige Total o Parcial.");

    case "ENT_CANTIDAD":
      if (!entrada) return invalida("Escribe la cantidad entregada.");
      return avanzar("ENT_RECIBE", { cantidadEntregada: entrada });

    case "ENT_RECIBE":
      if (!entrada || entrada.length < 3) return invalida("Escribe el nombre de quien recibió.");
      return avanzar("ENT_ESTADO", { recibe: entrada });

    case "ENT_ESTADO":
      if (entrada === "EST_OBS" || entrada === "EST_NOCONF") {
        await guardar("ENT_OBSERVACIONES", {
          estado: entrada === "EST_NOCONF" ? "No conforme" : "Con observaciones",
          noConforme: entrada === "EST_NOCONF"
        });
        return preguntar(tel, "ENT_OBSERVACIONES");
      }
      if (entrada === "EST_BUENO") {
        return resumenEntrega(ctx, limpio({ ...datos, estado: "En buen estado", noConforme: false, observaciones: null }));
      }
      return invalida("Elige una de las opciones.");

    case "ENT_OBSERVACIONES":
      if (!entrada) return invalida("Escribe la observación.");
      return resumenEntrega(ctx, limpio({ ...datos, observaciones: entrada }));

    case "ENT_RESUMEN":
      if (entrada === "CONFIRMAR") return confirmarEntrega(ctx);
      if (entrada === "CORREGIR") return ofrecerCorreccion(ctx, "ENTREGA");
      return invalida("Usa los botones: Confirmar, Corregir o Cancelar.");

    case "ENTREGA_CORREGIR":
      return elegirCorreccion(ctx, "ENTREGA", entrada, resumenEntrega);

    default:
      await limpiarSesion(sesion, tel, usuario.id);
      return W.texto(tel, "Perdí el hilo. Escribe *ENTREGA* para empezar de nuevo.");
  }
}

async function resumenEntrega(ctx, datos) {
  const { tel, usuario, sesion } = ctx;
  await guardarSesion(sesion, tel, usuario.id,
    { flujo: "ENTREGA", paso: "ENT_RESUMEN", datos });
  const op = datos.operacion.f;
  return W.botones(tel,
    "Revisa:\n" +
    `▪ ${op[L.C.O_FOLIO]} · ${op[L.C.O_COMPRADOR]}\n` +
    `▪ Entrega ${String(datos.tipoEntrega).toUpperCase()}` +
    (datos.cantidadEntregada ? ` · ${datos.cantidadEntregada}` : ` · ${op[L.C.O_CANTIDAD] || ""}`) +
    ` · recibió ${datos.recibe}\n` +
    `▪ ${datos.estado} · ${datos.fotos.length} foto(s)` +
    (datos.ubicacion ? " · ubicación registrada" : "") +
    (datos.observaciones ? `\n▪ Obs.: ${datos.observaciones}` : ""),
    [
      { id: "CONFIRMAR", titulo: "Confirmar" },
      { id: "CORREGIR", titulo: "Corregir" },
      { id: "CANCELAR_BTN", titulo: "Cancelar" }
    ]);
}

async function confirmarEntrega(ctx) {
  const { tel, usuario, sesion, datos, clienteFields } = ctx;
  const C = L.C;
  const opId = datos.operacion.id;
  // Guarda contra doble confirmación: si la Constancia ya se generó, no se repite.
  const actual = await L.airtable("GET", L.T.OPERACIONES, { id: opId }).catch(() => null);
  if (actual && actual.fields[C.O_CONST_MIFIEL]) {
    await limpiarSesion(sesion, tel, usuario.id);
    return W.texto(tel, `La entrega de ${actual.fields[C.O_FOLIO]} ya estaba registrada. No hice cambios.`);
  }
  let previa = (actual && actual.fields[C.O_BITACORA]) || datos.operacion.f[C.O_BITACORA] || "";
  if (datos.ubicacion) {
    previa = L.anexarBitacora(previa, `Ubicación de la entrega: https://maps.google.com/?q=${datos.ubicacion.lat},${datos.ubicacion.lon}`);
  }
  const hoy = L.hoyQro();

  const fields = {
    [C.O_F_RECEPCION]: hoy,
    [C.O_RECIBE]: datos.recibe,
    [C.O_ESTADO_CALIDAD]: datos.estado,
    [C.O_BITACORA]: L.anexarBitacora(previa,
      `Entrega registrada por WhatsApp · ${tel} · ${usuario.nombre} · ${datos.tipoEntrega}`)
  };
  if (datos.cantidadEntregada) fields[C.O_CANT_ENTREGADA] = datos.cantidadEntregada;
  if (datos.observaciones) fields[C.O_OBSERVACIONES] = datos.observaciones;
  // "No conforme" pausa el cobro y arranca el Protocolo de Controversia (§4.3)
  if (datos.noConforme) fields[C.O_ESTATUS_PAGO] = "En disputa";

  try {
    await L.airtable("PATCH", L.T.OPERACIONES, { id: opId, cuerpo: { fields } });
  } catch (e) {
    console.error("entrega:", e.message);
    return W.texto(tel, "No pude registrar la entrega. Inténtalo de nuevo en un momento.");
  }

  // Subir las fotos como adjuntos (las URLs de Meta son temporales)
  for (const foto of datos.fotos || []) {
    try {
      const archivo = await W.descargarMedio(foto.id);
      await L.subirAdjunto(opId, C.O_ADJUNTOS, archivo);
    } catch (e) {
      console.error("adjunto:", e.message);
    }
  }

  await limpiarSesion(sesion, tel, usuario.id);

  const fresco = await L.airtable("GET", L.T.OPERACIONES, { id: opId }).catch(() => null);
  const venc = fresco && fresco.fields[C.O_F_VENC];
  const saldo = fresco && fresco.fields[C.O_SALDO];

  await W.texto(tel,
    `Entrega registrada ✅ ${L.marcaTiempo()}.\n` +
    (venc ? `Con esta fecha, el saldo de ${L.dinero(saldo)} vence el ${DOC.fmtFecha(venc)}.\n` : "") +
    (datos.noConforme
      ? "Marqué la operación como *en disputa* y avisé al despacho."
      : "La Constancia de Recepción va en camino a firma.") +
    `\nGracias, ${usuario.nombre.split(" ")[0]}. Buen camino de regreso 🚚`);

  // ── Consecuencia documental: Constancia en Mifiel ──
  if (fresco && !datos.noConforme) {
    const enriquecido = {
      id: fresco.id,
      fields: {
        ...fresco.fields,
        __tipoEntrega: datos.tipoEntrega,
        __entregaPersona: usuario.nombre,
        __conformidad: datos.observaciones ? "Conforme con observaciones" : "Conforme sin observaciones"
      }
    };
    await DOC.generarConstancia(enriquecido, clienteFields);
  }
  return true;
}

// ═════════════════════ RAMA 3 · PAGO ═════════════════════
async function iniciarPago(tel, usuario, sesion) {
  const vivas = await operacionesConSaldo(usuario.clienteId);
  if (!vivas.length) {
    await limpiarSesion(sesion, tel, usuario.id);
    return W.texto(tel, "No tienes operaciones con saldo pendiente.");
  }
  const filas = vivas.slice(0, 10).map((r, i) => {
    const s = L.semaforo(r.fields);
    return {
      id: `PG_${i}`,
      titulo: `${r.fields[L.C.O_FOLIO]} · ${(r.fields[L.C.O_COMPRADOR] || "").slice(0, 12)}`,
      descripcion: `${L.dinero(r.fields[L.C.O_SALDO])} · ${s.etiqueta}`
    };
  });
  await guardarSesion(sesion, tel, usuario.id, {
    flujo: "PAGO", paso: "PAGO_OPERACION",
    datos: { candidatos: vivas.slice(0, 10).map(r => ({ id: r.id, f: r.fields })) }
  });
  return W.lista(tel, "¿De cuál operación te reportan pago?", "Con saldo vivo", filas);
}

async function pasoPago(paso, entrada, mensaje, ctx) {
  const { tel, usuario, sesion, datos } = ctx;
  const guardar = (p, d) => guardarSesion(sesion, tel, usuario.id,
    { flujo: "PAGO", paso: p, datos: { ...datos, __inval: 0, ...d } });
  const avanzar = async (siguiente, nuevos) => {
    if (datos.__corr) return resumenPago(ctx, limpio({ ...datos, ...nuevos }));
    await guardar(siguiente, nuevos);
    return preguntar(tel, siguiente, { ...datos, ...nuevos });
  };
  const invalida = aviso => noValida(ctx, "PAGO", paso, aviso);
  const MAPA_MEDIOS = { MP_TRANSFER: "Transferencia", MP_EFECTIVO: "Efectivo", MP_CHEQUE: "Cheque", MP_OTRO: "Otro" };

  switch (paso) {
    case "PAGO_OPERACION": {
      const op = (datos.candidatos || [])[Number(String(entrada).replace("PG_", ""))];
      if (!/^PG_\d+$/.test(entrada) || !op) {
        return W.texto(tel, "Elige la operación de la lista. Escribe *PAGO* para verla de nuevo.");
      }
      await guardar("PAGO_ALCANCE", { operacion: op });
      return preguntar(tel, "PAGO_ALCANCE", { operacion: op });
    }

    case "PAGO_ALCANCE":
      if (entrada === "PAGO_PARTE") {
        await guardar("PAGO_MONTO", {});
        return preguntar(tel, "PAGO_MONTO");
      }
      if (entrada === "PAGO_TODO") {
        return avanzar("PAGO_MEDIO", { monto: Number(datos.operacion.f[L.C.O_SALDO] || 0), parcial: false });
      }
      return invalida("Elige Todo o Una parte.");

    case "PAGO_MONTO": {
      const monto = normalizarMonto(entrada);
      const saldo = Number(datos.operacion.f[L.C.O_SALDO] || 0);
      if (monto === null || monto <= 0) return invalida("Escribe solo el número. Ejemplo: 20000");
      if (monto > saldo) return invalida(`Ese monto supera el saldo vivo (${L.dinero(saldo)}).`);
      return avanzar("PAGO_MEDIO", { monto, parcial: monto < saldo });
    }

    case "PAGO_MEDIO": {
      const medio = MAPA_MEDIOS[entrada];
      if (!medio) return invalida("Elige el medio de pago de la lista.");
      // El comprobante depende del medio: se pide siempre, también al corregir.
      await guardar("PAGO_COMPROBANTE", { medio, comprobante: null, advertencia: null });
      return preguntar(tel, "PAGO_COMPROBANTE", { ...datos, medio });
    }

    case "PAGO_COMPROBANTE": {
      if (mensaje.type === "image" || mensaje.type === "document") {
        const media = mensaje.image || mensaje.document;
        return resumenPago(ctx, limpio({ ...datos, comprobante: { id: media.id }, advertencia: null }));
      }
      if (/^omitir$/i.test(entrada)) {
        if (datos.medio !== "Efectivo") return invalida("Para ese medio necesito el comprobante. Mándame la foto.");
        return resumenPago(ctx, limpio({ ...datos, comprobante: null,
          advertencia: "Sin comprobante, la conciliación puede tardar más." }));
      }
      return invalida("Mándame la foto del comprobante, o escribe OMITIR si es en efectivo.");
    }

    case "PAGO_RESUMEN":
      if (entrada === "CONFIRMAR") return confirmarPago(ctx);
      if (entrada === "CORREGIR") return ofrecerCorreccion(ctx, "PAGO");
      return invalida("Usa los botones: Confirmar, Corregir o Cancelar.");

    case "PAGO_CORREGIR":
      return elegirCorreccion(ctx, "PAGO", entrada, resumenPago);

    default:
      await limpiarSesion(sesion, tel, usuario.id);
      return W.texto(tel, "Perdí el hilo. Escribe *PAGO* para empezar de nuevo.");
  }
}

async function resumenPago(ctx, datos) {
  const { tel, usuario, sesion } = ctx;
  await guardarSesion(sesion, tel, usuario.id, { flujo: "PAGO", paso: "PAGO_RESUMEN", datos });
  const op = datos.operacion.f;
  const restante = Number(op[L.C.O_SALDO] || 0) - datos.monto;
  return W.botones(tel,
    "Revisa:\n" +
    `▪ ${op[L.C.O_FOLIO]} · ${op[L.C.O_COMPRADOR]}\n` +
    `▪ Pago ${datos.parcial ? "PARCIAL" : "TOTAL"} de ${L.dinero(datos.monto)} por ${datos.medio.toLowerCase()}\n` +
    `▪ ${datos.comprobante ? "Comprobante adjunto ✓" : "Sin comprobante"}` +
    (datos.parcial ? ` · Quedarían ${L.dinero(restante)} vivos` : "") +
    (datos.advertencia ? `\n⚠️ ${datos.advertencia}` : ""),
    [
      { id: "CONFIRMAR", titulo: "Confirmar" },
      { id: "CORREGIR", titulo: "Corregir" },
      { id: "CANCELAR_BTN", titulo: "Cancelar" }
    ]);
}

async function confirmarPago(ctx) {
  const { tel, usuario, sesion, datos } = ctx;
  const C = L.C;
  const op = datos.operacion;

  // REGLA DE CONCILIACIÓN (§5): lo reportado por WhatsApp NO liquida.
  // Solo el webhook de Stripe tiene esa facultad directa.
  let pago;
  try {
    pago = await L.airtable("POST", L.T.PAGOS, {
      cuerpo: { fields: {
        [C.P_OPERACION]: [op.id],
        [C.P_MONTO]: datos.monto,
        [C.P_MEDIO]: datos.medio,
        [C.P_REPORTO]: [usuario.id],
        [C.P_ESTATUS]: "Por conciliar",
        [C.P_NOTAS]: [
          op.f[C.O_ESTATUS_PAGO] === "En disputa"
            ? "OPERACIÓN EN DISPUTA: requiere atención del despacho (puede formar parte del arreglo del Protocolo de Controversia)." : "",
          datos.advertencia || ""
        ].filter(Boolean).join(" ")
      } }
    });
  } catch (e) {
    console.error("pago:", e.message);
    return W.texto(tel, "No pude registrar el reporte. Inténtalo de nuevo en un momento.");
  }

  if (datos.comprobante) {
    try {
      const archivo = await W.descargarMedio(datos.comprobante.id);
      await L.subirAdjunto(pago.id, C.P_COMPROBANTE, archivo);
    } catch (e) { console.error("comprobante:", e.message); }
  }

  // La bitácora se relee: la lista de selección no la trae, y anexar sobre un
  // valor vacío BORRARÍA el historial probatorio de la operación.
  const fresca = await L.airtable("GET", L.T.OPERACIONES, { id: op.id }).catch(() => null);
  await L.airtable("PATCH", L.T.OPERACIONES, {
    id: op.id,
    cuerpo: { fields: {
      [C.O_BITACORA]: L.anexarBitacora(fresca ? fresca.fields[C.O_BITACORA] : op.f[C.O_BITACORA],
        `Pago reportado por WhatsApp · ${L.dinero(datos.monto)} · ${datos.medio} · ${usuario.nombre} · POR CONCILIAR` +
          (op.f[C.O_ESTATUS_PAGO] === "En disputa" ? " · operación en disputa: atención del despacho" : ""))
    } }
  }).catch(e => console.error("bitácora pago:", e.message));

  await limpiarSesion(sesion, tel, usuario.id);

  const fresco = await L.airtable("GET", L.T.PAGOS, { id: pago.id }).catch(() => null);
  const folioPR = (fresco && fresco.fields[C.P_FOLIO]) || pago.id.slice(-6).toUpperCase();

  return W.texto(tel,
    "Pago reportado ✅ Queda en conciliación.\n" +
    "Cuando administración lo confirme contra el banco, verás el saldo actualizado " +
    `en tu panel. El folio del reporte es ${folioPR}.`);
}

// ═════════════════════ Despachador ═════════════════════
async function procesarMensaje(mensaje, contacto) {
  const tel = W.soloDigitos(mensaje.from).slice(-10);
  const de = mensaje.from;                 // número completo, para responder
  const entrada = textoDe(mensaje);

  // Identidad: número registrado y activo (§2.3). Respuesta neutra si no.
  const usuarios = await L.listar(L.T.USUARIOS,
    `AND(RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({${L.C.U_TEL}} & "", "+", ""), " ", ""), "-", ""), 10) = ${L.escFormula(tel)}, {${L.C.U_ACTIVO}})`,
    [L.C.U_NOMBRE, L.C.U_CLIENTE, L.C.U_ROL, L.C.U_TEL]);
  if (usuarios.length !== 1) {
    return W.texto(de, "Este canal atiende únicamente a personal registrado.\n" +
      "Si crees que deberías tener acceso, pide a tu administrador que te dé de alta.");
  }
  const u = usuarios[0];
  const clienteId = (u.fields[L.C.U_CLIENTE] || [])[0];
  if (!clienteId) return W.texto(de, "Tu usuario no tiene cliente asignado. Avisa a tu administrador.");
  const usuario = { id: u.id, nombre: u.fields[L.C.U_NOMBRE] || "", rol: u.fields[L.C.U_ROL] || "Dirección", clienteId };
  const primerNombre = usuario.nombre.split(" ")[0];

  // Idempotencia: un mensaje reentregado por Meta no se procesa dos veces.
  let sesion = await cargarSesion(tel);
  const idem = await yaProcesado(sesion, tel, usuario.id, mensaje.id);
  if (idem.visto) { console.log("whatsapp-entrante: mensaje repetido ignorado", mensaje.id); return; }
  sesion = idem.sesion;

  const clienteReg = await L.airtable("GET", L.T.CLIENTES, { id: clienteId }).catch(() => null);
  const clienteFields = clienteReg ? clienteReg.fields : {};
  const nombreCliente = clienteFields[L.C.CL_NOMBRE] || "tu empresa";

  // Consulta de estatus: disponible incluso en modo histórico.
  const mEstatus = COMANDOS.ESTATUS.exec(entrada);
  if (mEstatus) return responderEstatus(de, mEstatus[1].toUpperCase(), usuario);

  // Modo histórico (§4.4 del Pliego): suscripción vencida = solo consulta.
  if (clienteFields[L.C.CL_SUSCRIPCION] === "Histórico") {
    return W.texto(de, "La suscripción está vencida, así que el registro de nuevas operaciones " +
      "está pausado. Puedes consultar con *ESTATUS OP-0000*. Contacta al despacho para reactivar.");
  }

  // §2.4: un flujo inconcluso caduca a las 24 h y se descarta CON AVISO.
  if (sesion && sesion.caduca && sesion.flujo) {
    const flujoPrevio = sesion.flujo;
    await limpiarSesion(sesion, tel, usuario.id);
    sesion = { ...sesion, flujo: null, paso: null, datos: {} };
    await W.texto(de, `Tu ${NOMBRE_FLUJO[flujoPrevio] || "captura"} anterior quedó sin confirmar ` +
      "por más de 24 horas y la descarté. No se guardó nada.");
  }
  const enFlujo = !!(sesion && sesion.flujo && sesion.paso);

  // ── Comandos globales (§2.2) ──
  if (COMANDOS.CANCELAR.test(entrada) || entrada === "CANCELAR_BTN") {
    await limpiarSesion(sesion, tel, usuario.id);
    return W.texto(de, enFlujo ? "Listo, cancelé lo que estábamos haciendo. No guardé nada."
      : "No había nada en curso. Escribe *MENÚ* para ver las opciones.");
  }
  if (COMANDOS.AYUDA.test(entrada)) return ayuda(de);
  if (entrada === "MENU_SI") {
    await limpiarSesion(sesion, tel, usuario.id);
    return menu(de, primerNombre, nombreCliente, usuario);
  }
  if (COMANDOS.MENU.test(entrada)) {
    if (enFlujo) {      // §2.2: con flujo en curso, preguntar antes de descartarlo
      return W.botones(de, `Tienes un ${NOMBRE_FLUJO[sesion.flujo]} en curso. ¿Lo descarto y voy al menú?`,
        [{ id: "MENU_SI", titulo: "Sí, ir al menú" }, { id: "SEGUIR", titulo: "Seguir aquí" }]);
    }
    return menu(de, primerNombre, nombreCliente, usuario);
  }

  const ctx = { tel: de, usuario, sesion, cliente: nombreCliente, clienteFields,
    datos: (sesion && sesion.datos) || {} };

  // «Seguir» tras un aviso: se repite la pregunta del paso actual.
  if (entrada === "SEGUIR" && enFlujo) {
    await guardarSesion(sesion, de, usuario.id, { flujo: sesion.flujo, paso: sesion.paso,
      datos: { ...ctx.datos, __inval: 0 } });
    if (/_RESUMEN$/.test(sesion.paso)) {
      const r = { ALTA: resumenAlta, ENTREGA: resumenEntrega, PAGO: resumenPago }[sesion.flujo];
      return r(ctx, limpio(ctx.datos));
    }
    return preguntar(de, sesion.paso, ctx.datos);
  }

  // ── Inicio de rama (atajos o botones del menú), con permisos por rol ──
  const iniciar = { ALTA: iniciarAlta, ENTREGA: iniciarEntrega, PAGO: iniciarPago };
  for (const rama of ["ALTA", "ENTREGA", "PAGO"]) {
    if (COMANDOS[rama].test(entrada) || entrada === rama) {
      if (!puede(usuario, rama)) return sinPermiso(de, rama);
      return iniciar[rama](de, usuario, sesion);
    }
  }

  // ── Continuación de flujo ──
  if (enFlujo) {
    // §2.4: al volver después de un rato, se retoma en el paso exacto y se
    // recuerda que se puede cancelar.
    if (sesion.actualizado && Date.now() - sesion.actualizado > 30 * 60e3) {
      await W.texto(de, `Seguimos con tu ${NOMBRE_FLUJO[sesion.flujo]} donde lo dejamos. ` +
        "Si prefieres empezar de nuevo, escribe CANCELAR.");
    }
    if (sesion.flujo === "ALTA") return pasoAlta(sesion.paso, entrada, mensaje, ctx);
    if (sesion.flujo === "ENTREGA") return pasoEntrega(sesion.paso, entrada, mensaje, ctx);
    if (sesion.flujo === "PAGO") return pasoPago(sesion.paso, entrada, mensaje, ctx);
  }

  // ── Foto sin contexto (§2.5): se conserva para la entrega ──
  if (mensaje.type === "image" || mensaje.type === "document") {
    const media = mensaje.image || mensaje.document;
    await guardarSesion(sesion, de, usuario.id, { flujo: null, paso: "",
      datos: { __fotoSuelta: { id: media.id, tipo: mensaje.type } } });
    if (!puede(usuario, "ENTREGA")) return W.texto(de, "Recibí el archivo, pero no hay nada en curso.");
    return W.botones(de, "Recibí una foto. ¿Quieres registrar una entrega con ella?",
      [{ id: "ENTREGA", titulo: "Sí, registrar" }, { id: "CANCELAR_BTN", titulo: "No" }]);
  }

  return menu(de, primerNombre, nombreCliente, usuario);
}

// ═════════════════════ Handler ═════════════════════
// Uso interno: /api/formulario-recibido retoma la conversación con estas piezas.
exports.interno = { guardarSesion, resumenAlta, aComprador, aAval, enviarLigaFormulario };

exports.handler = async (evento) => {
  // Handshake de suscripción del webhook (Meta llama con GET una sola vez)
  if (evento.httpMethod === "GET") {
    const q = evento.queryStringParameters || {};
    const esperado = process.env.WHATSAPP_VERIFY_TOKEN || "";
    if (q["hub.mode"] === "subscribe" && esperado &&
        L.igualSeguro(String(q["hub.verify_token"] || ""), esperado)) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: q["hub.challenge"] || "" };
    }
    return { statusCode: 403, body: "" };
  }

  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });

  const cuerpoCrudo = evento.isBase64Encoded
    ? Buffer.from(evento.body || "", "base64").toString("utf8")
    : (evento.body || "");

  // Firma de Meta: sin esto, cualquiera podría inyectar mensajes falsos
  const firma = evento.headers["x-hub-signature-256"] || evento.headers["X-Hub-Signature-256"];
  const v = W.firmaValida(cuerpoCrudo, firma);
  if (!v.ok) {
    console.warn("whatsapp-entrante: firma rechazada —", v.razon);
    return { statusCode: 403, body: "" };
  }

  let payload;
  try { payload = JSON.parse(cuerpoCrudo); }
  catch { return { statusCode: 200, body: "" }; }

  try {
    for (const entry of payload.entry || []) {
      for (const cambio of entry.changes || []) {
        const valor = cambio.value || {};
        const contactos = valor.contacts || [];
        for (const mensaje of valor.messages || []) {
          await procesarMensaje(mensaje, contactos[0]).catch(e => {
            console.error("procesarMensaje:", e.message);
            return W.texto(mensaje.from,
              "Tuve un problema técnico. Intenta de nuevo en un momento.").catch(() => {});
          });
        }
      }
    }
  } catch (e) {
    console.error("whatsapp-entrante:", e.message);
  }

  // Siempre 200: un error nuestro no debe hacer que Meta reintente en bucle
  return { statusCode: 200, body: "" };
};
