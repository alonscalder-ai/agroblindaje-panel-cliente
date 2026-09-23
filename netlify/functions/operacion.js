// operacion.js — detalle de la pantalla P-3 (§6.4).
// Verifica pertenencia ANTES de responder; ajeno = "No encontrada", nunca
// "No autorizado", para no confirmar la existencia del registro (§11.2).
"use strict";
const L = require("./_lib.js");

const NO_ENCONTRADO = L.json(404, { error: "Operación no encontrada." });

exports.handler = (evento) => L.conSesion(evento, async (usuario) => {
  const folio = String((evento.queryStringParameters || {}).folio || "").trim();
  if (!/^OP-\d{1,8}$/.test(folio)) return NO_ENCONTRADO;

  const registros = await L.listar(
    L.T.OPERACIONES,
    `AND({${L.C.O_FOLIO}} = ${L.escFormula(folio)}, ${L.filtroClientePorLookup(usuario.clienteId)}, ${L.filtroRol(usuario.rol)})`,
    [L.C.O_FOLIO, L.C.O_FOLIO_PG, L.C.O_FOLIO_CR,
     L.C.O_COMPRADOR, L.C.O_COMPRADOR_RFC, L.C.O_COMPRADOR_TEL, L.C.O_COMPRADOR_CORREO,
     L.C.O_AVAL, L.C.O_TIPO, L.C.O_DESC, L.C.O_CANTIDAD,
     L.C.O_MONTO_TOTAL, L.C.O_ANTICIPO, L.C.O_SALDO,
     L.C.O_F_CELEBRACION, L.C.O_F_ENTREGA, L.C.O_LUGAR_ENTREGA,
     L.C.O_PLAZO, L.C.O_F_VENC, L.C.O_TASA_ORD, L.C.O_TASA_MOR,
     L.C.O_ESTATUS_PAGO, L.C.O_FICHA_FIRMA, L.C.O_PAGARE_FIRMA, L.C.O_CONST_ESTATUS,
     L.C.O_CARGO_ACTIVO, L.C.O_FECHAS_CARGO, L.C.O_CARGOS_FALLIDOS,
     L.C.O_ESCROW_ESTADO, L.C.O_ESCROW_MONTO, L.C.O_BITACORA, L.C.O_RESPONSABLE]
  );
  const propias = L.filtrarPorRol(registros, usuario.rol, usuario.id);
  if (propias.length !== 1) return NO_ENCONTRADO;
  const f = propias[0].fields;

  return L.json(200, {
    folio: f[L.C.O_FOLIO],
    semaforo: L.semaforo(f),
    contraparte: {
      nombre: f[L.C.O_COMPRADOR] || "", rfc: f[L.C.O_COMPRADOR_RFC] || "",
      telefono: f[L.C.O_COMPRADOR_TEL] || "", correo: f[L.C.O_COMPRADOR_CORREO] || "",
      aval: f[L.C.O_AVAL] || null
    },
    operacion: {
      tipo: f[L.C.O_TIPO] || "", descripcion: f[L.C.O_DESC] || "",
      cantidad: f[L.C.O_CANTIDAD] || "",
      montoTotal: f[L.C.O_MONTO_TOTAL] || 0, anticipo: f[L.C.O_ANTICIPO] || 0,
      saldo: f[L.C.O_SALDO] || 0,
      fechaCelebracion: f[L.C.O_F_CELEBRACION] || null,
      fechaEntregaPactada: f[L.C.O_F_ENTREGA] || null,
      lugarEntrega: f[L.C.O_LUGAR_ENTREGA] || "",
      plazoDias: f[L.C.O_PLAZO] || null,
      fechaVencimiento: f[L.C.O_F_VENC] || null,
      tasaOrdinaria: L.aPorcentaje(f[L.C.O_TASA_ORD]), tasaMoratoria: L.aPorcentaje(f[L.C.O_TASA_MOR])
    },
    expediente: {
      ficha: { estatus: f[L.C.O_FICHA_FIRMA] || "Pendiente" },
      pagare: { folio: f[L.C.O_FOLIO_PG] || "", estatus: f[L.C.O_PAGARE_FIRMA] || "Pendiente" },
      constancia: { folio: f[L.C.O_FOLIO_CR] || "", estatus: f[L.C.O_CONST_ESTATUS] || "No aplica" }
    },
    cobro: {
      cargoAutomatico: !!f[L.C.O_CARGO_ACTIVO],
      fechasCargo: f[L.C.O_FECHAS_CARGO] || "",
      cargosFallidos: f[L.C.O_CARGOS_FALLIDOS] || 0,
      escrowEstado: f[L.C.O_ESCROW_ESTADO] || "No aplica",
      escrowMonto: f[L.C.O_ESCROW_MONTO] || ""
    },
    bitacora: String(f[L.C.O_BITACORA] || "").split("\n").filter(Boolean)
  });
});
