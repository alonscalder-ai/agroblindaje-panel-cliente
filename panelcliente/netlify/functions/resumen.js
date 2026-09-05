// resumen.js — indicadores de la pantalla P-1 (§6.2), calculados en backend.
// Caché de 60 s por cliente+rol (§8.2). Incluye bandera de modo histórico (§4.4).
"use strict";
const L = require("./_lib.js");

exports.handler = (evento) => L.conSesion(evento, async (usuario) => {
  const datos = await L.conCache(`resumen:${usuario.clienteId}:${usuario.rol}`, 60e3, async () => {
    const [cliente, ops] = await Promise.all([
      L.airtable("GET", L.T.CLIENTES, { id: usuario.clienteId }),
      L.listar(L.T.OPERACIONES,
        `AND(${L.filtroClientePorLookup(usuario.clienteId)}, ${L.filtroRol(usuario.rol, usuario.id)})`,
        [L.C.O_SALDO, L.C.O_F_VENC, L.C.O_ESTATUS_PAGO,
         L.C.O_FICHA_FIRMA, L.C.O_PAGARE_FIRMA, L.C.O_CONST_ESTATUS])
    ]);

    const modoHistorico = (cliente.fields[L.C.CL_SUSCRIPCION] || "Activa") === "Histórico";
    let saldoTotal = 0, vencido = 0, porVencer7 = 0, vivas = 0, incompletos = 0;
    for (const r of ops) {
      const f = r.fields;
      if ((f[L.C.O_ESTATUS_PAGO] || "Pendiente") === "Liquidada") continue;
      const saldo = f[L.C.O_SALDO] || 0;
      vivas++; saldoTotal += saldo;
      const s = L.semaforo(f);
      if (s.clave === "vencida") vencido += saldo;
      if (s.clave === "porvencer") porVencer7 += saldo;
      if (L.expedienteIncompleto(f)) incompletos++;
    }
    const logo = (cliente.fields[L.C.CL_LOGO] || [])[0];
    return {
      cliente: cliente.fields[L.C.CL_NOMBRE] || "",
      logo: logo ? logo.url : null,
      paquete: cliente.fields[L.C.CL_PAQUETE] || "",
      modoHistorico,
      saldoTotal, vencido, porVencer7, vivas, expedientesIncompletos: incompletos
    };
  });
  return L.json(200, { ...datos, usuario: { nombre: usuario.nombre, rol: usuario.rol } });
});
