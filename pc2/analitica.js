/**
 * PC2 - Servicio de Analítica
 *
 * Responsabilidades:
 *  - Suscribirse a eventos de sensores desde PC1 (ZMQ SUB)
 *  - Aplicar reglas de tráfico y detectar congestión
 *  - Gestionar ciclos VERDE/ROJO de cada semáforo de forma asíncrona e independiente
 *  - Enviar comandos de estado a control_semaforos.js (ZMQ PUSH)
 *  - Recibir indicaciones directas del usuario desde PC3 (ZMQ REP)
 *  - Reenviar eventos a la BD principal en PC3 (ZMQ PUSH)
 *  - Escribir réplica local de eventos en replica_eventos.json
 *
 * Ciclo de semáforos:
 *  Cada intersección tiene un loop propio: VERDE (N seg) → ROJO (TIEMPO_ROJO seg) → ...
 *  Cuando llegan datos de sensores o un comando de usuario, el ciclo se reinicia
 *  con la nueva duración de verde según la condición detectada.
 *
 * Run: node analitica.js
 */

import { Subscriber, Push, Reply } from "zeromq";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // [PC1 → PC2] PC1 publica sensores acá, nosotros nos suscribimos
  // ⚠️ En red: cambiar por la IP real de PC1
  // ✅ En localhost: no cambiar
  PC1_PUB_ADDRESS: "tcp://127.0.0.1:5555",

  // [PC2 interno] Enviamos comandos a control_semaforos.js en este mismo PC
  // ✅ No cambiar (comunicación interna dentro de PC2)
  CONTROL_SEMAFOROS_ADDRESS: "tcp://127.0.0.1:5560",

  // [PC3 → PC2] PC3 nos envía comandos directos del usuario, nosotros respondemos
  // ✅ No cambiar IP (escuchamos en todas las interfaces de PC2)
  MONITOREO_REP_ADDRESS: "tcp://0.0.0.0:5565",

  // [PC2 → PC3] Enviamos eventos a la BD principal en PC3
  // ⚠️ En red: cambiar por la IP real de PC3
  // ✅ En localhost: no cambiar
  PC3_BD_ADDRESS: "tcp://127.0.0.1:5570",

  // Archivo de réplica local (BD réplica en PC2)
  // ✅ No cambiar salvo que quieras otra ruta
  REPLICA_FILE: "./replica_eventos.json",

  // Matriz de la ciudad
  // ⚠️ Cambiar ROWS y COLS si cambian el tamaño de la matriz
  // ⚠️ Debe coincidir exactamente con control_semaforos.js
  MATRIX: {
    ROWS: ["A", "B", "C"],
    COLS: [1, 2, 3, 4, 5],
  },

  // Tiempo fijo en ROJO entre ciclos (segundos)
  // ⚠️ Ajustar si se quiere cambiar el tiempo de espera en rojo
  TIEMPO_ROJO: 15,

  // Tiempo verde inicial para todos los semáforos al arrancar (condición NORMAL)
  // ⚠️ Debe coincidir con TIEMPOS.NORMAL en control_semaforos.js
  TIEMPO_VERDE_INICIAL: 15,

  // Milisegundos entre comprobaciones dentro de cada ciclo
  // Determina qué tan rápido reacciona un ciclo a ser cancelado
  // ✅ No cambiar salvo que quieras más o menos precisión
  TICK_MS: 200,
};

// ─── ESTADO DE LA CIUDAD ──────────────────────────────────────────────────────

/**
 * intersectionState: últimos valores de sensores por intersección
 * { "INT-A1": { Q, Vp, Cv, nivel_gps }, ... }
 */
const intersectionState = {};

/**
 * semaforoState: estado actual de la luz por intersección
 * { "INT-A1": "ROJO" | "VERDE" }
 */
const semaforoState = {};

/**
 * ciclos: metadatos del ciclo activo por intersección
 * {
 *   "INT-A1": {
 *     generacion: number,   // incrementar para cancelar el ciclo actual
 *     condicion:  string,   // NORMAL | MODERADO | CONGESTION | PRIORIDAD
 *     tiempoVerde: number,  // segundos en verde
 *   }
 * }
 */
const ciclos = {};

function inicializarEstados() {
  for (const fila of CONFIG.MATRIX.ROWS) {
    for (const col of CONFIG.MATRIX.COLS) {
      const id = `INT-${fila}${col}`;
      intersectionState[id] = {};
      semaforoState[id]     = "ROJO";
    }
  }
}

