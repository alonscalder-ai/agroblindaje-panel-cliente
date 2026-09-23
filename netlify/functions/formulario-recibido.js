// formulario-recibido.js — cierre del circuito formulario → conversación.
// ════════════════════════════════════════════════════════════════════════════
// Lo invoca una automatización NATIVA de Airtable ("Cuando se envía un
// formulario" → "Ejecutar script") con el id del registro creado en Contrapartes.
//
// Reglas de confianza, las mismas de los webhooks de Mifiel y Stripe:
//   1. El aviso se autentica con AUTOMATIZACION_SECRET (defensa en profundidad).
//   2. NUNCA se cree al cuerpo del aviso: el registro se relee de Airtable.
//   3. La autoridad es el TOKEN FIRMADO que viajó oculto en la liga. El
//      formulario es público; sin token válido, lo capturado no entra a la
//      cartera de ningún cliente. El tipo (Comprador/Aval) y el cliente salen
//      del token, no de lo que el formulario diga.
//
// Si los datos son válidos, el registro queda en el catálogo del cliente y la
// conversación de WhatsApp continúa sola. Si no, el bot explica qué corregir y
// reenvía la liga con lo ya capturado prellenado.
"use strict";
const L = require("./_lib.js");
const W = require("./_whatsapp.js");
const { interno: F } = require("./whatsapp-entrante.js");

const OK = L.json(200, { recibido: true });
const PASO_ESPERADO = { Comprador: "ALTA_ESPERA_CONTRAPARTE", Aval: "ALTA_ESPERA_AVAL" };

