/**
 * PC2 - Servicio de Control de Semáforos
 *
 * Responsabilidades:
 *  - Recibir comandos de estado desde analitica.js (ZMQ PULL)
 *  - Mantener el estado de la matriz de semáforos en memoria
 *  - Aplicar cambios de luz (ROJO ↔ VERDE) directamente sin timeouts propios
 *  - Persistir el estado de semáforos en replica_semaforos.json
 *
 * Nota: los ciclos y timers son gestionados por analitica.js.
 *       Este servicio solo ejecuta los comandos que recibe.
 *
 * Run: node control_semaforos.js
 */

import { Pull } from "zeromq";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // [PC2 interno] Recibimos comandos de analitica.js
  // ✅ No cambiar (comunicación interna dentro de PC2)
  PULL_ADDRESS: "tcp://127.0.0.1:5560",

  // Matriz de la ciudad
  // ⚠️ Cambiar ROWS y COLS si cambian el tamaño de la matriz
  // ⚠️ Debe coincidir exactamente con analitica.js
  MATRIX: {
    ROWS: ["A", "B", "C"],
    COLS: [1, 2, 3, 4, 5],
  },

  // Archivo de réplica local de semáforos
  // ✅ No cambiar salvo que quieras otra ruta
  REPLICA_FILE: "./replica_semaforos.json",
};

// ─── MATRIZ DE SEMÁFOROS ──────────────────────────────────────────────────────

/**
 * Genera el estado inicial de todos los semáforos de la matriz NxM.
 * Todos arrancan en ROJO — analítica iniciará los ciclos y mandará los primeros VERDE.
 */
function inicializarMatriz() {
  const matriz = {};
  for (const fila of CONFIG.MATRIX.ROWS) {
    for (const col of CONFIG.MATRIX.COLS) {
      const id = `INT-${fila}${col}`;
      matriz[id] = {
        estado:        "ROJO",
        condicion:     "NORMAL",
        tiempo_verde:  15,
        ultimo_cambio: new Date().toISOString(),
      };
    }
  }
  return matriz;
}

const semaforos = inicializarMatriz();
console.log(`[Semáforos] Matriz ${CONFIG.MATRIX.ROWS.length}x${CONFIG.MATRIX.COLS.length} inicializada:`);
console.log(`  Intersecciones: ${Object.keys(semaforos).join(", ")}\n`);

// ─── RÉPLICA LOCAL ────────────────────────────────────────────────────────────

function guardarReplica() {
  fs.writeFileSync(
    CONFIG.REPLICA_FILE,
    JSON.stringify({ timestamp: new Date().toISOString(), semaforos }, null, 2)
  );
}

guardarReplica(); // snapshot inicial

// ─── APLICAR COMANDO ──────────────────────────────────────────────────────────

/**
 * Aplica un comando de estado recibido desde analítica.
 *
 * Tipos aceptados:
 *  - "SET_ESTADO": aplica directamente el estado indicado (VERDE o ROJO)
 *  - "CAMBIO_SEMAFORO": compatibilidad con versiones anteriores (toggle)
 *
 * Campos del comando:
 * {
 *   tipo:         "SET_ESTADO",
 *   interseccion: "INT-C5",
 *   estado:       "VERDE" | "ROJO",
 *   condicion:    "NORMAL" | "MODERADO" | "CONGESTION" | "PRIORIDAD",
 *   tiempo_verde: 30,
 *   timestamp:    "...",
 *   origen:       "SENSOR" | "USUARIO" | "AUTO"  (opcional)
 * }
 */
function aplicarComando(comando) {
  const { tipo, interseccion, estado, condicion, tiempo_verde, origen } = comando;

  if (!semaforos[interseccion]) {
    console.warn(`[Semáforos] ⚠️  Intersección desconocida: ${interseccion}`);
    return;
  }

  const sem          = semaforos[interseccion];
  const estadoAntes  = sem.estado;

  // Determinar nuevo estado
  let nuevoEstado;
  if (tipo === "SET_ESTADO") {
    // Analítica dice exactamente qué estado poner
    nuevoEstado = estado;
  } else {
    // Compatibilidad: CONGESTION/PRIORIDAD fuerzan VERDE, resto hace toggle
    if (condicion === "PRIORIDAD" || condicion === "CONGESTION") {
      nuevoEstado = "VERDE";
    } else {
      nuevoEstado = sem.estado === "ROJO" ? "VERDE" : "ROJO";
    }
  }

  sem.estado        = nuevoEstado;
  sem.condicion     = condicion ?? sem.condicion;
  sem.tiempo_verde  = tiempo_verde ?? sem.tiempo_verde;
  sem.ultimo_cambio = new Date().toISOString();

  // Solo imprimir cuando hay cambio real de estado para no saturar la terminal
  if (nuevoEstado !== estadoAntes) {
    const origenTag = origen ? ` [${origen}]` : "";
    console.log(
      `[Semáforos] ${interseccion} | ${estadoAntes} → ${nuevoEstado}` +
      ` | ${sem.condicion} | verde: ${sem.tiempo_verde}s${origenTag}`
    );
    guardarReplica();
  }
}

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const pull = new Pull();
await pull.connect(CONFIG.PULL_ADDRESS);
console.log(`[PULL] Conectado a analítica en ${CONFIG.PULL_ADDRESS}`);
console.log("[Semáforos] Servicio iniciado, esperando comandos...\n");

// ─── LOOP PRINCIPAL ───────────────────────────────────────────────────────────
for await (const [msgBuf] of pull) {
  let comando;
  try { comando = JSON.parse(msgBuf.toString()); }
  catch {
    console.error("[Semáforos] Comando JSON inválido recibido");
    continue;
  }

  if (comando.tipo === "SET_ESTADO" || comando.tipo === "CAMBIO_SEMAFORO") {
    aplicarComando(comando);
  } else {
    console.warn(`[Semáforos] Tipo de comando desconocido: ${comando.tipo}`);
  }
}