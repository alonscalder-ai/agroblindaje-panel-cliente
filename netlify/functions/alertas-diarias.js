// alertas-diarias.js — función PROGRAMADA (07:00 Querétaro, ver netlify.toml).
// Regla §16.6: el trabajo recurrente y masivo corre aquí, llamando directo a
// Cloud API — cero tareas de plataforma intermediaria y cero sobreprecio BSP.
//
// Requiere dos plantillas de UTILIDAD preaprobadas en Meta:
//   sscae_alerta_d7 · sscae_alerta_d0  → {{1}} contraparte {{2}} monto {{3}} fecha
"use strict";
const L = require("./_lib.js");
const W = require("./_whatsapp.js");

const MAS_DIAS = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

exports.handler = async () => {
  const hoy = L.hoyQro();
  const objetivo = [
    { fecha: MAS_DIAS(hoy, 7), plantilla: "sscae_alerta_d7", evento: "Alerta D-7 enviada" },
    { fecha: hoy, plantilla: "sscae_alerta_d0", evento: "Alerta de vencimiento (D-0) enviada" }
  ];
  let enviadas = 0, fallidas = 0;

  for (const t of objetivo) {
    let registros = [];
    try {
      registros = await L.listar(L.T.OPERACIONES,
        `AND({${L.C.O_F_VENC}} = ${L.escFormula(t.fecha)}, {${L.C.O_ESTATUS_PAGO}} = 'Pendiente')`,
        [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_COMPRADOR_TEL, L.C.O_SALDO, L.C.O_F_VENC, L.C.O_BITACORA]);
    } catch (e) { console.error("consulta alertas:", e.message); continue; }

    for (const r of registros) {
      const f = r.fields;
      const tel = f[L.C.O_COMPRADOR_TEL];
      if (!tel) continue;
      const ok = await W.plantilla(tel, t.plantilla, [
        f[L.C.O_COMPRADOR] || "", L.dinero(f[L.C.O_SALDO]), f[L.C.O_F_VENC] || ""
      ]).catch(() => false);
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
