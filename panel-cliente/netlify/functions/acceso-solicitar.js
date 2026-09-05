// acceso-solicitar.js — paso 1 del acceso sin contraseña (§4.1)
// Respuesta SIEMPRE idéntica exista o no el usuario (no revelar el padrón).
"use strict";
const L = require("./_lib.js");

const RESPUESTA_NEUTRA = L.json(200, {
  mensaje: "Si el dato es correcto, recibirás un código por WhatsApp en un momento."
});

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });
  let contacto = "";
  try { contacto = String(JSON.parse(evento.body || "{}").contacto || "").trim(); } catch { /* ignorar */ }
  if (!contacto) return RESPUESTA_NEUTRA;

  try {
    const esCorreo = contacto.includes("@");
    // Normalizar teléfono a dígitos finales para tolerar +52 / 52 / 10 dígitos
    const digitos = contacto.replace(/\D/g, "").slice(-10);
    const filtro = esCorreo
      ? `LOWER({${L.C.U_CORREO}}) = ${L.escFormula(contacto.toLowerCase())}`
      : `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({${L.C.U_TEL}} & "", "+", ""), " ", ""), "-", ""), 10) = ${L.escFormula(digitos)}`;

    const usuarios = await L.listar(L.T.USUARIOS, `AND(${filtro}, {${L.C.U_ACTIVO}})`,
      [L.C.U_NOMBRE, L.C.U_TEL, L.C.U_CORREO]);

    if (usuarios.length === 1) {
      const u = usuarios[0];
      const codigo = String(Math.floor(100000 + Math.random() * 900000));
      await L.airtable("PATCH", L.T.USUARIOS, {
        id: u.id,
        cuerpo: { fields: {
          [L.C.U_HASH]: L.sha256(codigo),
          [L.C.U_EXPIRA]: new Date(Date.now() + 10 * 60e3).toISOString()
        } }
      });
      // El envío lo hace Zapier (Zap "Envío de código de acceso") por WhatsApp (decisión §15.2)
      await fetch(process.env.ZAPIER_OTP_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SSCAE-Secreto": process.env.ZAPIER_WEBHOOK_SECRET },
        body: JSON.stringify({
          nombre: u.fields[L.C.U_NOMBRE] || "",
          telefono: u.fields[L.C.U_TEL] || "",
          correo: u.fields[L.C.U_CORREO] || "",
          codigo
        })
      }).catch(() => { /* el envío fallido no cambia la respuesta neutra */ });
    }
  } catch (e) { console.error(e.message); }

  return RESPUESTA_NEUTRA; // misma respuesta en todos los caminos
};
