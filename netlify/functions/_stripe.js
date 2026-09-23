// _stripe.js — cliente mínimo de la API de Stripe (sin SDK, sin dependencias).
// Lo usa la liga de contraparte para crear el pago en línea.
//
// El folio viaja en payment_intent_data.metadata y NO solo en la sesión: así el
// evento payment_intent.succeeded —que ya atiende /api/stripe-webhook— trae el
// folio y la operación se liquida sin cambiar una línea del webhook. Sirve
// también para pagos asíncronos (OXXO), que se confirman días después.
"use strict";

const API = "https://api.stripe.com/v1";

// La API de Stripe recibe application/x-www-form-urlencoded con claves anidadas.
function codificar(obj, prefijo = "", partes = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const clave = prefijo ? `${prefijo}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") codificar(item, `${clave}[${i}]`, partes);
        else partes.push(`${encodeURIComponent(`${clave}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === "object") {
      codificar(v, clave, partes);
    } else {
      partes.push(`${encodeURIComponent(clave)}=${encodeURIComponent(v)}`);
    }
  }
  return partes.join("&");
}

async function peticion(metodo, ruta, cuerpo, claveIdempotencia) {
  const headers = {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (claveIdempotencia) headers["Idempotency-Key"] = claveIdempotencia;
  const r = await fetch(`${API}${ruta}`, {
    method: metodo, headers, body: cuerpo ? codificar(cuerpo) : undefined
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(datos.error || {}).message || ""}`);
  return datos;
}

// STRIPE_METODOS_PAGO: lista separada por comas. Solo se admiten los métodos
// que este código sabe cobrar en MXN desde Checkout sin configuración extra:
// "card" (tarjeta de crédito/débito) y "oxxo" (efectivo en tienda). OXXO debe
// estar ACTIVADO en el panel de Stripe (Settings → Payment methods), o Stripe
// rechazará la sesión. Valores desconocidos se descartan con aviso; si no queda
// ninguno válido se usa "card".
const METODOS_ADMITIDOS = ["card", "oxxo"];
function metodosPago() {
  const pedidos = String(process.env.STRIPE_METODOS_PAGO || "card")
    .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const validos = [...new Set(pedidos.filter(m => METODOS_ADMITIDOS.includes(m)))];
  const descartados = pedidos.filter(m => !METODOS_ADMITIDOS.includes(m));
  if (descartados.length) {
    console.warn(`STRIPE_METODOS_PAGO: se ignoran ${descartados.join(", ")}; admitidos: ${METODOS_ADMITIDOS.join(", ")}.`);
  }
  return validos.length ? validos : ["card"];
}
const diasOxxo = () => {
  const n = Number(process.env.STRIPE_OXXO_DIAS || 3);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 3;
};

// Crea una sesión de Checkout por el saldo vivo de una operación.
// Métodos de pago configurables con STRIPE_METODOS_PAGO (p. ej. "card,oxxo").
function crearCheckout({ folio, concepto, montoMXN, urlRetorno, urlCancelacion, correo }) {
  const metodos = metodosPago();
  const centavos = Math.round(Number(montoMXN) * 100);
  return peticion("POST", "/checkout/sessions", {
    mode: "payment",
    payment_method_types: metodos,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "mxn",
        unit_amount: centavos,
        product_data: { name: concepto.slice(0, 250) }
      }
    }],
    payment_intent_data: {
      description: `Pago de la operación ${folio}`,
      metadata: { folio_operacion: folio, origen: "liga_contraparte" }
    },
    metadata: { folio_operacion: folio },
    // OXXO: la ficha de pago vence a los N días (default 3). El pago se confirma
    // cuando el deudor paga en tienda; entonces llega payment_intent.succeeded.
    payment_method_options: metodos.includes("oxxo")
      ? { oxxo: { expires_after_days: diasOxxo() } } : undefined,
    customer_email: correo || undefined,
    success_url: urlRetorno,
    cancel_url: urlCancelacion,
    locale: "es-419",
    expires_at: Math.floor(Date.now() / 1000) + 3600    // la sesión de pago vive 1 h
  // La clave de idempotencia evita dos sesiones por un doble clic del deudor.
  }, `chk-${folio}-${centavos}-${Math.floor(Date.now() / 60000)}`);
}

module.exports = { crearCheckout, peticion, metodosPago };
