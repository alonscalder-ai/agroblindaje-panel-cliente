// _mifiel.js — cliente de la API de Mifiel.
// Sustituye por completo al antiguo Zap "Alta de operación": la misma función
// que crea el registro llama aquí en la misma ejecución (§9 del Pliego v2).
//
// Autenticación: esquema APIAuth propio de Mifiel — HMAC-SHA1 sobre la cadena
// canónica "método,content-type,MD5(cuerpo),ruta,fecha".
"use strict";
const crypto = require("crypto");

const BASE = () => process.env.MIFIEL_API_URL || "https://www.mifiel.com/api/v1";

function encabezados(metodo, ruta, cuerpo = "") {
  const appId = process.env.MIFIEL_APP_ID;
  const secreto = process.env.MIFIEL_APP_SECRET;
  const fecha = new Date().toUTCString();
  const md5 = crypto.createHash("md5").update(cuerpo).digest("hex");
  const canonica = `${metodo},application/json,${md5},${ruta},${fecha}`;
  const firma = crypto.createHmac("sha1", secreto).update(canonica).digest("hex");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-MD5": md5,
    Date: fecha,
    Authorization: `APIAuth ${appId}:${firma}`
  };
}

async function peticion(metodo, rutaRelativa, cuerpoObj) {
  const cuerpo = cuerpoObj ? JSON.stringify(cuerpoObj) : "";
  const ruta = `/api/v1${rutaRelativa}`;
  const r = await fetch(`${BASE()}${rutaRelativa}`, {
    method: metodo,
    headers: encabezados(metodo, ruta, cuerpo),
    body: cuerpo || undefined
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    throw new Error(`Mifiel ${r.status}: ${detalle.slice(0, 300)}`);
  }
  return r.json();
}

const consultarDocumento = id => peticion("GET", `/documents/${encodeURIComponent(id)}`);

// Crea un documento a partir de una plantilla, con sus campos de fusión y
// firmantes. Declara las URLs de notificación: Mifiel avisa por sí mismo al
// completarse la firma, sin que haya que consultar la API en intervalos.
function crearDesdePlantilla({ plantillaId, campos, firmantes, externalId, callbackUrl }) {
  return peticion("POST", "/documents", {
    template_id: plantillaId,
    fields: campos,
    signatories: firmantes.map(f => ({
      name: f.nombre,
      email: f.correo,
      tax_id: f.rfc || undefined
    })),
    external_id: externalId,
    callback_url: callbackUrl,
    sign_callback_url: callbackUrl,
    send_invites: true
  });
}

module.exports = { peticion, consultarDocumento, crearDesdePlantilla };
