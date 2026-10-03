// _documentos.js — consecuencias documentales de los eventos de campo.
// Traduce un registro de Operaciones a los campos de fusión de las plantillas
// de Mifiel y dispara su creación. Los nombres de campo son idénticos a los
// merge fields de las plantillas Word y a los <field name> del HTML: cero
// remapeo (ver Esquema_Campos_SSCAE).
//
// Los sellos NOM-151 y el hash NO viajan aquí: son SALIDAS que escribe
// /api/mifiel-callback al completarse la firma.
"use strict";
const L = require("./_lib.js");
const M = require("./_mifiel.js");
const { enteroALetras } = require("./_letras.js");

const fmtMoneda = n => Number(n || 0).toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const fmtPct = n => `${L.aPorcentaje(n).toFixed(1)}%`;   // 0.04 → "4.0%"
const fmtFecha = iso => {
  if (!iso) return "";
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  const meses = ["enero","febrero","marzo","abril","mayo","junio","julio",
    "agosto","septiembre","octubre","noviembre","diciembre"];
  return `${Number(d)} de ${meses[Number(m) - 1]} de ${a}`;
};

function urlCallback() {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const token = process.env.MIFIEL_CALLBACK_TOKEN || "";
  return `${base}/api/mifiel-callback?t=${encodeURIComponent(token)}`;
}

// ── Marcas de opción (la plantilla canónica representa radios y casillas como texto) ──
const RADIO_SI = "●", RADIO_NO = "○", CHK_SI = "■", CHK_NO = "□";
function marcasTipo(tipo) {
  const t = String(tipo || "").toLowerCase();
  const clave = /servicio/.test(t) ? "servicios"
    : /suministro/.test(t) ? "suministro"
    : /(venta|compra|insumo|producto|cosecha|grano)/.test(t) ? "compraventa" : "otro";
  const m = {};
  for (const k of ["compraventa", "servicios", "suministro", "otro"]) {
    m[`tipo_operacion_${k}_marca`] = k === clave ? RADIO_SI : RADIO_NO;
  }
  return m;
}
const escrowActivo = f => !!f[L.C.O_ESCROW_ESTADO] && f[L.C.O_ESCROW_ESTADO] !== "No aplica";
// Modelo B = retención parcial (hay % de retención); Modelo A = depósito previo.
function marcasEscrow(f) {
  const activo = escrowActivo(f), b = activo && Number(f[L.C.O_PCT_RETENCION] || 0) > 0;
  return {
    modelo_escrow_no_aplica_marca: activo ? RADIO_NO : RADIO_SI,
    modelo_escrow_a_marca: activo && !b ? RADIO_SI : RADIO_NO,
    modelo_escrow_b_marca: b ? RADIO_SI : RADIO_NO
  };
}

function marcasConformidad(texto) {
  const t = String(texto).toLowerCase();
  const clave = /no conforme/.test(t) ? "no_conforme" : /con observ/.test(t) ? "con_obs" : "sin_obs";
  return {
    estatus_conformidad_sin_obs_marca: clave === "sin_obs" ? RADIO_SI : RADIO_NO,
    estatus_conformidad_con_obs_marca: clave === "con_obs" ? RADIO_SI : RADIO_NO,
    estatus_conformidad_no_conforme_marca: clave === "no_conforme" ? RADIO_SI : RADIO_NO
  };
}

