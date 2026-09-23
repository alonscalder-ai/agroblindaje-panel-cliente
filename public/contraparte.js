// contraparte.js — pantalla única de la contraparte deudora (§15.7).
// Qué debe, cuándo vence, qué firmó y un botón para pagar. Sin sesión: el
// token viaja en la ruta /c/<token> y el servidor lo valida en cada llamada.
"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const dinero = n => "$" + (n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = iso => iso ? new Date(iso + "T12:00:00-06:00")
    .toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : "—";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const token = decodeURIComponent(location.pathname.replace(/^\/c\//, "").split("/")[0] || "");
  const pagoOk = new URLSearchParams(location.search).get("pago") === "ok";
  const cont = $("contenido");

  const claseSem = { vigente: "vigente", porvencer: "porvencer", vencida: "vencida",
    disputa: "disputa", liquidada: "liquidada" };

  function fila(k, v) { return v ? `<div class="dato"><span class="k">${k}</span>${v}</div>` : ""; }

  function pintar(d) {
    $("acreedor").textContent = d.acreedor || "Estado de tu cuenta";
    const p = d.principal;
    const docs = d.documentos.map(doc => `
      <div class="doc-linea">
        <span>${esc(doc.nombre)}${doc.detalle ? `<br><small>${esc(doc.detalle)}</small>` : ""}</span>
        <span class="doc-estado ${doc.firmado ? "Firmada" : "Pendiente"}">
          ${doc.firmado ? (doc.constancia ? "Firmado · NOM-151" : "Firmado") : "Pendiente de firma"}
        </span>
      </div>`).join("");

    const otras = d.otras.length ? `
      <details class="bloque"><summary>Otras operaciones pendientes con ${esc(d.acreedor)}</summary>
        <div class="cuerpo">${d.otras.map(o => `
          <div class="dato"><span class="k">${esc(o.folio)} · ${esc(o.estado.texto)}</span>
            ${dinero(o.saldo)} · vence ${fecha(o.vencimiento)}</div>`).join("")}
        </div></details>` : "";

    const avisoPago = pagoOk && p.estado.clave !== "liquidada" ? `
      <div class="aviso-pago">Recibimos tu pago. Si pagaste en efectivo o por
      transferencia, puede tardar en reflejarse; en cuanto se confirme verás esta
      operación como pagada.</div>` : "";

    cont.innerHTML = `
      ${avisoPago}
      <p class="saludo">Hola, ${esc(d.contraparte)}. Este es el estado de tu cuenta con
      <strong>${esc(d.acreedor)}</strong>.</p>

      <div class="tarjeta" data-sem="${claseSem[p.estado.clave]}" style="cursor:default">
        <div class="linea1">
          <span class="contraparte">${esc(p.folio)}</span>
          <span class="saldo">${dinero(p.saldo)}</span>
        </div>
        <div class="linea2">
          <span class="etiqueta-sem ${claseSem[p.estado.clave]}">${esc(p.estado.texto)}</span>
          <span>vence ${fecha(p.vencimiento)}</span>
        </div>
      </div>

      ${d.puedePagar ? `<button type="button" class="boton-pagar" id="pagar">Pagar ${dinero(p.saldo)}</button>` : ""}

      <details class="bloque" open><summary>Qué compraste</summary><div class="cuerpo">
        ${fila("Descripción", esc(p.descripcion))}
        ${fila("Cantidad", esc(p.cantidad))}
        ${fila("Monto total de la operación", dinero(p.montoTotal))}
        ${fila("Saldo pendiente", dinero(p.saldo))}
        ${p.tasaMoratoria ? fila("Interés moratorio pactado", `${p.tasaMoratoria}% mensual sobre saldo vencido`) : ""}
      </div></details>

      <details class="bloque" open><summary>Qué firmaste</summary><div class="cuerpo">
        ${docs}
        <p class="nota-legal">Los documentos se firmaron electrónicamente. La constancia
        NOM-151-SCFI-2016 acredita la fecha y la integridad de cada documento.</p>
      </div></details>

      ${otras}

      ${d.aclaraciones ? `<a class="boton-aclarar" href="${esc(d.aclaraciones)}" rel="noopener">
        ¿Tienes una aclaración sobre este adeudo? Escríbenos</a>` : ""}`;

    const b = $("pagar");
    if (b) b.addEventListener("click", pagar);
  }

  async function pagar() {
    const b = $("pagar");
    b.disabled = true; b.textContent = "Preparando el pago…";
    try {
      const r = await fetch("/api/contraparte-pagar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) { location.href = d.url; return; }
      b.textContent = d.error || "No fue posible iniciar el pago.";
    } catch {
      b.disabled = false; b.textContent = "Reintentar el pago";
    }
  }

  async function cargar() {
    if (!token) { cont.innerHTML = '<div class="estado">Liga incompleta.</div>'; return; }
    try {
      const r = await fetch("/api/contraparte-ver?t=" + encodeURIComponent(token));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { cont.innerHTML = `<div class="estado">${esc(d.error || "Liga no disponible.")}</div>`; return; }
      pintar(d);
    } catch {
      cont.innerHTML = '<div class="estado">Sin conexión. Intenta de nuevo en un momento.</div>';
    }
  }
  cargar();
})();