function validar(k, tipo) {
  const errores = [];
  const nombre = String(k[L.C.K_NOMBRE] || "").trim();
  if (nombre.length < 3) errores.push("el nombre o razón social está vacío o incompleto");
  const rfc = L.validarRFC(k[L.C.K_RFC]);
  if (!rfc.ok) errores.push(`el RFC «${rfc.valor || "(vacío)"}» no tiene un formato válido`);
  const dom = String(k[L.C.K_DOM] || "").trim();
  // El domicilio es donde se emplaza en juicio: se exige que sea localizable.
  if (dom.length < 15 || !/\d/.test(dom)) {
    errores.push("el domicilio debe ser completo (calle, número, colonia, municipio y código postal)");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(k[L.C.K_CORREO] || ""))) {
    errores.push(tipo === "Aval"
      ? "el correo del aval es obligatorio: sin él no se le puede invitar a firmar el Pagaré"
      : "el correo es obligatorio: a él llega la solicitud de firma");
  }
  if (tipo === "Comprador" && String(k[L.C.K_TEL] || "").replace(/\D/g, "").length < 10) {
    errores.push("el teléfono debe tener 10 dígitos");
  }
  if (tipo === "Aval" && String(k[L.C.K_IDENT] || "").trim().length < 5) {
    errores.push("falta la identificación oficial del aval (tipo y número)");
  }
  return { errores, rfc: rfc.valor };
}

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });

  const secreto = evento.headers["x-sscae-secreto"] || evento.headers["X-SSCAE-Secreto"] || "";
  if (!L.igualSeguro(secreto, process.env.AUTOMATIZACION_SECRET || "")) {
    return L.json(404, { error: "No encontrado." });
  }

  let recordId = "";
  try { recordId = String(JSON.parse(evento.body || "{}").recordId || ""); } catch { /* ignorar */ }
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) return L.json(400, { error: "recordId inválido." });

  try {
    // Regla 2: releer, no creer
    const reg = await L.airtable("GET", L.T.CONTRAPARTES, { id: recordId }).catch(() => null);
    if (!reg) return OK;
    const k = reg.fields;
    if (k[L.C.K_ESTATUS] === "Validada") return OK;            // idempotencia

    // Regla 3: el token manda
    const t = L.leerToken(k[L.C.K_TOKEN], process.env.FORMULARIOS_SECRET);
    if (!t || !t.s || !t.c || !t.u || !PASO_ESPERADO[t.k]) {
      await L.airtable("PATCH", L.T.CONTRAPARTES, { id: recordId, cuerpo: { fields: {
        [L.C.K_ESTATUS]: "Rechazada",
        [L.C.K_MOTIVO]: "Liga vencida, alterada o enviada sin pasar por WhatsApp"
      } } }).catch(() => {});
      return OK;   // no hay sesión confiable a la cual avisar
    }
    const tipo = t.k;

    // Usuario del token: activo y del mismo cliente
    const usuario = await L.airtable("GET", L.T.USUARIOS, { id: t.u }).catch(() => null);
    if (!usuario || !usuario.fields[L.C.U_ACTIVO] ||
        (usuario.fields[L.C.U_CLIENTE] || [])[0] !== t.c) {
      await L.airtable("PATCH", L.T.CONTRAPARTES, { id: recordId, cuerpo: { fields: {
        [L.C.K_ESTATUS]: "Rechazada", [L.C.K_MOTIVO]: "Usuario inactivo o sin relación con el cliente"
      } } }).catch(() => {});
      return OK;
    }
    const telVendedor = usuario.fields[L.C.U_TEL];
    const u = { id: usuario.id, clienteId: t.c, nombre: usuario.fields[L.C.U_NOMBRE] || "" };

    const { errores, rfc } = validar(k, tipo);
    const sesion = await L.airtable("GET", L.T.SESIONES, { id: t.s }).catch(() => null);
    const sigueEsperando = sesion &&
      sesion.fields[L.C.S_FLUJO] === "ALTA" &&
      sesion.fields[L.C.S_PASO] === PASO_ESPERADO[tipo];

    // ── Datos inválidos: explicar y reenviar con lo capturado prellenado ──
    if (errores.length) {
      await L.airtable("PATCH", L.T.CONTRAPARTES, { id: recordId, cuerpo: { fields: {
        [L.C.K_ESTATUS]: "Rechazada", [L.C.K_MOTIVO]: errores.join("; ")
      } } }).catch(() => {});
      if (sigueEsperando && telVendedor) {
        const previo = {};
        for (const [campo, clave] of [["Nombre o razón social", L.C.K_NOMBRE], ["RFC", L.C.K_RFC],
          ["Domicilio", L.C.K_DOM], ["Representante", L.C.K_REP], ["Identificación", L.C.K_IDENT],
          ["Teléfono", L.C.K_TEL], ["Correo", L.C.K_CORREO]]) {
          if (k[clave]) previo[campo] = k[clave];
        }
        await F.enviarLigaFormulario(telVendedor, tipo, t.s, u, previo,
          `Recibí el formulario, pero hay que corregir: ${errores.join("; ")}.\n` +
          "Te dejo una liga nueva con lo que ya capturaste; solo corrige lo señalado.");
      }
      return OK;
    }

    // ── Datos válidos: al catálogo del cliente ──
    await L.airtable("PATCH", L.T.CONTRAPARTES, { id: recordId, cuerpo: { fields: {
      [L.C.K_RFC]: rfc,
      [L.C.K_TIPO]: tipo,                 // el del token, no el del formulario
      [L.C.K_CLIENTE]: [t.c],
      [L.C.K_ESTATUS]: "Validada",
      [L.C.K_MOTIVO]: ""
    } } });
    const kValida = { ...k, [L.C.K_RFC]: rfc };

    // El vendedor pudo haber cancelado mientras tanto: el registro se conserva
    // en el catálogo (sirve para la próxima venta) y no se retoma nada.
    if (!sigueEsperando || !telVendedor) return OK;

    let datos = {};
    try { datos = JSON.parse(sesion.fields[L.C.S_DATOS] || "{}"); } catch { datos = {}; }
    const ctx = { tel: telVendedor, usuario: u, sesion: { id: sesion.id }, datos };

    if (tipo === "Comprador") {
      await F.guardarSesion({ id: sesion.id }, telVendedor, u.id, {
        flujo: "ALTA", paso: "ALTA_DESCRIPCION",
        datos: { ...datos, contraparte: F.aComprador(kValida) }
      });
      await W.texto(telVendedor,
        `Recibí los datos de ${k[L.C.K_NOMBRE]} ✓ Ya quedó en tu lista para próximas ventas.\n` +
        "¿Qué le vas a vender? Descríbelo en una línea.\nEjemplo: Fertilizante triple 17, saco de 50 kg");
    } else {
      await F.resumenAlta(ctx, { ...datos, aval: F.aAval(kValida) });
    }
    return OK;
  } catch (e) {
    console.error("formulario-recibido:", e.message);
    // 500 → la automatización de Airtable marca error y puede reintentarse a mano
    return L.json(500, { error: "Error al procesar." });
  }
};
