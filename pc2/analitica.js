/**
 * PC2 - Servicio de Analítica
 *
 * Responsabilidades:
 *  - Suscribirse a eventos de sensores desde PC1 (ZMQ SUB)
 *  - Aplicar reglas de tráfico y detectar congestión
 *  - Enviar comandos de cambio de semáforo a control_semaforos.js (ZMQ PUSH)
 *  - Recibir indicaciones directas del usuario desde PC3 (ZMQ REP)
 *  - Reenviar eventos a la BD principal en PC3 (ZMQ PUSH)
 *  - Escribir réplica local de eventos en replica_eventos.json
 *
 * Run: node analitica.js
 */

import { Subscriber, Push, Reply } from "zeromq";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // [PC1 → PC2] PC1 publica sensores acá, nosotros nos suscribimos
  // ⚠️ Cambiar IP por la IP real de PC1
  PC1_PUB_ADDRESS: "tcp://127.0.0.1:5555",

  // [PC2 interno] Enviamos comandos a control_semaforos.js en este mismo PC
  // ✅ No cambiar (comunicación interna dentro de PC2)
  CONTROL_SEMAFOROS_ADDRESS: "tcp://127.0.0.1:5560",

  // [PC3 → PC2] PC3 nos envía comandos directos del usuario, nosotros respondemos
  // ✅ No cambiar IP (escuchamos en todas las interfaces de PC2)
  MONITOREO_REP_ADDRESS: "tcp://0.0.0.0:5565",

  // [PC2 → PC3] Enviamos eventos a la BD principal en PC3
  // ⚠️ Cambiar IP por la IP real de PC3
  PC3_BD_ADDRESS: "tcp://IP_DE_PC3:5570",

  // Archivo de réplica local (BD réplica en PC2)
  // ✅ No cambiar salvo que quieras otra ruta
  REPLICA_FILE: "./replica_eventos.json",
};

// ─── REGLAS DE TRÁFICO ────────────────────────────────────────────────────────
// Estado acumulado por intersección: guarda los últimos valores de cada sensor
// Se actualiza con cada evento recibido y se evalúan las reglas combinadas
const intersectionState = {}; // { "INT-C5": { Q, Vp, Cv, nivel_gps } }

/**
 * Evalúa las reglas de tráfico para una intersección y devuelve el estado.
 *
 * Variables:
 *  Q  = volumen (longitud de cola, cámara)
 *  Vp = velocidad_promedio (cámara o GPS)
 *  Cv = vehiculos_contados en 30s (espira)
 *
 * Reglas:
 *  NORMAL:     Q < 5  AND Vp > 35 AND Cv < 20  → verde 15s
 *  MODERADO:   entre normal y congestionado     → verde 20s
 *  CONGESTION: Q >= 10 OR Vp <= 15 OR Cv >= 30 → verde 30s
 */
function evaluarTrafico(interseccion) {
  const s = intersectionState[interseccion];
  if (!s) return null;

  const { Q, Vp, Cv } = s;

  // Solo evaluar si tenemos al menos un valor de cada tipo
  if (Q === undefined && Vp === undefined && Cv === undefined) return null;

  // Usar valores por defecto si aún no llegó algún sensor
  const q  = Q  ?? 0;
  const vp = Vp ?? 50;
  const cv = Cv ?? 0;

  if (q >= 10 || vp <= 15 || cv >= 30) {
    return { condicion: "CONGESTION", tiempo_verde: 30 };
  }
  if (q < 5 && vp > 35 && cv < 20) {
    return { condicion: "NORMAL", tiempo_verde: 15 };
  }
  return { condicion: "MODERADO", tiempo_verde: 20 };
}

// ─── RÉPLICA LOCAL ────────────────────────────────────────────────────────────

/** Lee la réplica local o devuelve un arreglo vacío si no existe */
function leerReplica() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.REPLICA_FILE, "utf8"));
  } catch {
    return [];
  }
}

/** Agrega un evento al archivo de réplica local (append) */
function guardarEnReplica(evento) {
  const datos = leerReplica();
  datos.push({ ...evento, replica_timestamp: new Date().toISOString() });
  fs.writeFileSync(CONFIG.REPLICA_FILE, JSON.stringify(datos, null, 2));
}

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const sub     = new Subscriber();
const pushSem = new Push();       // → control_semaforos.js
const pushBD  = new Push();       // → PC3 BD principal
const rep     = new Reply();      // ← PC3 monitoreo (comandos directos)

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

// ─── PROCESAMIENTO DE EVENTOS DE SENSORES ────────────────────────────────────

/**
 * Actualiza el estado acumulado de una intersección con los datos del evento
 * y evalúa las reglas de tráfico. Si hay una condición relevante, envía un
 * comando al servicio de control de semáforos.
 */