// ── Ficha de Operación (Módulo A) ──
function camposFicha(f, cliente) {
  const C = L.C;
  return {
    folio_operacion: f[C.O_FOLIO] || "",
    lugar_celebracion: cliente[C.CL_LUGAR] || "",
    fecha_celebracion: fmtFecha(f[C.O_F_CELEBRACION]),

    proveedor_nombre: cliente[C.CL_NOMBRE] || "",
    proveedor_rfc: cliente.RFC || "—",          // RFC opcional: «—» si no existe
    proveedor_domicilio: cliente.Domicilio || "",
    proveedor_representante: cliente.Representante || "",
    proveedor_telefono: cliente.Teléfono || "",
    proveedor_correo: cliente.Correo || "",

    comprador_nombre: f[C.O_COMPRADOR] || "",
    comprador_rfc: f[C.O_COMPRADOR_RFC] || "—",
    comprador_domicilio: f[C.O_COMPRADOR_DOM] || "",
    comprador_representante: f[C.O_COMPRADOR_REP] || "—",
    comprador_telefono: f[C.O_COMPRADOR_TEL] || "",
    comprador_correo: f[C.O_COMPRADOR_CORREO] || "",

    descripcion_operacion: f[C.O_DESC] || "",
    cantidad_unidad: f[C.O_CANTIDAD] || "",
    monto_total: fmtMoneda(f[C.O_MONTO_TOTAL]),
    monto_anticipo: fmtMoneda(f[C.O_ANTICIPO]),
    saldo_credito: fmtMoneda(f[C.O_SALDO]),
    fecha_entrega_pactada: fmtFecha(f[C.O_F_ENTREGA]),
    lugar_entrega: f[C.O_LUGAR_ENTREGA] || "",
    plazo_credito_dias: String(f[C.O_PLAZO] || ""),
    fecha_vencimiento: fmtFecha(f[C.O_F_VENC]),
    tasa_interes_ordinario: fmtPct(f[C.O_TASA_ORD]),
    tasa_interes_moratorio: fmtPct(f[C.O_TASA_MOR]),
    plazo_aceptacion_tacita: "5",
    folio_pagare: f[C.O_FOLIO_PG] || "",

    centro_mediacion_arbitraje: cliente[C.CL_CENTRO] || "",
    sede_mediacion: cliente[C.CL_SEDE] || "",
    jurisdiccion_tribunales: cliente[C.CL_JURIS] || "",

    // Cargo automático autorizado: nombres idénticos a la plantilla canónica
    activa_cargo_automatico_marca: f[C.O_CARGO_ACTIVO] ? CHK_SI : CHK_NO,
    medio_cargo_automatico: f[C.O_MEDIO_CARGO] || "—",
    emisora_tarjeta: f[C.O_EMISORA] || "—",
    ultimos_cuatro_digitos: f[C.O_ULT4] || "—",
    periodicidad_facturacion: f[C.O_PERIODICIDAD] || "—",
    fechas_cargo_programado: f[C.O_FECHAS_CARGO] || "—",
    plataforma_pagos: f[C.O_CARGO_ACTIVO] ? (f[C.O_PLATAFORMA] || "Stripe") : "—",
    id_autorizacion_cargo: f[C.O_TOKEN_AUT] || "—",
    referencia_autorizacion: f[C.O_REF_AUT] || (f[C.O_CARGO_ACTIVO] ? (f[C.O_FOLIO] || "—") : "—"),

    ...marcasTipo(f[C.O_TIPO]),
    ...marcasEscrow(f),
    monto_escrow: escrowActivo(f) ? (f[C.O_ESCROW_MONTO] ? fmtMoneda(f[C.O_ESCROW_MONTO]) : "—") : "—",
    condicion_liberacion_escrow: escrowActivo(f) ? "Registro de la Constancia de Recepción" : "—",
    plataforma_escrow: "—"
  };
}

// ── Pagaré Agro (Módulo B) ──
// Los datos del suscriptor derivan del comprador y los del beneficiario del
// proveedor; lugar_pago es el domicilio del proveedor (art. 170-IV LGTOC).
function camposPagare(f, cliente) {
  const C = L.C;
  const saldo = Number(f[C.O_SALDO] || 0);
  const tasaOrd = L.aPorcentaje(f[C.O_TASA_ORD]);
  return {
    folio_pagare: f[C.O_FOLIO_PG] || "",
    numero_consecutivo_pagare: String(f[C.O_FOLIO] || "").replace(/\D/g, "") || "1",
    lugar_suscripcion: cliente[C.CL_LUGAR] || "",
    fecha_suscripcion: fmtFecha(f[C.O_F_CELEBRACION]),
    folio_ficha_vinculada: f[C.O_FOLIO] || "",

    beneficiario_nombre: cliente[C.CL_NOMBRE] || "",
    beneficiario_nombre_completo: cliente[C.CL_NOMBRE] || "",
    beneficiario_rfc: cliente.RFC || "—",
    beneficiario_domicilio: cliente.Domicilio || "",
    lugar_pago: cliente.Domicilio || "",

    fecha_vencimiento_pagare: fmtFecha(f[C.O_F_VENC]),
    monto_numero: fmtMoneda(saldo),
    monto_letras: enteroALetras(saldo),

    genera_interes_ordinario_si_marca: tasaOrd > 0 ? RADIO_SI : RADIO_NO,
    genera_interes_ordinario_no_marca: tasaOrd > 0 ? RADIO_NO : RADIO_SI,
    tasa_interes_ordinario_pagare: fmtPct(f[C.O_TASA_ORD]),
    tasa_interes_moratorio_pagare: fmtPct(f[C.O_TASA_MOR]),

    suscriptor_nombre: f[C.O_COMPRADOR] || "",
    suscriptor_rfc: f[C.O_COMPRADOR_RFC] || "—",
    suscriptor_domicilio: f[C.O_COMPRADOR_DOM] || "",
    suscriptor_representante: f[C.O_COMPRADOR_REP] || "—",
    suscriptor_identificacion: f[C.O_SUSCRIPTOR_ID] || "—",

    aval_nombre: f[C.O_AVAL] || "—",
    aval_rfc: f[C.O_AVAL_RFC] || "—",
    aval_domicilio: f[C.O_AVAL_DOM] || "—",
    aval_representante: f[C.O_AVAL_REP] || "—",
    aval_identificacion: f[C.O_AVAL_IDENT] || "—",

    esquema_pagos_parciales: "No aplica: pago único al vencimiento"
  };
}

