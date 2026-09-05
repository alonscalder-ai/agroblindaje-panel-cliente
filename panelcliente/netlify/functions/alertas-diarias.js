// alertas-diarias.js — función PROGRAMADA (07:00 Querétaro, ver netlify.toml).
// Implementa la regla §17.6 del Pliego: el trabajo recurrente y masivo corre
// aquí, llamando directo a WhatsApp Cloud API — cero tareas de Zapier y cero
// sobreprecio de BSP. Envía las alertas D-7 y D-0 a las contrapartes y anexa
// el evento a la bitácora de cada operación.
//
// Requiere en Meta dos plantillas de UTILIDAD preaprobadas:
//   sscae_alerta_d7  → vars: {{1}} contraparte · {{2}} monto · {{3}} fecha
//   sscae_alerta_d0  → vars: {{1}} contraparte · {{2}} monto · {{3}} fecha
"use strict";
const L = require("./_lib.js");

const HOY = () => {
  // Fecha civil en Querétaro (UTC-6 sin horario de verano desde 2022)
  const d = new Date(Date.now() - 6 * 3600e3);
  return d.toISOString().slice(0, 10);
};
const MAS_DIAS = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function enviarPlantilla(telefono, plantilla, variables) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono.replace(/\D/g, ""),
      type: "template",
      template: {
        name: plantilla,
        language: { code: "es_MX" },
        components: [{ type: "body", parameters: variables.map(v => ({ type: "text", text: String(v) })) }]
      }
    })
  });
  return r.ok;
}

exports.handler = async () => {
  const hoy = HOY(), d7 = MAS_DIAS(hoy, 7);
  const objetivo = [
    { fecha: d7, plantilla: "sscae_alerta_d7", evento: "Alerta D-7 enviada" },
    { fecha: hoy, plantilla: "sscae_alerta_d0", evento: "Alerta de vencimiento (D-0) enviada" }
  ];
  let enviadas = 0, fallidas = 0;

  for (const t of objetivo) {
    let registros = [];
    try {
      registros = await L.listar(
        L.T.OPERACIONES,
        `AND({${L.C.O_F_VENC}} = ${L.escFormula(t.fecha)}, {${L.C.O_ESTATUS_PAGO}} = 'Pendiente')`,
        [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_COMPRADOR_TEL, L.C.O_SALDO, L.C.O_F_VENC, L.C.O_BITACORA]
      );
    } catch (e) { console.error("consulta alertas:", e.message); continue; }

    for (const r of registros) {
      const f = r.fields;
      const tel = f[L.C.O_COMPRADOR_TEL];
      if (!tel) continue;
      const monto = "$" + (f[L.C.O_SALDO] || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 });
      const ok = await enviarPlantilla(tel, t.plantilla, [f[L.C.O_COMPRADOR] || "", monto, f[L.C.O_F_VENC] || ""])
        .catch(() => false);
      ok ? enviadas++ : fallidas++;
      if (ok) {
        const linea = `${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${t.evento}`;
        const bitacora = (f[L.C.O_BITACORA] ? f[L.C.O_BITACORA] + "\n" : "") + linea;
        await L.airtable("PATCH", L.T.OPERACIONES, { id: r.id, cuerpo: { fields: { [L.C.O_BITACORA]: bitacora } } })
          .catch(() => {});
      }
    }
  }
  console.log(`alertas-diarias: ${enviadas} enviadas, ${fallidas} fallidas`);
  return { statusCode: 200, body: JSON.stringify({ enviadas, fallidas }) };
};
