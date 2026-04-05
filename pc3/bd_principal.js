/**
 * PC3 - Base de Datos Principal
 *
 * Responsabilidades:
 *  - Recibir eventos desde analítica en PC2 (ZMQ PULL)
 *  - Persistir todos los eventos en bd_principal.json
 *
 * Run: node bd_principal.js
 */

import { Pull } from "zeromq";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // [PC2 → PC3] Recibimos eventos de analítica
  // ✅ En localhost no cambiar. En red: cambiar a la IP de PC3 en PC2 (analitica.js)
  PULL_ADDRESS: "tcp://0.0.0.0:5570",

  // Archivo de base de datos principal
  // ✅ No cambiar salvo que quieras otra ruta
  BD_FILE: "./bd_principal.json",
};

// ─── HELPERS BD ───────────────────────────────────────────────────────────────

/** Lee la BD o devuelve estructura vacía si no existe */
function leerBD() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.BD_FILE, "utf8"));
  } catch {
    return { eventos: [], semaforos: {} };
  }
}

/** Guarda un nuevo evento en la BD */
function guardarEvento(registro) {
  const bd = leerBD();
  bd.eventos.push(registro);
  fs.writeFileSync(CONFIG.BD_FILE, JSON.stringify(bd, null, 2));
}

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const pull = new Pull();
await pull.bind(CONFIG.PULL_ADDRESS);
console.log(`[BD Principal] Escuchando en ${CONFIG.PULL_ADDRESS}`);
console.log(`[BD Principal] Guardando en ${CONFIG.BD_FILE}\n`);

// Inicializar archivo si no existe
if (!fs.existsSync(CONFIG.BD_FILE)) {
  fs.writeFileSync(CONFIG.BD_FILE, JSON.stringify({ eventos: [], semaforos: {} }, null, 2));
  console.log("[BD Principal] Archivo creado.");
}

// ─── LOOP PRINCIPAL ───────────────────────────────────────────────────────────
let totalEventos = 0;
for await (const [msgBuf] of pull) {
  let registro;
  try {
    registro = JSON.parse(msgBuf.toString());
  } catch {
    console.error("[BD Principal] JSON inválido recibido");
    continue;
  }

  guardarEvento(registro);
  totalEventos++;
  console.log(`[BD Principal] Evento #${totalEventos} guardado | topic: ${registro.topic} | intersección: ${registro.evento?.interseccion ?? "N/A"}`);
}