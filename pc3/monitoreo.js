/**
 * PC3 - Servicio de Monitoreo y Consulta
 *
 * Responsabilidades:
 *  - Servir dashboard web con estado de la matriz de semáforos
 *  - Consultar estado actual de intersecciones a analítica (ZMQ REQ)
 *  - Enviar comandos directos a analítica (ambulancia, etc.) (ZMQ REQ)
 *  - Consultas históricas desde bd_principal.json
 *
 * Endpoints REST:
 *  GET  /                              → Dashboard web
 *  GET  /api/estado                    → Estado actual de todos los semáforos
 *  GET  /api/estado/:interseccion      → Estado de una intersección específica
 *  GET  /api/historico?desde=&hasta=   → Eventos entre dos timestamps
 *  POST /api/ambulancia                → Forzar verde { interseccion, duracion }
 *
 * Run: node monitoreo.js
 */

import express from "express";
import { Request } from "zeromq";
import fs from "fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Puerto del servidor web/REST
  // ✅ No cambiar salvo conflicto de puertos
  API_PORT: 3001,

  // [PC3 → PC2] Enviamos REQ a analítica y esperamos REP
  // ⚠️ En red: cambiar IP por la IP real de PC2
  // ✅ En localhost: no cambiar
  PC2_ANALITICA_ADDRESS: "tcp://127.0.0.1:5565",

  // Archivo de BD principal (mismo directorio que bd_principal.js)
  // ✅ No cambiar salvo que cambiaste la ruta en bd_principal.js
  BD_FILE: "./bd_principal.json",

  // Timeout para peticiones ZMQ a analítica (ms)
  ZMQ_TIMEOUT_MS: 3000,
};

// ─── ZEROMQ SETUP ─────────────────────────────────────────────────────────────
const zmqReq = new Request();
zmqReq.connect(CONFIG.PC2_ANALITICA_ADDRESS);
console.log(`[ZMQ REQ] Conectado a analítica PC2 en ${CONFIG.PC2_ANALITICA_ADDRESS}`);

/**
 * Envía un comando a analítica y espera respuesta con timeout.
 */
async function enviarComando(comando) {
  await zmqReq.send(JSON.stringify(comando));
  return Promise.race([
    (async () => {
      const [buf] = await zmqReq.receive();
      return JSON.parse(buf.toString());
    })(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout: PC2 no responde")), CONFIG.ZMQ_TIMEOUT_MS)
    ),
  ]);
}

// ─── HELPERS BD ───────────────────────────────────────────────────────────────
function leerBD() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.BD_FILE, "utf8"));
  } catch {
    return { eventos: [] };
  }
}

// ─── EXPRESS API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

/**
 * GET /api/estado
 * Devuelve el estado de TODAS las intersecciones de la matriz.
 * Respuesta: { intersecciones: [ { interseccion, sensores, semaforo, regla } ] }
 */
app.get("/api/estado", async (_req, res) => {
  console.log("[Monitoreo] Consulta: estado de todos los semáforos");
  try {
    const respuesta = await enviarComando({ tipo: "CONSULTA_TODOS" });
    res.json(respuesta);
  } catch (err) {
    console.error(`[Monitoreo] Error consultando PC2: ${err.message}`);
    res.status(503).json({ error: err.message });
  }
});

/**
 * GET /api/estado/:interseccion
 * Devuelve el estado de una intersección específica.
 * Respuesta: { interseccion, sensores, semaforo, regla }
 */
app.get("/api/estado/:interseccion", async (req, res) => {
  const { interseccion } = req.params;
  console.log(`[Monitoreo] Consulta puntual: ${interseccion}`);
  try {
    const respuesta = await enviarComando({ tipo: "CONSULTA_ESTADO", interseccion });
    res.json(respuesta);
  } catch (err) {
    console.error(`[Monitoreo] Error consultando PC2: ${err.message}`);
    res.status(503).json({ error: err.message });
  }
});