async function procesarEvento(topic, raw) {
  let evento;
  try {
    evento = JSON.parse(raw);
  } catch {
    console.error(`[Analítica] JSON inválido en tópico ${topic}: ${raw}`);
    return;
  }

  const interseccion = evento.interseccion ?? evento.sensor_id?.replace(/^GPS-/, "INT-");

  // Inicializar estado si es la primera vez que vemos esta intersección
  if (!intersectionState[interseccion]) {
    intersectionState[interseccion] = {};
  }

  // Actualizar estado según tipo de sensor
  if (topic === "camara") {
    intersectionState[interseccion].Q  = evento.volumen;
    intersectionState[interseccion].Vp = evento.velocidad_promedio;
  } else if (topic === "espira_inductiva") {
    intersectionState[interseccion].Cv = evento.vehiculos_contados;
  } else if (topic === "gps") {
    intersectionState[interseccion].Vp       = evento.velocidad_promedio;
    intersectionState[interseccion].nivel_gps = evento.nivel_congestion;
  }

  console.log(`[Analítica] Evento recibido [${topic}] en ${interseccion}`);

  // Evaluar reglas
  const resultado = evaluarTrafico(interseccion);
  if (resultado) {
    console.log(`[Analítica] ${interseccion} → ${resultado.condicion} (verde ${resultado.tiempo_verde}s)`);

    // Enviar comando al control de semáforos
    const comando = {
      tipo: "CAMBIO_SEMAFORO",
      interseccion,
      condicion: resultado.condicion,
      tiempo_verde: resultado.tiempo_verde,
      timestamp: new Date().toISOString(),
    };
    await pushSem.send(JSON.stringify(comando));
    console.log(`[Analítica] Comando enviado a control_semaforos: ${JSON.stringify(comando)}`);
  }

  // Persistir en réplica local y enviar a BD principal
  const registro = { topic, evento, timestamp: new Date().toISOString() };
  guardarEnReplica(registro);
  await pushBD.send(JSON.stringify(registro));
}

// ─── LOOP PRINCIPAL: EVENTOS DE SENSORES ─────────────────────────────────────
(async () => {
  for await (const [topicBuf, dataBuf] of sub) {
    const topic = topicBuf.toString();
    const data  = dataBuf.toString();
    await procesarEvento(topic, data);
  }
})();

// ─── LOOP SECUNDARIO: COMANDOS DIRECTOS DE PC3 ───────────────────────────────
/**
 * Comandos soportados desde PC3 (JSON):
 *
 * 1. Forzar cambio de semáforo (ej. ambulancia):
 *    { "tipo": "FORZAR_VERDE", "interseccion": "INT-C5", "duracion": 60 }
 *
 * 2. Consultar estado de una intersección:
 *    { "tipo": "CONSULTA_ESTADO", "interseccion": "INT-C5" }
 *
 * 3. Consultar todos los estados:
 *    { "tipo": "CONSULTA_TODOS" }
 */
(async () => {
  for await (const [msgBuf] of rep) {
    let comando;
    try {
      comando = JSON.parse(msgBuf.toString());
    } catch {
      await rep.send(JSON.stringify({ error: "JSON inválido" }));
      continue;
    }

    console.log(`\n[Analítica] Comando directo de PC3: ${JSON.stringify(comando)}`);

    if (comando.tipo === "FORZAR_VERDE") {
      const { interseccion, duracion } = comando;
      const cmd = {
        tipo: "CAMBIO_SEMAFORO",
        interseccion,
        condicion: "PRIORIDAD",
        tiempo_verde: duracion ?? 60,
        timestamp: new Date().toISOString(),
        origen: "USUARIO",
      };
      await pushSem.send(JSON.stringify(cmd));
      console.log(`[Analítica] Prioridad aplicada en ${interseccion} por ${duracion ?? 60}s`);
      await rep.send(JSON.stringify({ ok: true, mensaje: `Verde forzado en ${interseccion}`, comando: cmd }));

    } else if (comando.tipo === "CONSULTA_ESTADO") {
      const estado = intersectionState[comando.interseccion] ?? null;
      const regla  = evaluarTrafico(comando.interseccion);
      await rep.send(JSON.stringify({ interseccion: comando.interseccion, estado, regla }));

    } else if (comando.tipo === "CONSULTA_TODOS") {
      const todos = Object.entries(intersectionState).map(([interseccion, estado]) => ({
        interseccion,
        estado,
        regla: evaluarTrafico(interseccion),
      }));
      await rep.send(JSON.stringify({ intersecciones: todos }));

    } else {
      await rep.send(JSON.stringify({ error: `Comando desconocido: ${comando.tipo}` }));
    }
  }
})();

console.log("[Analítica] Servicio iniciado y escuchando...\n");