// app.js — Panel del Cliente · SSCAE. Vistas: resumen, operaciones, detalle,
// vencimientos. Toda la lógica de negocio vive en el backend; aquí solo se
// pinta lo que los endpoints devuelven.
"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const dinero = n => "$" + (n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = iso => iso ? new Date(iso + "T12:00:00-06:00")
    .toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let cacheOps = null;

  async function api(ruta) {
    const r = await fetch(ruta, { credentials: "same-origin" });
    if (r.status === 401) { location.href = "/"; throw new Error("sesion"); }
    if (r.status === 503) throw Object.assign(new Error("ocupado"), { reintentar: true });
    if (!r.ok) throw new Error("error");
    return r.json();
  }

  function mostrarEstado(texto, reintento) {
    const e = $("estado");
    e.innerHTML = esc(texto) + (reintento ? '<br><button type="button" id="reintentar">Reintentar</button>' : "");
    e.classList.remove("oculto");
    if (reintento) $("reintentar").addEventListener("click", () => { e.classList.add("oculto"); reintento(); });
  }
  const ocultarEstado = () => $("estado").classList.add("oculto");

  // ── Navegación ──
  const VISTAS = ["resumen", "operaciones", "detalle", "vencimientos"];
  function irA(vista) {
    VISTAS.forEach(v => $("vista-" + v).classList.toggle("oculto", v !== vista));
    document.querySelectorAll("nav.inferior button[data-vista]").forEach(b =>
      b.setAttribute("aria-current", b.dataset.vista === vista ? "true" : "false"));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("nav.inferior button[data-vista]").forEach(b =>
    b.addEventListener("click", () => {
      irA(b.dataset.vista);
      if (b.dataset.vista === "operaciones") cargarOperaciones();
      if (b.dataset.vista === "vencimientos") cargarVencimientos();
      if (b.dataset.vista === "resumen") cargarResumen();
    }));
  $("salir").addEventListener("click", async () => {
    await fetch("/api/salir", { credentials: "same-origin" }).catch(() => {});
    location.href = "/";
  });
  $("volver").addEventListener("click", () => { irA("operaciones"); });

  // Indicadores tocables del resumen
  document.querySelectorAll("[data-ir]").forEach(el => {
    const activar = () => {
      const destino = el.dataset.ir;
      if (destino === "vencimientos") { irA("vencimientos"); cargarVencimientos(); return; }
      $("filtro-estatus").value = (destino === "todas") ? "" : destino;
      irA("operaciones"); cargarOperaciones();
    };
    el.addEventListener("click", activar);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activar(); } });
  });

  // ── P-1 · Resumen ──
  async function cargarResumen() {
    try {
      const d = await api("/api/resumen");
      $("nombre-cliente").textContent = d.cliente || "Panel de operaciones";
      $("usuario").textContent = `${d.usuario.nombre}\n${d.usuario.rol}`;
      if (d.logo) { $("logo").src = d.logo; $("logo").classList.remove("oculto"); }
      $("aviso-historico").classList.toggle("oculto", !d.modoHistorico);
      $("saldo-total").textContent = dinero(d.saldoTotal);
      $("ind-vencido").textContent = dinero(d.vencido);
      $("ind-porvencer").textContent = dinero(d.porVencer7);
      $("ind-vivas").textContent = d.vivas;
      $("ind-incompletos").textContent = d.expedientesIncompletos;
      ocultarEstado();
    } catch (e) {
      if (e.message !== "sesion")
        mostrarEstado("No fue posible cargar el resumen.", e.reintentar ? cargarResumen : null);
    }
  }

  // ── P-2 · Operaciones ──
  function tarjetaHTML(t) {
    const s = t.semaforo;
    const extra = s.clave === "vencida" ? ` · ${s.diasMora} día${s.diasMora === 1 ? "" : "s"} de mora`
      : (s.clave === "porvencer" && s.diasRestantes > 0
        ? ` · vence en ${s.diasRestantes} día${s.diasRestantes === 1 ? "" : "s"}` : "");
    const exp = t.expediente;
    const punto = (ok, letra) => `<span class="punto ${ok ? "lleno" : ""}" title="${letra}"></span>`;
    const fichaOk = exp.ficha === "Firmada", pagOk = exp.pagare === "Firmada",
      constOk = exp.constancia === "Registrada" || exp.constancia === "No aplica";
    return `<button type="button" class="tarjeta" data-sem="${s.clave}" data-folio="${esc(t.folio)}">
      <div class="linea1">
        <span class="contraparte">${esc(t.contraparte)}</span>
        <span class="saldo">${dinero(t.saldo)}</span>
      </div>
      ${t.aval ? `<div class="aval">Aval: ${esc(t.aval)}</div>` : ""}
      <div class="linea2">
        <span class="etiqueta-sem ${s.clave}">${esc(s.etiqueta)}${extra}</span>
        <span>${fecha(t.vencimiento)}</span>
      </div>
      <div class="puntos-exp">
        ${punto(fichaOk, "Ficha")}Ficha &nbsp;${punto(pagOk, "Pagaré")}Pagaré
        ${exp.constancia !== "No aplica" ? `&nbsp;${punto(constOk, "Constancia")}Constancia` : ""}
        &nbsp;·&nbsp;${esc(t.folio)}${t.cobroDomiciliado ? " · cobro domiciliado" : ""}
      </div>
    </button>`;
  }

  let temporizadorBusqueda = null;
  async function cargarOperaciones() {
    const cont = $("lista-operaciones");
    cont.innerHTML = '<div class="estado">Cargando…</div>';
    const params = new URLSearchParams();
    const q = $("buscar").value.trim(), est = $("filtro-estatus").value;
    if (q) params.set("q", q);
    if (est) params.set("estatus", est);
    try {
      const d = await api("/api/operaciones?" + params);
      cacheOps = d.operaciones;
      cont.innerHTML = d.operaciones.length
        ? d.operaciones.map(tarjetaHTML).join("")
        : '<div class="estado">Sin operaciones con ese criterio. Cambia el filtro o la búsqueda.</div>';
      cont.querySelectorAll(".tarjeta").forEach(b =>
        b.addEventListener("click", () => abrirDetalle(b.dataset.folio)));
    } catch (e) {
      if (e.message !== "sesion")
        cont.innerHTML = '<div class="estado">No fue posible cargar la lista. Desliza hacia abajo o toca Operaciones para reintentar.</div>';
    }
  }
  $("buscar").addEventListener("input", () => {
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(cargarOperaciones, 350);
  });
  $("filtro-estatus").addEventListener("change", cargarOperaciones);

  // ── P-3 · Detalle ──
  const dato = (k, v) => v ? `<div class="dato"><span class="k">${k}</span>${v}</div>` : "";
  async function abrirDetalle(folio) {
    irA("detalle");
    $("detalle").innerHTML = '<div class="estado">Cargando…</div>';
    try {
      const d = await api("/api/operacion?folio=" + encodeURIComponent(folio));
      const s = d.semaforo;
      const docLinea = (nombre, info) => `<div class="doc-linea">
          <span>${nombre}${info.folio ? " · " + esc(info.folio) : ""}</span>
          <span class="doc-estado ${esc(info.estatus)}">${esc(info.estatus)}</span>
        </div>`;
      $("detalle").innerHTML = `
        <div class="tarjeta" data-sem="${s.clave}" style="cursor:default">
          <div class="linea1">
            <span class="contraparte">${esc(d.contraparte.nombre)}</span>
            <span class="saldo">${dinero(d.operacion.saldo)}</span>
          </div>
          <div class="linea2">
            <span class="etiqueta-sem ${s.clave}">${esc(s.etiqueta)}</span>
            <span>${esc(d.folio)} · vence ${fecha(d.operacion.fechaVencimiento)}</span>
          </div>
        </div>

        <details class="bloque" open><summary>La operación</summary><div class="cuerpo">
          ${dato("Tipo", esc(d.operacion.tipo))}
          ${dato("Descripción", esc(d.operacion.descripcion))}
          ${dato("Cantidad", esc(d.operacion.cantidad))}
          ${dato("Monto total", dinero(d.operacion.montoTotal))}
          ${dato("Anticipo", d.operacion.anticipo ? dinero(d.operacion.anticipo) : "")}
          ${dato("Celebración", fecha(d.operacion.fechaCelebracion))}
          ${dato("Entrega pactada", fecha(d.operacion.fechaEntregaPactada))}
          ${dato("Lugar de entrega", esc(d.operacion.lugarEntrega))}
          ${dato("Plazo", d.operacion.plazoDias ? d.operacion.plazoDias + " días" : "")}
          ${dato("Interés moratorio", d.operacion.tasaMoratoria ? d.operacion.tasaMoratoria + "% mensual" : "")}
        </div></details>

        <details class="bloque"><summary>La contraparte</summary><div class="cuerpo">
          ${dato("RFC", esc(d.contraparte.rfc))}
          ${dato("Teléfono", d.contraparte.telefono
            ? `<a href="tel:${esc(d.contraparte.telefono)}">${esc(d.contraparte.telefono)}</a>` : "")}
          ${dato("Correo", esc(d.contraparte.correo))}
          ${dato("Aval", esc(d.contraparte.aval || ""))}
        </div></details>

        <details class="bloque"><summary>El expediente</summary><div class="cuerpo">
          ${docLinea("Ficha de Operación", d.expediente.ficha)}
          ${docLinea("Pagaré Agro", d.expediente.pagare)}
          ${d.expediente.constancia.estatus !== "No aplica" ? docLinea("Constancia de Recepción", d.expediente.constancia) : ""}
        </div></details>

        <details class="bloque"><summary>El cobro</summary><div class="cuerpo">
          ${dato("Medio", esc(d.cobro.medio))}
          ${dato("Fechas de cargo", esc(d.cobro.fechasCargo))}
          ${dato("Cargos fallidos", d.cobro.cargosFallidos ? String(d.cobro.cargosFallidos) : "")}
          ${d.cobro.escrowModelo !== "No aplica" ? dato("Escrow", esc(d.cobro.escrowModelo + " · " + d.cobro.escrowMonto)) : ""}
        </div></details>

        <details class="bloque"><summary>Bitácora</summary><div class="cuerpo"><ul class="bitacora">
          ${d.bitacora.length ? d.bitacora.map(l => `<li>${esc(l)}</li>`).join("") : "<li>Sin eventos registrados.</li>"}
        </ul></div></details>`;
    } catch (e) {
      if (e.message !== "sesion")
        $("detalle").innerHTML = '<div class="estado">Operación no encontrada.</div>';
    }
  }

  // ── P-4 · Vencimientos ──
  async function cargarVencimientos() {
    const cont = $("lista-vencimientos");
    cont.innerHTML = '<div class="estado">Cargando…</div>';
    try {
      const d = cacheOps && !$("buscar").value && !$("filtro-estatus").value
        ? { operaciones: cacheOps } : await api("/api/operaciones");
      const vivas = d.operaciones.filter(t => t.semaforo.clave !== "liquidada");
      const vencidas = vivas.filter(t => t.semaforo.clave === "vencida")
        .sort((a, b) => (b.semaforo.diasMora || 0) - (a.semaforo.diasMora || 0));
      const proximas = vivas.filter(t => t.semaforo.clave !== "vencida" && t.semaforo.clave !== "disputa"
        && t.vencimiento && (t.semaforo.diasRestantes ?? 99) <= 30);
      const semana = n => proximas.filter(t => t.semaforo.diasRestantes > (n - 1) * 7 - (n === 1 ? 1 : 0)
        && t.semaforo.diasRestantes <= n * 7);
      const bloque = (titulo, lista) => lista.length
        ? `<div class="grupo-semana"><h3>${titulo}</h3>${lista.map(tarjetaHTML).join("")}</div>` : "";
      cont.innerHTML =
        bloque("Vencidas — de mayor a menor antigüedad", vencidas) +
        bloque("Esta semana", semana(1)) +
        bloque("En 8 a 14 días", semana(2)) +
        bloque("En 15 a 21 días", semana(3)) +
        bloque("En 22 a 30 días", proximas.filter(t => t.semaforo.diasRestantes > 21)) ||
        '<div class="estado">Nada vence en los próximos 30 días y no hay saldos vencidos.</div>';
      cont.querySelectorAll(".tarjeta").forEach(b =>
        b.addEventListener("click", () => abrirDetalle(b.dataset.folio)));
    } catch (e) {
      if (e.message !== "sesion")
        cont.innerHTML = '<div class="estado">No fue posible cargar los vencimientos.</div>';
    }
  }

  cargarResumen();
})();
