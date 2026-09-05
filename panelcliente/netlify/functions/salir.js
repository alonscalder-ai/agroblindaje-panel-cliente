// salir.js — cierra la sesión invalidando la cookie.
"use strict";
const L = require("./_lib.js");
exports.handler = async () =>
  L.json(200, { mensaje: "Sesión cerrada." }, { "Set-Cookie": L.cookieSesion(null) });
