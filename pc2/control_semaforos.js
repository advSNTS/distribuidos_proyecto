/**
 * PC2 - Servicio de Control de Semáforos
 *
 * Responsabilidades:
 *  - Recibir comandos desde analitica.js (ZMQ PULL)
 *  - Mantener el estado de la matriz de semáforos en memoria
 *  - Ejecutar cambios de luz (ROJO ↔ VERDE)
 *  - Persistir el estado de semáforos en replica_semaforos.json
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

  // Matriz de la ciudad: filas=letras, columnas=números
  // ⚠️ Cambiar ROWS y COLS si quieren una matriz distinta a 3x5
  MATRIX: {
    ROWS: ["A", "B", "C"],       // 3 filas  → A, B, C
    COLS: [1, 2, 3, 4, 5],       // 5 columnas → 1..5
  },

  // Tiempos de verde por condición (segundos)
  // ⚠️ Ajustar si cambian las reglas en analitica.js
  TIEMPOS: {
    NORMAL:     15,
    MODERADO:   20,
    CONGESTION: 30,
    PRIORIDAD:  60,
  },

  // Archivo de réplica local de semáforos
  // ✅ No cambiar salvo que quieras otra ruta
  REPLICA_FILE: "./replica_semaforos.json",
};

// ─── MATRIZ DE SEMÁFOROS ──────────────────────────────────────────────────────

/**
 * Genera el estado inicial de todos los semáforos de la matriz NxM.
 * Cada intersección arranca en ROJO con modo NORMAL.
 *
 * Estructura:
 * {
 *   "INT-A1": { estado: "ROJO", modo: "NORMAL", tiempo_verde: 15, ultimo_cambio: "..." },
 *   "INT-A2": { ... },
 *   ...
 * }
 */
function inicializarMatriz() {
  const matriz = {};
  for (const fila of CONFIG.MATRIX.ROWS) {
    for (const col of CONFIG.MATRIX.COLS) {
      const id = `INT-${fila}${col}`;
      matriz[id] = {
        estado:        "ROJO",
        modo:          "NORMAL",
        tiempo_verde:  CONFIG.TIEMPOS.NORMAL,
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

/** Persiste el estado completo de la matriz en el archivo de réplica */
function guardarReplica() {
  const snapshot = {
    timestamp: new Date().toISOString(),
    semaforos,
  };
  fs.writeFileSync(CONFIG.REPLICA_FILE, JSON.stringify(snapshot, null, 2));
}

// Guardar estado inicial
guardarReplica();

// ─── LÓGICA DE SEMÁFOROS ──────────────────────────────────────────────────────

/**
 * Aplica un comando de cambio de semáforo recibido desde analítica.
 *
 * Comando esperado:
 * {
 *   tipo:        "CAMBIO_SEMAFORO",
 *   interseccion: "INT-C5",
 *   condicion:   "NORMAL" | "MODERADO" | "CONGESTION" | "PRIORIDAD",
 *   tiempo_verde: 15,
 *   timestamp:   "...",
 *   origen:      "SENSOR" | "USUARIO"  (opcional)
 * }
 */
function aplicarComando(comando) {
  const { interseccion, condicion, tiempo_verde, origen } = comando;

  if (!semaforos[interseccion]) {
    console.warn(`[Semáforos] ⚠️  Intersección desconocida: ${interseccion}`);
    return;
  }

  const semaforo = semaforos[interseccion];
  const estadoAnterior = semaforo.estado;

  // Determinar nuevo estado según condición
  // En PRIORIDAD y CONGESTION forzamos VERDE para dar paso
  // En NORMAL/MODERADO hacemos toggle (simula el ciclo rojo↔verde)
  let nuevoEstado;
  if (condicion === "PRIORIDAD" || condicion === "CONGESTION") {
    nuevoEstado = "VERDE";
  } else {
    nuevoEstado = semaforo.estado === "ROJO" ? "VERDE" : "ROJO";
  }

  semaforo.estado        = nuevoEstado;
  semaforo.modo          = condicion;
  semaforo.tiempo_verde  = tiempo_verde ?? CONFIG.TIEMPOS[condicion] ?? 15;
  semaforo.ultimo_cambio = new Date().toISOString();

  // Log por pantalla
  const origenTag = origen ? ` [origen: ${origen}]` : "";
  const cambio    = `${estadoAnterior} → ${nuevoEstado}`;

  console.log(`[Semáforos] ${interseccion} | ${cambio} | modo: ${condicion} | verde: ${semaforo.tiempo_verde}s${origenTag}`);

  // Si pasó a VERDE, programar vuelta a ROJO automáticamente
  if (nuevoEstado === "VERDE") {
    setTimeout(() => {
      semaforos[interseccion].estado        = "ROJO";
      semaforos[interseccion].ultimo_cambio = new Date().toISOString();
      console.log(`[Semáforos] ${interseccion} | VERDE → ROJO (tiempo cumplido: ${semaforo.tiempo_verde}s)`);
      guardarReplica();
    }, semaforo.tiempo_verde * 1000);
  }

  guardarReplica();
}

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const pull = new Pull();
await pull.connect(CONFIG.PULL_ADDRESS);
console.log(`[PULL] Conectado a analítica en ${CONFIG.PULL_ADDRESS}`);
console.log("[Semáforos] Servicio iniciado, esperando comandos...\n");

// ─── LOOP PRINCIPAL ───────────────────────────────────────────────────────────
for await (const [msgBuf] of pull) {
  let comando;
  try {
    comando = JSON.parse(msgBuf.toString());
  } catch {
    console.error("[Semáforos] Comando JSON inválido recibido");
    continue;
  }

  if (comando.tipo === "CAMBIO_SEMAFORO") {
    aplicarComando(comando);
  } else {
    console.warn(`[Semáforos] Tipo de comando desconocido: ${comando.tipo}`);
  }
}