/**
 * GET /api/historico?desde=&hasta=&interseccion=
 * Consulta eventos históricos filtrando por rango de tiempo e intersección.
 */
app.get("/api/historico", (req, res) => {
  const { desde, hasta, interseccion } = req.query;
  console.log(`[Monitoreo] Histórico: desde=${desde ?? "*"} hasta=${hasta ?? "*"} interseccion=${interseccion ?? "todas"}`);

  const bd = leerBD();
  let eventos = bd.eventos ?? [];

  if (desde)        eventos = eventos.filter(e => new Date(e.timestamp) >= new Date(desde));
  if (hasta)        eventos = eventos.filter(e => new Date(e.timestamp) <= new Date(hasta));
  if (interseccion) eventos = eventos.filter(e => e.evento?.interseccion === interseccion);

  console.log(`[Monitoreo] Histórico: ${eventos.length} eventos encontrados`);
  res.json({ total: eventos.length, eventos });
});

/**
 * POST /api/ambulancia
 * Fuerza verde en una intersección para paso de ambulancia.
 * Body: { "interseccion": "INT-C5", "duracion": 60 }
 */
app.post("/api/ambulancia", async (req, res) => {
  const { interseccion, duracion } = req.body;
  if (!interseccion) return res.status(400).json({ error: "Falta campo: interseccion" });

  console.log(`[Monitoreo] 🚑 AMBULANCIA → verde forzado en ${interseccion} por ${duracion ?? 60}s`);
  try {
    const respuesta = await enviarComando({ tipo: "FORZAR_VERDE", interseccion, duracion: duracion ?? 60 });
    res.json(respuesta);
  } catch (err) {
    console.error(`[Monitoreo] Error enviando comando a PC2: ${err.message}`);
    res.status(503).json({ error: err.message });
  }
});

// ─── DASHBOARD WEB ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send(DASHBOARD_HTML));

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Control de Tráfico Urbano</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@400;600;700&display=swap');

    :root {
      --bg:        #0a0c0f;
      --panel:     #111418;
      --border:    #1e2530;
      --green:     #00ff88;
      --red:       #ff3355;
      --amber:     #ffaa00;
      --blue:      #0088ff;
      --text:      #c8d0db;
      --muted:     #4a5568;
      --font-mono: 'Share Tech Mono', monospace;
      --font-ui:   'Barlow', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-ui);
      min-height: 100vh;
      padding: 24px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 28px;
    }
    header h1 {
      font-family: var(--font-mono);
      font-size: 1.1rem;
      color: var(--green);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    #status-pill {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 4px 12px;
      border-radius: 2px;
      border: 1px solid var(--muted);
      color: var(--muted);
      transition: all 0.3s;
    }
    #status-pill.online  { border-color: var(--green); color: var(--green); }
    #status-pill.offline { border-color: var(--red);   color: var(--red);   }

    .grid {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 20px;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 20px;
    }
    .panel-title {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: var(--amber);
      letter-spacing: 0.15em;
      text-transform: uppercase;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    /* ── MATRIZ ── */
    #matriz { display: flex; flex-direction: column; gap: 10px; }
    .matrix-row { display: flex; gap: 10px; flex-wrap: wrap; }

    .semaforo {
      width: 90px;
      height: 86px;
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: border-color 0.3s;
    }
    .semaforo:hover { border-color: var(--amber); }

    .semaforo .id {
      font-family: var(--font-mono);
      font-size: 0.62rem;
      color: var(--muted);
    }
    .semaforo .luz {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      transition: background 0.4s, box-shadow 0.4s;
      /* Estado por defecto: ROJO */
      background: var(--red);
      box-shadow: 0 0 10px var(--red);
    }
    /* Clase .verde aplicada cuando semaforo === "VERDE" */
    .semaforo.verde .luz {
      background: var(--green);
      box-shadow: 0 0 14px var(--green);
    }
    .semaforo .modo {
      font-family: var(--font-mono);
      font-size: 0.52rem;
      color: var(--muted);
      text-transform: uppercase;
    }
    .semaforo.prioridad            { border-color: var(--amber); }
    .semaforo.prioridad .modo      { color: var(--amber); }
    .semaforo.congestion .modo     { color: var(--red); }
    .semaforo.sin-datos .luz       { background: var(--muted); box-shadow: none; }
    .semaforo.sin-datos .modo      { color: var(--muted); }

    #refresh-info {
      font-family: var(--font-mono);
      font-size: 0.62rem;
      color: var(--muted);
      text-align: right;
      margin-top: 10px;
    }

    /* ── CONTROLES ── */
    .right-col { display: flex; flex-direction: column; gap: 16px; }

    label {
      display: block;
      font-size: 0.75rem;
      color: var(--muted);
      margin-bottom: 4px;
      font-family: var(--font-mono);
    }
    input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 7px 10px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      outline: none;
      margin-bottom: 10px;
    }
    input:focus { border-color: var(--amber); }

    button {
      width: 100%;
      padding: 9px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.82; }
    .btn-ambulancia { background: var(--amber); color: #000; font-weight: 700; }
    .btn-consulta   { background: var(--blue);  color: #fff; }

    #log {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      line-height: 1.7;
      max-height: 180px;
      overflow-y: auto;
    }
    .log-entry { padding: 2px 0; border-bottom: 1px solid var(--border); }
    .log-ts    { color: var(--muted); margin-right: 6px; }
    .log-ok    { color: var(--green); }
    .log-err   { color: var(--red);   }
    .log-warn  { color: var(--amber); }

    #historico-resultado {
      font-family: var(--font-mono);
      font-size: 0.68rem;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.6;
    }
    .hist-entry  { padding: 4px 0; border-bottom: 1px solid var(--border); }
    .hist-topic  { color: var(--blue); }

    #consulta-resultado {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      margin-top: 8px;
      line-height: 1.7;
    }
  </style>