// ── Constancia de Recepción (Módulo C) ──
function camposConstancia(f, cliente) {
  const C = L.C;
  return {
    folio_constancia: f[C.O_FOLIO_CR] || "",
    folio_ficha_vinculada: f[C.O_FOLIO] || "",
    lugar_recepcion: f[C.O_LUGAR_ENTREGA] || "",
    lugar_fisico_entrega: f[C.O_LUGAR_ENTREGA] || "",
    fecha_recepcion: fmtFecha(f[C.O_F_RECEPCION]),
    hora_recepcion: L.marcaTiempo().slice(11),

    entrega_nombre: cliente[C.CL_NOMBRE] || "",
    entrega_persona_fisica: f.__entregaPersona || "—",
    entrega_identificacion: "—",

    recibe_nombre: f[C.O_COMPRADOR] || "",
    recibe_persona_fisica: f[C.O_RECIBE] || "",
    recibe_identificacion: "—",

    tipo_entrega: f.__tipoEntrega || "Total",
    descripcion_entrega: f[C.O_DESC] || "",
    cantidad_entregada: f[C.O_CANT_ENTREGADA] || f[C.O_CANTIDAD] || "",
    estado_calidad_recibido: f[C.O_ESTADO_CALIDAD] || "En buen estado",
    ...marcasConformidad(f.__conformidad || "Conforme sin observaciones"),
    observaciones_recepcion: f[C.O_OBSERVACIONES] || "—",
    // La evidencia del canal de campo es la fotografía enviada por WhatsApp
    medio_verificacion_qr_marca: RADIO_NO,
    medio_verificacion_fotografia_marca: RADIO_SI,
    medio_verificacion_plataforma_marca: RADIO_NO,
    medio_verificacion_otro_marca: RADIO_NO,
    medio_verificacion_referencia: `Fotografía recibida por WhatsApp · expediente ${f[C.O_FOLIO] || ""}`.trim(),
    anexo_remision_marca: CHK_NO,
    anexo_cfdi_marca: CHK_NO,
    anexo_evidencia_fotografica_marca: (f[C.O_ADJUNTOS] || []).length ? CHK_SI : CHK_NO,
    anexo_otro_marca: CHK_NO,
    documentos_anexos: (f[C.O_ADJUNTOS] || []).length
      ? `Adjuntos de evidencia del expediente ${f[C.O_FOLIO] || ""}`.trim() : "—",
    canal_confirmacion_entrega: "Plataforma de firma electrónica (Mifiel)",
    canal_confirmacion_recibe: "WhatsApp certificado + Mifiel"
  };
}

