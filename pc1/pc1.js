/**
 * PC1 - Sensors API + ZeroMQ Broker
 *
 * Exposes a REST API to receive sensor events (simulate via Postman, etc.)
 * and publishes them directly to PC2 via ZeroMQ PUB socket.
 *
 * Endpoints:
 *  - POST /sensor/camara         → topic: camara
 *  - POST /sensor/espira         → topic: espira_inductiva
 *  - POST /sensor/gps            → topic: gps
 *  - GET  /health
 *
 * Run: node pc1.js
 */

import express from "express";
import { Publisher } from "zeromq";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  API_PORT: 3000,

  // PC2 connects its SUB socket to this address
  // Change 0.0.0.0 to this machine's actual IP when running on separate PCs
  ZMQ_PUB_ADDRESS: "tcp://127.0.0.1:5555",
};

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const pub = new Publisher();
await pub.bind(CONFIG.ZMQ_PUB_ADDRESS);
console.log(`[ZMQ] Publicando en ${CONFIG.ZMQ_PUB_ADDRESS}`);
console.log(`[ZMQ] PC2 debe conectarse a tcp://<IP_DE_PC1>:5555\n`);

// ─── VALIDATION HELPERS ───────────────────────────────────────────────────────

/**
 * Validates a camera sensor event (EVENTO_LONGITUD_COLA)
 * Required fields: sensor_id, tipo_sensor, interseccion, volumen, velocidad_promedio, timestamp
 */
function validateCamara(body) {
  const required = ["sensor_id", "tipo_sensor", "interseccion", "volumen", "velocidad_promedio", "timestamp"];
  for (const field of required) {
    if (body[field] === undefined) return `Falta campo: ${field}`;
  }
  if (body.tipo_sensor !== "camara") return "tipo_sensor debe ser 'camara'";
  if (body.volumen < 0) return "volumen no puede ser negativo";
  if (body.velocidad_promedio < 0 || body.velocidad_promedio > 50)
    return "velocidad_promedio debe estar entre 0 y 50 km/h";
  return null;
}

/**
 * Validates an inductive loop sensor event (EVENTO_CONTEO_VEHICULAR)
 * Required fields: sensor_id, tipo_sensor, interseccion, vehiculos_contados,
 *                  intervalo_segundos, timestamp_inicio, timestamp_fin
 */
function validateEspira(body) {
  const required = [
    "sensor_id", "tipo_sensor", "interseccion",
    "vehiculos_contados", "intervalo_segundos",
    "timestamp_inicio", "timestamp_fin",
  ];
  for (const field of required) {
    if (body[field] === undefined) return `Falta campo: ${field}`;
  }
  if (body.tipo_sensor !== "espira_inductiva") return "tipo_sensor debe ser 'espira_inductiva'";
  if (body.vehiculos_contados < 0) return "vehiculos_contados no puede ser negativo";
  if (body.intervalo_segundos !== 30) return "intervalo_segundos debe ser 30";
  return null;
}

/**
 * Validates a GPS sensor event (EVENTO_DENSIDAD_DE_TRAFICO)
 * Required fields: sensor_id, nivel_congestion, velocidad_promedio, timestamp
 * nivel_congestion rules: ALTA (<10 km/h), NORMAL (11-39 km/h), BAJA (>40 km/h)
 */
function validateGPS(body) {
  const required = ["sensor_id", "nivel_congestion", "velocidad_promedio", "timestamp"];
  for (const field of required) {
    if (body[field] === undefined) return `Falta campo: ${field}`;
  }
  const validLevels = ["ALTA", "NORMAL", "BAJA"];
  if (!validLevels.includes(body.nivel_congestion))
    return "nivel_congestion debe ser ALTA, NORMAL o BAJA";

  // Cross-validate nivel_congestion vs velocidad_promedio
  const vp = body.velocidad_promedio;
  if (body.nivel_congestion === "ALTA" && vp >= 10)
    return "ALTA congestion requiere velocidad_promedio < 10";
  if (body.nivel_congestion === "NORMAL" && (vp < 11 || vp > 39))
    return "NORMAL congestion requiere velocidad_promedio entre 11 y 39";
  if (body.nivel_congestion === "BAJA" && vp <= 40)
    return "BAJA congestion requiere velocidad_promedio > 40";

  return null;
}

// ─── EXPRESS API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

/**
 * POST /sensor/camara
 * Body example:
 * {
 *   "sensor_id": "CAM-C5",
 *   "tipo_sensor": "camara",
 *   "interseccion": "INT-C5",
 *   "volumen": 10,
 *   "velocidad_promedio": 25,
 *   "timestamp": "2026-02-09T15:10:00Z"
 * }
 */
app.post("/sensor/camara", async (req, res) => {
  const error = validateCamara(req.body);
  if (error) return res.status(400).json({ error });

  const payload = JSON.stringify(req.body);
  await pub.send(["camara", payload]);

  console.log(`[camara] Publicado → ${payload}`);
  res.status(200).json({ message: "Evento publicado", topic: "camara", data: req.body });
});

/**
 * POST /sensor/espira
 * Body example:
 * {
 *   "sensor_id": "ESP-C5",
 *   "tipo_sensor": "espira_inductiva",
 *   "interseccion": "INT-C5",
 *   "vehiculos_contados": 12,
 *   "intervalo_segundos": 30,
 *   "timestamp_inicio": "2026-02-09T15:20:00Z",
 *   "timestamp_fin": "2026-02-09T15:20:30Z"
 * }
 */
app.post("/sensor/espira", async (req, res) => {
  const error = validateEspira(req.body);
  if (error) return res.status(400).json({ error });

  const payload = JSON.stringify(req.body);
  await pub.send(["espira_inductiva", payload]);

  console.log(`[espira_inductiva] Publicado → ${payload}`);
  res.status(200).json({ message: "Evento publicado", topic: "espira_inductiva", data: req.body });
});

/**
 * POST /sensor/gps
 * Body example:
 * {
 *   "sensor_id": "GPS-C5",
 *   "nivel_congestion": "ALTA",
 *   "velocidad_promedio": 8,
 *   "timestamp": "2026-02-09T15:20:10Z"
 * }
 */
app.post("/sensor/gps", async (req, res) => {
  const error = validateGPS(req.body);
  if (error) return res.status(400).json({ error });

  const payload = JSON.stringify(req.body);
  await pub.send(["gps", payload]);

  console.log(`[gps] Publicado → ${payload}`);
  res.status(200).json({ message: "Evento publicado", topic: "gps", data: req.body });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", pc: "PC1", zmq: CONFIG.ZMQ_PUB_ADDRESS, timestamp: new Date().toISOString() });
});

app.listen(CONFIG.API_PORT, () => {
  console.log(`[API] Escuchando en http://localhost:${CONFIG.API_PORT}`);
  console.log("─────────────────────────────────────────");
  console.log(`  POST /sensor/camara`);
  console.log(`  POST /sensor/espira`);
  console.log(`  POST /sensor/gps`);
  console.log(`  GET  /health`);
  console.log("─────────────────────────────────────────\n");
});