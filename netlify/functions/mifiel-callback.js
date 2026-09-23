// mifiel-callback.js — receptor del webhook NATIVO de Mifiel.
// Sustituye por completo al antiguo Zap "Firma completada". Las URLs se
// declaran al crear cada documento (_documentos.js), no en el panel de Mifiel.
//
// Validación de origen en tres capas. La tercera es la decisiva: el estado NO
// se toma del payload entrante sino de GET /documents/{id} con credenciales
// propias. Una suplantación del webhook no puede alterar la cartera.
"use strict";
const crypto = require("crypto");
const L = require("./_lib.js");
const M = require("./_mifiel.js");

const DOCS = [
  { clave: "ficha", idCampo: L.C.O_FICHA_MIFIEL, estatus: L.C.O_FICHA_FIRMA,
    sello: L.C.O_SELLO_FICHA, etiqueta: "Ficha de Operación" },
  { clave: "pagare", idCampo: L.C.O_PAGARE_MIFIEL, estatus: L.C.O_PAGARE_FIRMA,
    sello: L.C.O_SELLO_PAGARE, etiqueta: "Pagaré Agro", hash: L.C.O_HASH_PAGARE },
  { clave: "constancia", idCampo: L.C.O_CONST_MIFIEL, estatus: L.C.O_CONST_ESTATUS,
    sello: L.C.O_SELLO_CONST, etiqueta: "Constancia de Recepción" }
];

async function localizarOperacion(documentoId) {
  for (const doc of DOCS) {
    const regs = await L.listar(L.T.OPERACIONES,
      `{${doc.idCampo}} = ${L.escFormula(documentoId)}`,
      [L.C.O_FOLIO, L.C.O_BITACORA, doc.estatus]).catch(() => []);
    if (regs.length === 1) return { registro: regs[0], doc };
  }
  return null;
}

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });

  // Capa 1: token compartido en el query string
  const token = (evento.queryStringParameters || {}).t || "";
  if (!L.igualSeguro(token, process.env.MIFIEL_CALLBACK_TOKEN || "")) {
    console.warn("mifiel-callback: token de origen inválido");
    return L.json(404, { error: "No encontrado." });
  }

  const cuerpoCrudo = evento.isBase64Encoded
    ? Buffer.from(evento.body || "", "base64").toString("utf8")
    : (evento.body || "");

  // Capa 2: firma HMAC de cabecera, si Mifiel la emite y está configurada
  const secretoWebhook = process.env.MIFIEL_WEBHOOK_SECRET;
  if (secretoWebhook) {
    const recibida = evento.headers["x-mifiel-signature"] || evento.headers["X-Mifiel-Signature"];
    if (recibida) {
      const esperada = crypto.createHmac("sha256", secretoWebhook).update(cuerpoCrudo).digest("hex");
      if (!L.igualSeguro(String(recibida).trim().toLowerCase(), esperada)) {
        console.warn("mifiel-callback: firma HMAC no coincide");
        return L.json(404, { error: "No encontrado." });
      }
    }
  }

  let payload;
  try { payload = JSON.parse(cuerpoCrudo || "{}"); }
  catch { return L.json(400, { error: "Contenido no interpretable." }); }

  const documentoId = payload.id || payload.document_id || (payload.document || {}).id;
  if (!documentoId) return L.json(400, { error: "Falta el identificador del documento." });

  try {
    // Capa 3: la verdad se toma de la API, nunca del payload entrante
    let confirmado;
    try {
      confirmado = await M.consultarDocumento(documentoId);
    } catch (e) {
      console.error("mifiel-callback: reconfirmación no disponible:", e.message);
      // Sin reconfirmación NO se escribe: preferimos perder el evento —que
      // Mifiel reintentará— a corromper la cartera.
      return L.json(503, { error: "Reconfirmación no disponible; reintentar." });
    }

    const ubicacion = await localizarOperacion(documentoId);
    if (!ubicacion) {
      console.warn("mifiel-callback: documento sin operación asociada:", documentoId);
      return L.json(200, { mensaje: "Recibido." });
    }
    const { registro, doc } = ubicacion;

    const todosFirmaron = confirmado.signed === true || confirmado.status === "signed";
    const campos = {};
    let textoEvento;

    if (todosFirmaron) {
      campos[doc.estatus] = (doc.clave === "constancia") ? "Registrada" : "Firmada";
      const sello = confirmado.signed_at || confirmado.signed_by_all_at ||
        (confirmado.conservation_record || {}).timestamp || null;
      if (sello) campos[doc.sello] = String(sello);
      if (doc.hash && confirmado.original_hash) campos[doc.hash] = String(confirmado.original_hash);
      textoEvento = `${doc.etiqueta} firmada por todas las partes (Mifiel ${documentoId})`;
    } else {
      const firmantes = Array.isArray(confirmado.signers) ? confirmado.signers : [];
      const yaFirmaron = firmantes.filter(s => s.signed).length;
      campos[doc.estatus] = doc.clave === "constancia" ? "Pendiente" : "Enviada";
      textoEvento = `${doc.etiqueta}: firma parcial ${yaFirmaron}/${firmantes.length || "?"}`;
    }

    campos[L.C.O_BITACORA] = L.anexarBitacora(registro.fields[L.C.O_BITACORA], textoEvento);

    await L.airtable("PATCH", L.T.OPERACIONES, { id: registro.id, cuerpo: { fields: campos } });
    console.log(`mifiel-callback: ${registro.fields[L.C.O_FOLIO]} · ${textoEvento}`);
    return L.json(200, { mensaje: "Procesado." });
  } catch (e) {
    console.error("mifiel-callback:", e.message);
    return L.json(500, { error: "Error al procesar." });
  }
};
