// acceso-validar.js — paso 2: valida el código de un solo uso y emite la cookie
// de sesión firmada (24 h, decisión §15.3). Bloqueo a partir de 5 intentos (§4.2).
"use strict";
const L = require("./_lib.js");

const RECHAZO = L.json(401, { error: "Código incorrecto o vencido. Solicita uno nuevo." });

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });
  let contacto = "", codigo = "";
  try {
    const b = JSON.parse(evento.body || "{}");
    contacto = String(b.contacto || "").trim();
    codigo = String(b.codigo || "").trim();
  } catch { /* ignorar */ }
  if (!contacto || !/^\d{6}$/.test(codigo)) return RECHAZO;

  try {
    const esCorreo = contacto.includes("@");
    const digitos = contacto.replace(/\D/g, "").slice(-10);
    const filtro = esCorreo
      ? `LOWER({${L.C.U_CORREO}}) = ${L.escFormula(contacto.toLowerCase())}`
      : `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({${L.C.U_TEL}} & "", "+", ""), " ", ""), "-", ""), 10) = ${L.escFormula(digitos)}`;
    const usuarios = await L.listar(L.T.USUARIOS, `AND(${filtro}, {${L.C.U_ACTIVO}})`,
      [L.C.U_NOMBRE, L.C.U_ROL, L.C.U_CLIENTE, L.C.U_HASH, L.C.U_EXPIRA, L.C.U_INTENTOS]);
    if (usuarios.length !== 1) return RECHAZO;

    const u = usuarios[0];
    const intentos = u.fields[L.C.U_INTENTOS] || 0;
    const expira = u.fields[L.C.U_EXPIRA] ? new Date(u.fields[L.C.U_EXPIRA]) : null;

    // Bloqueo temporal: 5+ fallos dentro de la ventana del código vigente
    if (intentos >= 5 && expira && Date.now() < expira.getTime() + 15 * 60e3) {
      return L.json(429, { error: "Demasiados intentos. Espera 15 minutos y solicita un código nuevo." });
    }
    const hashOk = u.fields[L.C.U_HASH] && u.fields[L.C.U_HASH] === L.sha256(codigo);
    const vigente = expira && Date.now() < expira.getTime();

    if (!hashOk || !vigente) {
      await L.airtable("PATCH", L.T.USUARIOS, { id: u.id, cuerpo: { fields: { [L.C.U_INTENTOS]: intentos + 1 } } }).catch(() => {});
      return RECHAZO;
    }

    // Éxito: consumir el código, limpiar intentos, registrar acceso
    await L.airtable("PATCH", L.T.USUARIOS, { id: u.id, cuerpo: { fields: {
      [L.C.U_HASH]: "", [L.C.U_INTENTOS]: 0,
      [L.C.U_ULTIMO]: new Date().toISOString()
    } } });

    const clienteId = (u.fields[L.C.U_CLIENTE] || [])[0];
    if (!clienteId) return RECHAZO;

    const token = L.firmarSesion({
      u: u.id, c: clienteId,
      r: u.fields[L.C.U_ROL] || "Dirección",
      n: u.fields[L.C.U_NOMBRE] || ""
    });
    return L.json(200, { mensaje: "Acceso concedido." }, { "Set-Cookie": L.cookieSesion(token) });
  } catch (e) {
    console.error(e.message);
    return L.ERROR_GENERICO;
  }
};