inicializarEstados();
console.log(`[Analítica] Matriz ${CONFIG.MATRIX.ROWS.length}x${CONFIG.MATRIX.COLS.length} inicializada.`);
console.log(`  Intersecciones: ${Object.keys(intersectionState).join(", ")}\n`);

// ─── REGLAS DE TRÁFICO ────────────────────────────────────────────────────────
/**
 * Evalúa las reglas de tráfico para una intersección.
 *
 * Variables:
 *  Q  = longitud de cola, núm vehículos en espera (cámara)
 *  Vp = velocidad promedio km/h (cámara o GPS)
 *  Cv = vehículos contados en 30s (espira)
 *
 * Reglas:
 *  CONGESTION: Q >= 10 OR  Vp <= 15 OR  Cv >= 30  → verde 30s
 *  NORMAL:     Q <  5 AND Vp >  35 AND Cv <  20   → verde 15s
 *  MODERADO:   cualquier otro caso                 → verde 20s
 */
function evaluarTrafico(interseccion) {
  const s = intersectionState[interseccion];
  if (!s) return null;

  const { Q, Vp, Cv } = s;
  if (Q === undefined && Vp === undefined && Cv === undefined) return null;

  const q  = Q  ?? 0;
  const vp = Vp ?? 50;
  const cv = Cv ?? 0;

  if (q >= 10 || vp <= 15 || cv >= 30) return { condicion: "CONGESTION", tiempo_verde: 30 };
  if (q < 5 && vp > 35 && cv < 20)    return { condicion: "NORMAL",     tiempo_verde: 15 };
  return { condicion: "MODERADO", tiempo_verde: 20 };
}

// ─── RÉPLICA LOCAL ────────────────────────────────────────────────────────────

function leerReplica() {
  try { return JSON.parse(fs.readFileSync(CONFIG.REPLICA_FILE, "utf8")); }
  catch { return []; }
}

function guardarEnReplica(evento) {
  const datos = leerReplica();
  datos.push({ ...evento, replica_timestamp: new Date().toISOString() });
  fs.writeFileSync(CONFIG.REPLICA_FILE, JSON.stringify(datos, null, 2));
}

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const sub     = new Subscriber();
const pushSem = new Push();
const pushBD  = new Push();
const rep     = new Reply();

sub.connect(CONFIG.PC1_PUB_ADDRESS);
sub.subscribe("camara");
sub.subscribe("espira_inductiva");
sub.subscribe("gps");
console.log(`[SUB] Conectado a PC1 en ${CONFIG.PC1_PUB_ADDRESS}`);

await pushSem.bind(CONFIG.CONTROL_SEMAFOROS_ADDRESS);
console.log(`[PUSH→control] Escuchando en ${CONFIG.CONTROL_SEMAFOROS_ADDRESS}`);

await pushBD.connect(CONFIG.PC3_BD_ADDRESS);
console.log(`[PUSH→BD] Conectado a PC3 en ${CONFIG.PC3_BD_ADDRESS}`);

await rep.bind(CONFIG.MONITOREO_REP_ADDRESS);
console.log(`[REP] Escuchando comandos de PC3 en ${CONFIG.MONITOREO_REP_ADDRESS}\n`);

// ─── CICLOS DE SEMÁFOROS ──────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Variable para encolar los mensajes a ZeroMQ y evitar colisiones (EBUSY)
let colaEnvioSem = Promise.resolve();

/**
 * Envía un comando SET_ESTADO a control_semaforos.js.
 * Actualiza también semaforoState local.
 */
async function enviarEstado(interseccion, estado, condicion, tiempoVerde, origen) {
  semaforoState[interseccion] = estado;
  const cmd = {
    tipo:         "SET_ESTADO",
    interseccion,
    estado,
    condicion,
    tiempo_verde: tiempoVerde,
    timestamp:    new Date().toISOString(),
    ...(origen && { origen }),
  };
  
  // Encolamos el envío: esperamos a que el anterior termine antes de enviar el actual
  colaEnvioSem = colaEnvioSem
    .then(() => pushSem.send(JSON.stringify(cmd)))
    .catch((err) => console.error("[Analítica] Error enviando a socket:", err));
    
  await colaEnvioSem;
}

