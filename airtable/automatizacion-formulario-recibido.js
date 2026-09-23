// ─────────────────────────────────────────────────────────────────────────────
// Script para la automatización NATIVA de Airtable (sin plataforma intermediaria)
//
//   Tabla:     Contrapartes
//   Disparador: "When a form is submitted"  (una automatización por formulario:
//              una para "Comprador nuevo" y otra para "Aval"; el script es el mismo)
//   Acción:    "Run a script"
//   Variable de entrada (Input variables → Add):
//              nombre: recordId   valor: Airtable record ID (del disparador)
//
// Qué hace: avisa al Panel que llegó un formulario. El Panel relee el registro,
// valida el token firmado y el RFC, y retoma la conversación de WhatsApp.
// El script NO envía los datos capturados: solo el id. Así, aunque alguien
// alterara el script, no podría inyectar datos distintos a los del registro.
//
// Sustituye <SITIO> por el dominio del Panel y <SECRETO> por el valor exacto de
// AUTOMATIZACION_SECRET en Netlify. Nota: el script es visible para quien
// tenga permiso de edición en la base.
// ─────────────────────────────────────────────────────────────────────────────
const { recordId } = input.config();

const respuesta = await fetch("https://<SITIO>/api/formulario-recibido", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-SSCAE-Secreto": "<SECRETO>"
  },
  body: JSON.stringify({ recordId })
});

if (!respuesta.ok) {
  // Marca la ejecución como fallida en el historial de la automatización,
  // para poder reintentarla desde Airtable.
  throw new Error(`El Panel respondió ${respuesta.status}`);
}
console.log(`Formulario ${recordId} entregado al Panel.`);