</head>
<body>

<header>
  <h1>▶ Centro de Control · Tráfico Urbano</h1>
  <div id="status-pill">● CONECTANDO</div>
</header>

<div class="grid">

  <!-- MATRIZ -->
  <div>
    <div class="panel">
      <div class="panel-title">// Matriz de Semáforos</div>
      <div id="matriz">Cargando...</div>
      <div id="refresh-info">Actualiza cada 2s</div>
    </div>
  </div>

  <!-- PANEL DERECHO -->
  <div class="right-col">

    <div class="panel">
      <div class="panel-title">🚑 Prioridad / Ambulancia</div>
      <label>Intersección</label>
      <input id="amb-interseccion" type="text" placeholder="INT-C5"/>
      <label>Duración verde (seg)</label>
      <input id="amb-duracion" type="number" value="60" min="10"/>
      <button class="btn-ambulancia" onclick="forzarVerde()">FORZAR VERDE</button>
    </div>

    <div class="panel">
      <div class="panel-title">// Consulta Puntual</div>
      <label>Intersección</label>
      <input id="cons-interseccion" type="text" placeholder="INT-C5"/>
      <button class="btn-consulta" onclick="consultarInterseccion()">CONSULTAR</button>
      <div id="consulta-resultado"></div>
    </div>

    <div class="panel">
      <div class="panel-title">// Consulta Histórica</div>
      <label>Desde</label>
      <input id="hist-desde" type="datetime-local"/>
      <label>Hasta</label>
      <input id="hist-hasta" type="datetime-local"/>
      <label>Intersección (opcional)</label>
      <input id="hist-interseccion" type="text" placeholder="INT-C5 o vacío"/>
      <button class="btn-consulta" onclick="consultarHistorico()">BUSCAR</button>
      <div id="historico-resultado"></div>
    </div>

    <div class="panel">
      <div class="panel-title">// Log de Operaciones</div>
      <div id="log"></div>
    </div>

  </div>
