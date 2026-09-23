// alertas-diarias.js — función PROGRAMADA (07:00 Querétaro, ver netlify.toml).
// Regla §16.6: el trabajo recurrente y masivo corre aquí, llamando directo a
// Cloud API — cero plataforma intermediaria y cero sobreprecio BSP.
//
// Cada recordatorio emite una LIGA NUEVA para la contraparte (§15.7) y la envía
// como botón de la plantilla; la liga anterior queda sin efecto automáticamente.
//
// Plantillas de UTILIDAD preaprobadas en Meta (es_MX):
//   sscae_alerta_d7 · sscae_alerta_d0
//   cuerpo:  {{1}} contraparte · {{2}} monto · {{3}} fecha · {{4}} acreedor
//   botón:   "Ver y pagar" → URL https://<sitio>/c/{{1}}
"use strict";
const L = require("./_lib.js");
const W = require("./_whatsapp.js");
const G = require("./_liga.js");
const { fmtFecha } = require("./_documentos.js");

const MAS_DIAS = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Nombres de acreedores en caché por ejecución (un GET por cliente, no por operación)
const acreedores = new Map();
async function nombreAcreedor(clienteId) {
  if (!clienteId) return "tu proveedor";
  if (!acreedores.has(clienteId)) {
    const c = await L.airtable("GET", L.T.CLIENTES, { id: clienteId }).catch(() => null);
    acreedores.set(clienteId, (c && c.fields[L.C.CL_NOMBRE]) || "tu proveedor");
  }
  return acreedores.get(clienteId);
}

exports.handler = async () => {
  const hoy = L.hoyQro();
  const objetivo = [
    { fecha: MAS_DIAS(hoy, 7), plantilla: "sscae_alerta_d7", evento: "Alerta D-7 enviada con liga de consulta y pago" },
    { fecha: hoy, plantilla: "sscae_alerta_d0", evento: "Alerta de vencimiento (D-0) enviada con liga de consulta y pago" }
  ];
  let enviadas = 0, fallidas = 0;

  for (const t of objetivo) {
    let registros = [];
    try {
      registros = await L.listar(L.T.OPERACIONES,
        `AND({${L.C.O_F_VENC}} = ${L.escFormula(t.fecha)}, {${L.C.O_ESTATUS_PAGO}} = 'Pendiente')`,
        [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_COMPRADOR_TEL, L.C.O_COMPRADOR_RFC,
         L.C.O_SALDO, L.C.O_F_VENC, L.C.O_BITACORA, L.C.O_CLIENTE_ID]);
    } catch (e) { console.error("consulta alertas:", e.message); continue; }

    for (const r of registros) {
      const f = r.fields;
      const tel = f[L.C.O_COMPRADOR_TEL];
      if (!tel) continue;
      let ok = false;
      try {
        const acreedor = await nombreAcreedor((f[L.C.O_CLIENTE_ID] || [])[0]);
        const variables = [f[L.C.O_COMPRADOR] || "", L.dinero(f[L.C.O_SALDO]),
          fmtFecha(f[L.C.O_F_VENC]), acreedor];
        // Sin RFC no hay liga (el aislamiento la exige): se envía sin botón.
        if (f[L.C.O_COMPRADOR_RFC] && process.env.LIGA_SECRET) {
          const liga = await G.emitirLiga(r);
          ok = await W.plantillaConBoton(tel, t.plantilla, variables, liga.token);
        } else {
          ok = await W.plantilla(tel, `${t.plantilla}_sin_liga`, variables);
        }
      } catch (e) { console.error("alerta:", e.message); }

      ok ? enviadas++ : fallidas++;
      if (ok) {
        await L.airtable("PATCH", L.T.OPERACIONES, {
          id: r.id,
          cuerpo: { fields: { [L.C.O_BITACORA]: L.anexarBitacora(f[L.C.O_BITACORA], t.evento) } }
        }).catch(() => {});
      }
    }
  }
  console.log(`alertas-diarias: ${enviadas} enviadas, ${fallidas} fallidas`);
  return { statusCode: 200, body: JSON.stringify({ enviadas, fallidas }) };
};
