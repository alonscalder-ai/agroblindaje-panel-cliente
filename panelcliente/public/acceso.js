// acceso.js — flujo de dos pasos: contacto → código → cookie de sesión.
"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const paso1 = $("paso1"), paso2 = $("paso2"), msj = $("mensaje");
  let contacto = "";

  function decir(texto, esError) {
    msj.textContent = texto;
    msj.className = "mensaje" + (esError ? " error" : "");
  }

  async function llamar(ruta, cuerpo) {
    const r = await fetch(ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(cuerpo)
    });
    const datos = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, datos };
  }

  paso1.addEventListener("submit", async (e) => {
    e.preventDefault();
    contacto = $("contacto").value.trim();
    if (!contacto) return;
    decir("Enviando…");
    const r = await llamar("/api/acceso-solicitar", { contacto });
    decir(r.datos.mensaje || "Si el dato es correcto, recibirás un código.");
    paso1.classList.add("oculto");
    paso2.classList.remove("oculto");
    $("codigo").focus();
  });

  paso2.addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = $("codigo").value.trim();
    if (!/^\d{6}$/.test(codigo)) { decir("Escribe los 6 dígitos del código.", true); return; }
    decir("Verificando…");
    const r = await llamar("/api/acceso-validar", { contacto, codigo });
    if (r.ok) {
      location.href = "/panel.html";
    } else if (r.status === 429) {
      decir(r.datos.error, true);
    } else {
      decir(r.datos.error || "Código incorrecto o vencido.", true);
      $("codigo").value = ""; $("codigo").focus();
    }
  });

  $("reenviar").addEventListener("click", () => {
    paso2.classList.add("oculto");
    paso1.classList.remove("oculto");
    decir("");
    $("contacto").focus();
  });
})();