// ── Disparo del alta: Ficha + Pagaré ──
async function generarFichaYPagare(registro, cliente) {
  const C = L.C;
  const f = registro.fields;
  const callback = urlCallback();
  const resultado = { ficha: null, pagare: null, errores: [] };

  const firmanteProveedor = {
    nombre: cliente[C.CL_NOMBRE] || "Proveedor",
    correo: cliente.Correo || "",
    rfc: cliente.RFC || ""
  };
  const firmanteComprador = {
    nombre: f[C.O_COMPRADOR] || "Comprador",
    correo: f[C.O_COMPRADOR_CORREO] || "",
    rfc: f[C.O_COMPRADOR_RFC] || ""
  };

  // Ficha: firman proveedor y comprador
  try {
    const doc = await M.crearDesdePlantilla({
      plantillaId: process.env.MIFIEL_PLANTILLA_FICHA,
      campos: camposFicha(f, cliente),
      firmantes: [firmanteProveedor, firmanteComprador],
      externalId: `${f[C.O_FOLIO]}-FICHA`,
      callbackUrl: callback
    });
    resultado.ficha = doc.id;
  } catch (e) {
    resultado.errores.push(`Ficha: ${e.message}`);
  }

  // Pagaré: firma el comprador; el aval solo si tiene correo (Mifiel lo exige
  // para poder invitarlo como firmante).
  const firmantesPagare = [firmanteComprador];
  if (f[C.O_AVAL] && f[C.O_AVAL_CORREO]) {
    firmantesPagare.push({
      nombre: f[C.O_AVAL],
      correo: f[C.O_AVAL_CORREO],
      rfc: f[C.O_AVAL_RFC] || ""
    });
  }
  try {
    const doc = await M.crearDesdePlantilla({
      plantillaId: process.env.MIFIEL_PLANTILLA_PAGARE,
      campos: camposPagare(f, cliente),
      firmantes: firmantesPagare,
      externalId: f[C.O_FOLIO_PG] || `${f[C.O_FOLIO]}-PAGARE`,
      callbackUrl: callback
    });
    resultado.pagare = doc.id;
  } catch (e) {
    resultado.errores.push(`Pagaré: ${e.message}`);
  }

  // Escribir IDs y estatus de vuelta
  const campos = {};
  if (resultado.ficha) {
    campos[C.O_FICHA_MIFIEL] = resultado.ficha;
    campos[C.O_FICHA_FIRMA] = "Enviada";
  }
  if (resultado.pagare) {
    campos[C.O_PAGARE_MIFIEL] = resultado.pagare;
    campos[C.O_PAGARE_FIRMA] = "Enviada";
  }
  const evento = resultado.errores.length
    ? `Documentos: ${resultado.errores.join(" | ")}`
    : "Ficha y Pagaré enviados a firma electrónica";
  campos[C.O_BITACORA] = L.anexarBitacora(f[C.O_BITACORA], evento);

  await L.airtable("PATCH", L.T.OPERACIONES, { id: registro.id, cuerpo: { fields: campos } })
    .catch(e => console.error("PATCH documentos:", e.message));

  return resultado;
}

// ── Disparo de la entrega: Constancia ──
async function generarConstancia(registro, cliente) {
  const C = L.C;
  const f = registro.fields;
  try {
    const doc = await M.crearDesdePlantilla({
      plantillaId: process.env.MIFIEL_PLANTILLA_CONSTANCIA,
      campos: camposConstancia(f, cliente),
      firmantes: [
        { nombre: cliente[C.CL_NOMBRE] || "Proveedor", correo: cliente.Correo || "" },
        { nombre: f[C.O_COMPRADOR] || "Comprador", correo: f[C.O_COMPRADOR_CORREO] || "" }
      ],
      externalId: f[C.O_FOLIO_CR] || `${f[C.O_FOLIO]}-CONSTANCIA`,
      callbackUrl: urlCallback()
    });
    await L.airtable("PATCH", L.T.OPERACIONES, {
      id: registro.id,
      cuerpo: { fields: {
        [C.O_CONST_MIFIEL]: doc.id,
        [C.O_CONST_ESTATUS]: "Pendiente",
        [C.O_BITACORA]: L.anexarBitacora(f[C.O_BITACORA], "Constancia de Recepción enviada a firma")
      } }
    });
    return { id: doc.id };
  } catch (e) {
    console.error("Constancia:", e.message);
    await L.airtable("PATCH", L.T.OPERACIONES, {
      id: registro.id,
      cuerpo: { fields: {
        [C.O_BITACORA]: L.anexarBitacora(f[C.O_BITACORA], `Constancia: error al generar — ${e.message}`)
      } }
    }).catch(() => {});
    return { error: e.message };
  }
}

module.exports = {
  camposFicha, camposPagare, camposConstancia,
  generarFichaYPagare, generarConstancia, urlCallback, fmtFecha, fmtMoneda
};
