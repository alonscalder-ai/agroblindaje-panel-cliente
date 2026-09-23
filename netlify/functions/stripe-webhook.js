// stripe-webhook.js — receptor de eventos de Stripe con verificación de firma.
// Sustituye al antiguo Zap "Resultado de cobro".
//
// La firma v1 se valida sobre el CUERPO CRUDO: si se reserializa el JSON, deja
// de coincidir. Se rechazan eventos fuera de tolerancia (replay).
//
// Correlación: metadata.folio_operacion, que debe escribirse al crear el
// PaymentIntent o la suscripción.
"use strict";
const crypto = require("crypto");
const L = require("./_lib.js");

const TOLERANCIA_SEG = 300;

function verificarFirma(cuerpoCrudo, cabeceraFirma, secreto) {
  if (!cabeceraFirma || !secreto) return { ok: false, razon: "falta firma o secreto" };
  const partes = {};
  for (const seg of String(cabeceraFirma).split(",")) {
    const i = seg.indexOf("=");
    if (i === -1) continue;
    const k = seg.slice(0, i).trim(), v = seg.slice(i + 1).trim();
    if (k === "v1") (partes.v1 = partes.v1 || []).push(v);
    else partes[k] = v;
  }
  if (!partes.t || !partes.v1 || !partes.v1.length) return { ok: false, razon: "cabecera malformada" };

  const edad = Math.floor(Date.now() / 1000) - Number(partes.t);
  if (!Number.isFinite(edad) || Math.abs(edad) > TOLERANCIA_SEG) {
    return { ok: false, razon: `fuera de tolerancia (${edad}s)` };
  }
  const esperada = crypto.createHmac("sha256", secreto)
    .update(`${partes.t}.${cuerpoCrudo}`, "utf8").digest("hex");
  const coincide = partes.v1.some(f => L.igualSeguro(f, esperada));
  return coincide ? { ok: true } : { ok: false, razon: "firma no coincide" };
}

const pesos = c => L.dinero(c / 100);

async function operacionPorFolio(folio) {
  const regs = await L.listar(L.T.OPERACIONES,
    `{${L.C.O_FOLIO}} = ${L.escFormula(folio)}`,
    [L.C.O_FOLIO, L.C.O_BITACORA, L.C.O_SALDO, L.C.O_ESTATUS_PAGO, L.C.O_CARGOS_FALLIDOS, L.C.O_MONTO_COBRADO]);
  return regs.length === 1 ? regs[0] : null;
}

exports.handler = async (evento) => {
  if (evento.httpMethod !== "POST") return L.json(405, { error: "Método no permitido." });

  const cuerpoCrudo = evento.isBase64Encoded
    ? Buffer.from(evento.body || "", "base64").toString("utf8")
    : (evento.body || "");

  const cabecera = evento.headers["stripe-signature"] || evento.headers["Stripe-Signature"];
  const v = verificarFirma(cuerpoCrudo, cabecera, process.env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok) {
    console.warn("stripe-webhook: firma rechazada —", v.razon);
    return L.json(400, { error: "Firma inválida." });
  }

  let ev;
  try { ev = JSON.parse(cuerpoCrudo); }
  catch { return L.json(400, { error: "Contenido no interpretable." }); }

  const objeto = (ev.data || {}).object || {};
  const meta = objeto.metadata || {};
  const folio = meta.folio_operacion || "";

  try {
    if (!folio) {
      console.log(`stripe-webhook: ${ev.type} sin folio_operacion (probable suscripción SSCAE)`);
      return L.json(200, { recibido: true });
    }

    const registro = await operacionPorFolio(folio);
    if (!registro) {
      console.warn("stripe-webhook: folio sin operación:", folio);
      return L.json(200, { recibido: true });
    }

    const f = registro.fields;
    const campos = {};
    let texto = null;

    switch (ev.type) {
      case "payment_intent.succeeded":
      case "charge.succeeded":
      case "invoice.payment_succeeded": {
        // Idempotencia: Stripe reintenta los webhooks. El id del cobro queda
        // asentado en la bitácora y, si ya está, no se vuelve a aplicar.
        const idCobro = objeto.payment_intent || objeto.id || "";
        if (idCobro && String(f[L.C.O_BITACORA] || "").includes(`[${idCobro}]`)) {
          return L.json(200, { recibido: true, duplicado: true });
        }
        const monto = objeto.amount_received ?? objeto.amount_paid ?? objeto.amount ?? 0;
        const pesosCobrados = monto / 100;
        const saldo = f[L.C.O_SALDO] || 0;
        const cubreTodo = pesosCobrados >= saldo - 0.01;
        // El monto se ACUMULA en Monto cobrado: Saldo a crédito es una fórmula
        // que lo resta, así que un pago parcial reduce el saldo por sí mismo.
        campos[L.C.O_MONTO_COBRADO] = (f[L.C.O_MONTO_COBRADO] || 0) + pesosCobrados;
        // El cobro exitoso por Stripe SÍ liquida: es el único evento con esa
        // facultad (regla de conciliación del Árbol §5).
        if (cubreTodo) campos[L.C.O_ESTATUS_PAGO] = "Liquidada";
        campos[L.C.O_CARGOS_FALLIDOS] = 0;
        const origen = (objeto.metadata || {}).origen === "liga_contraparte"
          ? "Pago en línea de la contraparte" : "Cobro automático";
        texto = `${origen} exitoso por ${pesos(monto)}` +
          (cubreTodo ? " · operación liquidada" : " · pago parcial aplicado") +
          (idCobro ? ` [${idCobro}]` : "");
        break;
      }
      case "payment_intent.payment_failed":
      case "charge.failed":
      case "invoice.payment_failed": {
        const fallidos = (f[L.C.O_CARGOS_FALLIDOS] || 0) + 1;
        campos[L.C.O_CARGOS_FALLIDOS] = fallidos;
        const motivo = (objeto.last_payment_error || {}).message ||
          objeto.failure_message || "sin detalle";
        texto = `Cargo domiciliado fallido (intento ${fallidos}) · ${motivo}`;
        break;
      }
      case "charge.dispute.created":
        campos[L.C.O_ESTATUS_PAGO] = "En disputa";
        texto = "Contracargo abierto en la plataforma de pagos · operación en disputa";
        break;
      default:
        console.log("stripe-webhook: evento no atendido:", ev.type);
        return L.json(200, { recibido: true });
    }

    campos[L.C.O_BITACORA] = L.anexarBitacora(f[L.C.O_BITACORA], texto);
    await L.airtable("PATCH", L.T.OPERACIONES, { id: registro.id, cuerpo: { fields: campos } });
    console.log(`stripe-webhook: ${folio} · ${texto}`);
    return L.json(200, { recibido: true });
  } catch (e) {
    console.error("stripe-webhook:", e.message);
    return L.json(500, { error: "Error al procesar." });
  }
};
