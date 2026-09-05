// operaciones.js — tarjetas de la pantalla P-2 (§6.3) y agenda de la P-4 (§6.5).
// Devuelve SOLO los campos declarados en el pliego; jamás el registro completo (§8.1).
// La tarjeta incluye el aval cuando existe (decisión §15.4).
"use strict";
const L = require("./_lib.js");

exports.handler = (evento) => L.conSesion(evento, async (usuario) => {
  const q = evento.queryStringParameters || {};
  const filtros = [L.filtroClientePorLookup(usuario.clienteId), L.filtroRol(usuario.rol, usuario.id)];

  if (q.q) {
    const term = L.escFormula(String(q.q).toLowerCase());
    filtros.push(`OR(FIND(${term}, LOWER({${L.C.O_COMPRADOR}} & "")), FIND(${term}, LOWER({${L.C.O_FOLIO}} & "")))`);
  }

  const registros = await L.listar(
    L.T.OPERACIONES,
    `AND(${filtros.join(", ")})`,
    [L.C.O_FOLIO, L.C.O_COMPRADOR, L.C.O_AVAL, L.C.O_SALDO, L.C.O_F_VENC,
     L.C.O_ESTATUS_PAGO, L.C.O_FICHA_FIRMA, L.C.O_PAGARE_FIRMA, L.C.O_CONST_ESTATUS,
     L.C.O_MEDIO_COBRO],
    { "sort[0][field]": L.C.O_F_VENC, "sort[0][direction]": "asc" }
  );

  let tarjetas = registros.map(r => {
    const f = r.fields;
    return {
      folio: f[L.C.O_FOLIO] || "",
      contraparte: f[L.C.O_COMPRADOR] || "",
      aval: f[L.C.O_AVAL] || null,
      saldo: f[L.C.O_SALDO] || 0,
      vencimiento: f[L.C.O_F_VENC] || null,
      semaforo: L.semaforo(f),
      cobroDomiciliado: !!(f[L.C.O_MEDIO_COBRO] && f[L.C.O_MEDIO_COBRO] !== "No aplica"),
      expediente: {
        ficha: f[L.C.O_FICHA_FIRMA] || "Pendiente",
        pagare: f[L.C.O_PAGARE_FIRMA] || "Pendiente",
        constancia: f[L.C.O_CONST_ESTATUS] || "No aplica"
      },
      incompleto: L.expedienteIncompleto(f)
    };
  });

  // Filtro por estatus calculado (vigente · porvencer · vencida · disputa · liquidada · incompleto)
  if (q.estatus === "incompleto") tarjetas = tarjetas.filter(t => t.incompleto && t.semaforo.clave !== "liquidada");
  else if (q.estatus) tarjetas = tarjetas.filter(t => t.semaforo.clave === q.estatus);

  if (q.orden === "monto") tarjetas.sort((a, b) => b.saldo - a.saldo);

  return L.json(200, { total: tarjetas.length, operaciones: tarjetas.slice(0, 200) });
});
