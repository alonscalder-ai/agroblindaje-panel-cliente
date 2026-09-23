// contraparte-ver.js — datos de la pantalla de la contraparte deudora (§15.7).
// Público: no hay sesión. La única llave es el token firmado de la liga.
// Cualquier irregularidad (firma, caducidad, revocación, sustitución) responde
// exactamente lo mismo, para no dar pistas a quien pruebe tokens.
"use strict";
const L = require("./_lib.js");
const G = require("./_liga.js");

const NO_DISPONIBLE = L.json(404, {
  error: "Esta liga ya no está disponible. Solicita una nueva a tu proveedor."
});

exports.handler = async (evento) => {
  if (evento.httpMethod !== "GET") return L.json(405, { error: "Método no permitido." });
  const token = String((evento.queryStringParameters || {}).t || "");
  if (!token || token.length > 400) return NO_DISPONIBLE;

  try {
    const r = await G.resolver(token);
    if (!r) return NO_DISPONIBLE;
    const f = r.registro.fields;

    const [cliente, otras] = await Promise.all([
      L.airtable("GET", L.T.CLIENTES, { id: r.clienteId }).catch(() => ({ fields: {} })),
      G.operacionesDeLaContraparte(r.clienteId, r.rfc, r.registro.id)
    ]);

    // Primera consulta: se asienta una sola vez (evidencia de que la
    // contraparte tuvo a la vista el adeudo), sin inundar la bitácora.
    if (!f[L.C.O_LIGA_CONSULTA]) {
      await L.airtable("PATCH", L.T.OPERACIONES, {
        id: r.registro.id,
        cuerpo: { fields: {
          [L.C.O_LIGA_CONSULTA]: new Date().toISOString(),
          [L.C.O_BITACORA]: L.anexarBitacora(f[L.C.O_BITACORA], "La contraparte consultó el adeudo mediante la liga")
        } }
      }).catch(e => console.error("registro de consulta:", e.message));
    }

    const principal = G.resumenOperacion(r.registro);
    const telCliente = String(cliente.fields[L.C.CL_TEL] || "").replace(/\D/g, "");
    const puedePagar = !!process.env.STRIPE_SECRET_KEY &&
      principal.saldo > 0 && !["liquidada", "disputa"].includes(principal.estado.clave);

    return L.json(200, {
      acreedor: cliente.fields[L.C.CL_NOMBRE] || "",
      contraparte: f[L.C.O_COMPRADOR] || "",
      principal,
      documentos: G.documentos(f),
      otras: otras.map(G.resumenOperacion),
      puedePagar,
      aclaraciones: telCliente
        ? `https://wa.me/${telCliente.length === 10 ? "52" + telCliente : telCliente}?text=` +
          encodeURIComponent(`Hola, tengo una aclaración sobre la operación ${principal.folio}.`)
        : null
    });
  } catch (e) {
    console.error("contraparte-ver:", e.message);
    return L.json(503, { error: "No fue posible cargar la información. Intenta de nuevo en un momento." });
  }
};