</div>

<script>
  // ── LOG ──────────────────────────────────────────────────────────────────────
  function logMsg(msg, tipo = "ok") {
    const log = document.getElementById("log");
    const ts  = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.className = "log-entry";
    div.innerHTML = \`<span class="log-ts">\${ts}</span><span class="log-\${tipo}">\${msg}</span>\`;
    log.prepend(div);
    while (log.children.length > 50) log.removeChild(log.lastChild);
  }

  // ── RENDER MATRIZ ────────────────────────────────────────────────────────────
  function renderMatriz(intersecciones) {
    // Agrupar por fila (letra)
    const filas = {};
    for (const item of intersecciones) {
      const match = item.interseccion.match(/INT-([A-Z]+)(\\d+)/);
      if (!match) continue;
      const [, fila, col] = match;
      if (!filas[fila]) filas[fila] = [];
      filas[fila].push({ ...item, _col: parseInt(col) });
    }

    const contenedor = document.getElementById("matriz");
    contenedor.innerHTML = "";

    for (const fila of Object.keys(filas).sort()) {
      const rowDiv = document.createElement("div");
      rowDiv.className = "matrix-row";

      for (const item of filas[fila].sort((a, b) => a._col - b._col)) {
        const esVerde   = item.semaforo === "VERDE";
        
        // Usar el ciclo actual si la regla del sensor aún es null
        const condicion = item.ciclo?.condicion ?? item.regla?.condicion ?? "NORMAL";
        const sinDatos  = item.regla === null; 

        let clases = "semaforo";
        if (esVerde) clases += " verde";
        
        // Ya no aplicamos la clase 'sin-datos' que apaga la luz
        if (condicion === "PRIORIDAD") clases += " prioridad";
        else if (condicion === "CONGESTION") clases += " congestion";

        const modoLabel = sinDatos ? "ESPERANDO SENSOR" : condicion.toLowerCase();
        const tiempoVerde = item.ciclo?.tiempoVerde ?? item.regla?.tiempo_verde ?? "—";
        const tooltip   = \`\${item.interseccion} | \${item.semaforo} | \${modoLabel} | verde: \${tiempoVerde}s\`;

        const cell = document.createElement("div");
        cell.className = clases;
        cell.title     = tooltip;
        cell.innerHTML = \`
          <div class="id">\${item.interseccion}</div>
          <div class="luz"></div>
          <div class="modo">\${modoLabel}</div>
        \`;
        rowDiv.appendChild(cell);
      }
      contenedor.appendChild(rowDiv);
    }
  }

  // ── POLLING ──────────────────────────────────────────────────────────────────
  async function actualizarEstado() {
    try {
      const res  = await fetch("/api/estado");
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      const data = await res.json();
      renderMatriz(data.intersecciones ?? []);
      document.getElementById("status-pill").textContent = "● EN LÍNEA";
      document.getElementById("status-pill").className   = "online";
    } catch (err) {
      document.getElementById("status-pill").textContent = "● PC2 FUERA DE LÍNEA";
      document.getElementById("status-pill").className   = "offline";
    }
  }

  setInterval(actualizarEstado, 2000);
  actualizarEstado();

  // ── FORZAR VERDE ─────────────────────────────────────────────────────────────
  async function forzarVerde() {
    const interseccion = document.getElementById("amb-interseccion").value.trim();
    const duracion     = parseInt(document.getElementById("amb-duracion").value) || 60;
    if (!interseccion) { logMsg("Falta intersección", "err"); return; }

    logMsg(\`🚑 Forzando verde en \${interseccion} por \${duracion}s...\`, "warn");
    try {
      const res  = await fetch("/api/ambulancia", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ interseccion, duracion }),
      });
      const data = await res.json();
      if (data.ok) logMsg(\`✓ Verde aplicado en \${interseccion}\`, "ok");
      else         logMsg(\`Error: \${data.error ?? JSON.stringify(data)}\`, "err");
    } catch (err) {
      logMsg(\`Error de red: \${err.message}\`, "err");
    }
  }

  // ── CONSULTA PUNTUAL ─────────────────────────────────────────────────────────
  async function consultarInterseccion() {
    const interseccion = document.getElementById("cons-interseccion").value.trim();
    if (!interseccion) { logMsg("Falta intersección", "err"); return; }

    logMsg(\`Consultando \${interseccion}...\`, "ok");
    try {
      const res  = await fetch(\`/api/estado/\${encodeURIComponent(interseccion)}\`);
      const data = await res.json();
      const div  = document.getElementById("consulta-resultado");

      if (data.error) {
        div.textContent = "Error: " + data.error;
      } else {
        const s = data.sensores ?? {};
        const condicion = data.ciclo?.condicion ?? data.regla?.condicion ?? "NORMAL";
        const tVerde = data.ciclo?.tiempoVerde ?? data.regla?.tiempo_verde ?? "—";
        const tagDatos = data.regla === null ? "<span style='color:var(--muted)'>(esperando sensor)</span>" : "";

        div.innerHTML = \`
          <b>\${data.interseccion}</b><br>
          Luz: <span style="color:\${data.semaforo==='VERDE'?'var(--green)':'var(--red)'}">\${data.semaforo}</span><br>
          Condición: \${condicion} \${tagDatos}<br>
          Verde: \${tVerde}s<br>
          Q: \${s.Q ?? "—"} &nbsp;|&nbsp; Vp: \${s.Vp ?? "—"} &nbsp;|&nbsp; Cv: \${s.Cv ?? "—"}
        \`;
      }
    } catch (err) {
      logMsg(\`Error: \${err.message}\`, "err");
    }
  }

  // ── CONSULTA HISTÓRICA ───────────────────────────────────────────────────────
  async function consultarHistorico() {
    const desde        = document.getElementById("hist-desde").value;
    const hasta        = document.getElementById("hist-hasta").value;
    const interseccion = document.getElementById("hist-interseccion").value.trim();

    const params = new URLSearchParams();
    if (desde)        params.set("desde", new Date(desde).toISOString());
    if (hasta)        params.set("hasta", new Date(hasta).toISOString());
    if (interseccion) params.set("interseccion", interseccion);

    logMsg(\`Histórico: \${desde || "*"} → \${hasta || "*"}\`, "ok");
    try {
      const res  = await fetch(\`/api/historico?\${params}\`);
      const data = await res.json();
      const div  = document.getElementById("historico-resultado");

      if (!data.eventos?.length) {
        div.innerHTML = "<span style='color:var(--muted)'>Sin eventos en ese rango.</span>";
        return;
      }

      div.innerHTML = \`<b>\${data.total} evento(s)</b><br>\` +
        data.eventos.slice(-30).reverse().map(e => \`
          <div class="hist-entry">
            <span class="hist-topic">[\${e.topic}]</span>
            \${e.evento?.interseccion ?? "—"} — \${new Date(e.timestamp).toLocaleTimeString()}
          </div>
        \`).join("");
    } catch (err) {
      logMsg(\`Error histórico: \${err.message}\`, "err");
    }
  }
</script>
</body>
</html>`;

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.API_PORT, () => {
  console.log(`[Monitoreo] Dashboard en http://localhost:${CONFIG.API_PORT}`);
  console.log("─────────────────────────────────────────");
  console.log(`  GET  /                   → Dashboard`);
  console.log(`  GET  /api/estado         → Todos los semáforos`);
  console.log(`  GET  /api/estado/:id     → Intersección específica`);
  console.log(`  GET  /api/historico      → Histórico filtrado`);
  console.log(`  POST /api/ambulancia     → Forzar verde`);
  console.log("─────────────────────────────────────────\n");
});