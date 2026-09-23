// _whatsapp.js — cliente de WhatsApp Cloud API (directo, sin BSP).
// Llamado por whatsapp-entrante.js, acceso-solicitar.js y alertas-diarias.js.
// Ir directo a Meta evita el sobreprecio por mensaje de los proveedores
// intermediarios (regla §16.6 del Pliego v2).
"use strict";
const crypto = require("crypto");

const API = "https://graph.facebook.com/v21.0";
const TOKEN = () => process.env.WHATSAPP_TOKEN;
const PHONE_ID = () => process.env.WHATSAPP_PHONE_ID;

const soloDigitos = t => String(t || "").replace(/\D/g, "");

async function enviar(cuerpo) {
  const r = await fetch(`${API}/${PHONE_ID()}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...cuerpo })
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    console.error("WhatsApp envío falló:", r.status, detalle.slice(0, 300));
    return false;
  }
  return true;
}

// Mensaje de texto simple (dentro de la ventana de atención).
const texto = (a, cuerpo) =>
  enviar({ to: soloDigitos(a), type: "text", text: { body: cuerpo, preview_url: false } });

// Botones de respuesta rápida. Límite de la plataforma: 3 botones, 20 car. c/u.
function botones(a, cuerpo, opciones) {
  return enviar({
    to: soloDigitos(a),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: cuerpo },
      action: {
        buttons: opciones.slice(0, 3).map(o => ({
          type: "reply",
          reply: { id: o.id, title: o.titulo.slice(0, 20) }
        }))
      }
    }
  });
}

// Lista desplegable. Límite de la plataforma: 10 filas, título 24 car.
function lista(a, cuerpo, etiquetaBoton, filas) {
  return enviar({
    to: soloDigitos(a),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: cuerpo },
      action: {
        button: etiquetaBoton.slice(0, 20),
        sections: [{
          rows: filas.slice(0, 10).map(f => ({
            id: f.id,
            title: f.titulo.slice(0, 24),
            description: (f.descripcion || "").slice(0, 72)
          }))
        }]
      }
    }
  });
}

// Plantilla preaprobada (fuera de la ventana de atención).
function plantilla(a, nombre, variables = [], idioma = "es_MX") {
  return enviar({
    to: soloDigitos(a),
    type: "template",
    template: {
      name: nombre,
      language: { code: idioma },
      components: variables.length
        ? [{ type: "body", parameters: variables.map(v => ({ type: "text", text: String(v) })) }]
        : []
    }
  });
}

// Plantilla con botón de URL dinámica. En Meta la plantilla se define con un
// botón "Visitar sitio web" cuya URL termina en {{1}}, p. ej.
// https://<sitio>/c/{{1}}; aquí se envía solo el sufijo (el token de la liga).
function plantillaConBoton(a, nombre, variables, sufijoUrl, idioma = "es_MX") {
  return enviar({
    to: soloDigitos(a),
    type: "template",
    template: {
      name: nombre,
      language: { code: idioma },
      components: [
        { type: "body", parameters: variables.map(v => ({ type: "text", text: String(v) })) },
        { type: "button", sub_type: "url", index: "0",
          parameters: [{ type: "text", text: String(sufijoUrl) }] }
      ]
    }
  });
}

// Descarga un medio (foto/documento) en dos pasos: la URL que devuelve Meta es
// temporal y exige el token, por eso el archivo se recarga a Airtable en base64.
async function descargarMedio(mediaId) {
  const meta = await fetch(`${API}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` }
  });
  if (!meta.ok) throw new Error(`media meta ${meta.status}`);
  const info = await meta.json();
  const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${TOKEN()}` } });
  if (!bin.ok) throw new Error(`media bin ${bin.status}`);
  const buf = Buffer.from(await bin.arrayBuffer());
  return {
    base64: buf.toString("base64"),
    tipo: info.mime_type || "application/octet-stream",
    nombre: info.file_name || `evidencia-${mediaId}.jpg`,
    bytes: buf.length
  };
}

// Verificación de la firma del webhook entrante (X-Hub-Signature-256).
// Sin esto, cualquiera podría inyectar mensajes falsos al motor conversacional.
function firmaValida(cuerpoCrudo, cabecera) {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto) return { ok: false, razon: "WHATSAPP_APP_SECRET no configurado" };
  if (!cabecera) return { ok: false, razon: "falta X-Hub-Signature-256" };
  const recibida = String(cabecera).replace(/^sha256=/, "").trim().toLowerCase();
  const esperada = crypto.createHmac("sha256", secreto).update(cuerpoCrudo, "utf8").digest("hex");
  const a = Buffer.from(recibida), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, razon: "firma no coincide" };
  }
  return { ok: true };
}

module.exports = { texto, botones, lista, plantilla, plantillaConBoton, descargarMedio, firmaValida, soloDigitos };