/**
 * Loop de ciclo para una intersección.
 * Alterna VERDE (tiempoVerde seg) → ROJO (TIEMPO_ROJO seg) → VERDE...
 * Se cancela automáticamente si se detecta una nueva generación (reiniciarCiclo).
 *
 * @param {string} interseccion
 * @param {number} gen  - generación asignada a este ciclo
 */
async function ejecutarCiclo(interseccion, gen) {
  while (ciclos[interseccion]?.generacion === gen) {
    const { condicion, tiempoVerde } = ciclos[interseccion];

    // ── Fase VERDE ───────────────────────────────────────────────────────────
    await enviarEstado(interseccion, "VERDE", condicion, tiempoVerde);
    console.log(`[Ciclo] ${interseccion} → VERDE | ${condicion} | ${tiempoVerde}s`);

    // Esperar tiempoVerde en ticks pequeños para poder cancelar rápido
    const finVerde = Date.now() + tiempoVerde * 1000;
    while (Date.now() < finVerde) {
      if (ciclos[interseccion]?.generacion !== gen) return;
      await sleep(CONFIG.TICK_MS);
    }
    if (ciclos[interseccion]?.generacion !== gen) return;

    // ── Fase ROJA ────────────────────────────────────────────────────────────
    await enviarEstado(interseccion, "ROJO", condicion, tiempoVerde);
    console.log(`[Ciclo] ${interseccion} → ROJO | espera ${CONFIG.TIEMPO_ROJO}s`);

    const finRojo = Date.now() + CONFIG.TIEMPO_ROJO * 1000;
    while (Date.now() < finRojo) {
      if (ciclos[interseccion]?.generacion !== gen) return;
      await sleep(CONFIG.TICK_MS);
    }
  }
}

/**
 * Inicia o reinicia el ciclo de una intersección.
 * Si hay un ciclo activo, se cancela en el próximo tick.
 * El nuevo ciclo arranca inmediatamente en fase VERDE.
 *
 * @param {string} interseccion
 * @param {string} condicion    - NORMAL | MODERADO | CONGESTION | PRIORIDAD
 * @param {number} tiempoVerde  - segundos en verde
 * @param {string} [origen]     - SENSOR | USUARIO (solo para logs)
 */
function reiniciarCiclo(interseccion, condicion, tiempoVerde, origen) {
  const gen = (ciclos[interseccion]?.generacion ?? -1) + 1;
  ciclos[interseccion] = { generacion: gen, condicion, tiempoVerde };

  const origenTag = origen ? ` [${origen}]` : "";
  console.log(`[Analítica] Ciclo reiniciado: ${interseccion} | ${condicion} | verde=${tiempoVerde}s${origenTag}`);

  ejecutarCiclo(interseccion, gen); // fire-and-forget, corre en background
}

// ─── INICIAR CICLOS AL ARRANQUE ───────────────────────────────────────────────
// Todos los semáforos arrancan con condición NORMAL.
// Se escalonan aleatoriamente para que no todos estén en verde al mismo tiempo.
{
  const ids = Object.keys(intersectionState);
  
  ids.forEach((id) => {
    // Iniciamos inmediatamente sin delay
    reiniciarCiclo(id, "NORMAL", CONFIG.TIEMPO_VERDE_INICIAL, "AUTO");
  });

  console.log(`[Analítica] Ciclos iniciados en paralelo para ${ids.length} intersecciones.\n`);
}

// ─── PROCESAMIENTO DE EVENTOS DE SENSORES ────────────────────────────────────

