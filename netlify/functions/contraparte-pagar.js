// contraparte-pagar.js — crea el pago en línea desde la liga de contraparte.
// Vuelve a validar el token (nunca confía en lo que mostró la pantalla) y cobra
// el saldo vigente EN ESE MOMENTO según Airtable, no un monto enviado por el
// navegador. La liquidación la asienta /api/stripe-webhook al confirmarse el
// pago, que es el único evento facultado para liquidar (Árbol §5).
"use strict";
const L = require("./_lib.js");
const G = require("./_liga.js");
const S = require("./_stripe.js");

const NO_DISPONIBLE = L.json(404, { error: "Esta liga ya no está disponible." });

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });
  if (!process.env.STRIPE_SECRET_KEY) return L.json(503, { error: "El pago en línea no está habilitado." });

  let token = "";
  try { token = String(JSON.parse(evento.body || "{}").t || ""); } catch { /* ignorar */ }
  if (!token || token.length > 400) return NO_DISPONIBLE;

  try {
    const r = await G.resolver(token);
    if (!r) return NO_DISPONIBLE;
    const op = G.resumenOperacion(r.registro);
    if (op.saldo <= 0 || op.estado.clave === "liquidada") {
      return L.json(409, { error: "Esta operación ya no tiene saldo pendiente." });
    }
    if (op.estado.clave === "disputa") {
      return L.json(409, { error: "Esta operación está en aclaración; el pago en línea está suspendido." });
    }

    const cliente = await L.airtable("GET", L.T.CLIENTES, { id: r.clienteId }).catch(() => ({ fields: {} }));
    const vuelta = `${G.urlBase()}/c/${token}`;
    const sesion = await S.crearCheckout({
      folio: op.folio,
      concepto: `${cliente.fields[L.C.CL_NOMBRE] || "Proveedor"} · ${op.folio} · ${op.descripcion}`.trim(),
      montoMXN: op.saldo,
      urlRetorno: `${vuelta}?pago=ok`,
      urlCancelacion: vuelta,
      correo: r.registro.fields[L.C.O_COMPRADOR_CORREO]
    });

    await L.airtable("PATCH", L.T.OPERACIONES, {
      id: r.registro.id,
      cuerpo: { fields: { [L.C.O_BITACORA]: L.anexarBitacora(r.registro.fields[L.C.O_BITACORA],
        `La contraparte inició el pago en línea por ${L.dinero(op.saldo)}`) } }
    }).catch(() => {});

    return L.json(200, { url: sesion.url });
  } catch (e) {
    console.error("contraparte-pagar:", e.message);
    return L.json(503, { error: "No fue posible iniciar el pago. Intenta de nuevo en un momento." });
  }
};