async function procesarEvento(topic, raw) {
  let evento;
  try { evento = JSON.parse(raw); }
  catch {
    console.error(`[Analítica] JSON inválido en tópico ${topic}: ${raw}`);
    return;
  }

  const interseccion = evento.interseccion ?? evento.sensor_id?.replace(/^GPS-/, "INT-");

  if (!intersectionState[interseccion]) {
    console.warn(`[Analítica] Intersección desconocida o fuera de matriz: ${interseccion}`);
    return;
  }

  // Actualizar estado de sensores
  if (topic === "camara") {
    intersectionState[interseccion].Q  = evento.volumen;
    intersectionState[interseccion].Vp = evento.velocidad_promedio;
  } else if (topic === "espira_inductiva") {
    intersectionState[interseccion].Cv = evento.vehiculos_contados;
  } else if (topic === "gps") {
    intersectionState[interseccion].Vp        = evento.velocidad_promedio;
    intersectionState[interseccion].nivel_gps = evento.nivel_congestion;
  }

  console.log(`[Analítica] Sensor [${topic}] en ${interseccion}`);

  // Evaluar reglas y, si la condición cambió, reiniciar ciclo
  const resultado = evaluarTrafico(interseccion);
  if (resultado) {
    const condicionActual = ciclos[interseccion]?.condicion;
    if (resultado.condicion !== condicionActual) {
      console.log(`[Analítica] ${interseccion}: ${condicionActual} → ${resultado.condicion}`);
      reiniciarCiclo(interseccion, resultado.condicion, resultado.tiempo_verde, "SENSOR");
    }
  }

  // Persistir evento
  const registro = { topic, evento, timestamp: new Date().toISOString() };
  guardarEnReplica(registro);
  await pushBD.send(JSON.stringify(registro));
}

// ─── LOOP PRINCIPAL: EVENTOS DE SENSORES ─────────────────────────────────────
(async () => {
  for await (const [topicBuf, dataBuf] of sub) {
    await procesarEvento(topicBuf.toString(), dataBuf.toString());
  }
})();

// ─── LOOP SECUNDARIO: COMANDOS DIRECTOS DE PC3 ───────────────────────────────
/**
 * Comandos soportados desde PC3 (JSON):
 *
 * { "tipo": "FORZAR_VERDE",    "interseccion": "INT-C5", "duracion": 60 }
 *   → Reinicia ciclo con condición PRIORIDAD y duracion como tiempoVerde.
 *      Al terminar el verde, el ciclo retoma la condición del sensor.
 *
 * { "tipo": "CONSULTA_ESTADO", "interseccion": "INT-C5" }
 *   → Devuelve estado actual de esa intersección.
 *
 * { "tipo": "CONSULTA_TODOS" }
 *   → Devuelve estado de TODAS las intersecciones de la matriz.
 */
(async () => {
  for await (const [msgBuf] of rep) {
    let comando;
    try { comando = JSON.parse(msgBuf.toString()); }
    catch {
      await rep.send(JSON.stringify({ error: "JSON inválido" }));
      continue;
    }

    console.log(`\n[Analítica] Comando de PC3: ${JSON.stringify(comando)}`);

    if (comando.tipo === "FORZAR_VERDE") {
      const { interseccion, duracion } = comando;
      const dur = duracion ?? 60;

      reiniciarCiclo(interseccion, "PRIORIDAD", dur, "USUARIO");

      // Cuando el verde de prioridad termine, volver a la condición del sensor
      setTimeout(() => {
        const resultado = evaluarTrafico(interseccion);
        const condicion = resultado?.condicion ?? "NORMAL";
        const tverde    = resultado?.tiempo_verde ?? CONFIG.TIEMPO_VERDE_INICIAL;
        console.log(`[Analítica] ${interseccion}: PRIORIDAD terminada → retomando ${condicion}`);
        reiniciarCiclo(interseccion, condicion, tverde, "AUTO");
      }, (dur + CONFIG.TIEMPO_ROJO) * 1000);

      await rep.send(JSON.stringify({
        ok: true,
        mensaje: `Verde forzado en ${interseccion} por ${dur}s`,
      }));

    } else if (comando.tipo === "CONSULTA_ESTADO") {
      const { interseccion } = comando;
      await rep.send(JSON.stringify({
        interseccion,
        sensores: intersectionState[interseccion] ?? null,
        semaforo: semaforoState[interseccion]     ?? "ROJO",
        ciclo:    ciclos[interseccion]            ?? null,
        regla:    evaluarTrafico(interseccion),
      }));

    } else if (comando.tipo === "CONSULTA_TODOS") {
      const todas = Object.keys(intersectionState).map((interseccion) => ({
        interseccion,
        sensores: intersectionState[interseccion],
        semaforo: semaforoState[interseccion] ?? "ROJO",
        regla:    evaluarTrafico(interseccion),
        ciclo:    ciclos[interseccion] ?? null,
      }));
      await rep.send(JSON.stringify({ intersecciones: todas }));

    } else {
      await rep.send(JSON.stringify({ error: `Comando desconocido: ${comando.tipo}` }));
    }
  }
})();

console.log("[Analítica] Servicio iniciado y escuchando...\n");