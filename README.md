#   Entrega 1 Proyecto Distribuidos

## Autores 

José D.Medina; Luis Santos; Santiago Hernandez; Paula Losada

# 🚦 Sistema de Control de Tráfico Urbano Distribuido

Sistema distribuido de gestión semafórica en tiempo real, compuesto por tres nodos (PC1, PC2, PC3) que se comunican mediante **ZeroMQ** y exponen APIs REST con **Express**.

---

## Arquitectura general

```
[Sensores / Postman]
        │
        ▼ HTTP REST
┌──────────────────┐        ZMQ PUB/SUB        ┌──────────────────────────────────┐
│      PC1         │ ─────────────────────────► │              PC2                 │
│  API de Sensores │  tcp://PC1_IP:5555         │  analitica.js + control_sem.js   │
│  puerto 3000     │                            │                                  │
└──────────────────┘                            │  ┌─────────────────────────────┐ │
                                                │  │  analitica.js               │ │
                                                │  │  · Evalúa reglas tráfico    │ │
                                                │  │  · Gestiona ciclos VERDE/   │ │
                                                │  │    ROJO por intersección    │ │
                                                │  │  · Replica eventos local    │ │
                                                │  └────────────┬────────────────┘ │
                                                │               │ ZMQ PUSH (5560)  │
                                                │  ┌────────────▼────────────────┐ │
                                                │  │  control_semaforos.js       │ │
                                                │  │  · Aplica estados ROJO/     │ │
                                                │  │    VERDE en la matriz       │ │
                                                │  │  · Persiste replica_sem.json│ │
                                                │  └─────────────────────────────┘ │
                                                └───────────────┬──────────────────┘
                                                                │ ZMQ PUSH (5570)
                                                                │ ZMQ REQ/REP (5565)
                                                                ▼
                                                ┌──────────────────────────────────┐
                                                │              PC3                 │
                                                │  bd_principal.js + monitoreo.js  │
                                                │  · BD centralizada de eventos    │
                                                │  · Dashboard web puerto 3001     │
                                                └──────────────────────────────────┘
```

### Matriz de intersecciones

El sistema gestiona una grilla **3 × 5** de intersecciones:

|   | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| **A** | INT-A1 | INT-A2 | INT-A3 | INT-A4 | INT-A5 |
| **B** | INT-B1 | INT-B2 | INT-B3 | INT-B4 | INT-B5 |
| **C** | INT-C1 | INT-C2 | INT-C3 | INT-C4 | INT-C5 |

---

## Tecnologías

- **Node.js** ≥ 18 con módulos ES (`"type": "module"`)
- **Express 5** — APIs REST
- **ZeroMQ 6** — mensajería entre nodos (PUB/SUB, PUSH/PULL, REQ/REP)

---

## Estructura del proyecto

```
distribuidos_proyecto/
├── package.json
├── pc1/
│   └── pc1.js                  # API REST de sensores + publicador ZMQ
├── pc2/
│   ├── analitica.js            # Motor de reglas + gestor de ciclos semafóricos
│   ├── control_semaforos.js    # Receptor de comandos y aplicador de estados
│   ├── replica_eventos.json    # BD réplica de eventos (generada en runtime)
│   └── replica_semaforos.json  # BD réplica de semáforos (generada en runtime)
└── pc3/
    ├── bd_principal.js         # Persistencia central de eventos
    ├── bd_principal.json       # BD JSON de eventos (generada en runtime)
    └── monitoreo.js            # Dashboard web + API de consulta/control
```

---

## Instalación

```bash
git clone https://github.com/advSNTS/distribuidos_proyecto.git
cd distribuidos_proyecto
npm install
```

> **Nota:** `zeromq` compila binarios nativos. Asegúrate de tener **CMake** y las herramientas de compilación de tu sistema operativo instaladas (`build-essential` en Linux, Xcode CLI en macOS, Build Tools en Windows).

---

## Ejecución

Cada servicio corre en su propio proceso (y opcionalmente en su propia máquina). Inícialo en el siguiente orden:

### 1. PC3 — Base de datos y monitoreo

```bash
# Terminal 1: BD principal
node pc3/bd_principal.js

# Terminal 2: Dashboard web
node pc3/monitoreo.js
```

### 2. PC2 — Analítica y control de semáforos

```bash
# Terminal 3: Control de semáforos
node pc2/control_semaforos.js

# Terminal 4: Motor de analítica
node pc2/analitica.js
```

### 3. PC1 — API de sensores

```bash
# Terminal 5: API REST
node pc1/pc1.js
```

---

## Configuración de red

Por defecto todos los servicios apuntan a `127.0.0.1` (localhost). Para despliegue en máquinas separadas, edita las siguientes variables en cada archivo:

| Archivo | Variable | Descripción |
|---|---|---|
| `pc1/pc1.js` | `ZMQ_PUB_ADDRESS` | IP de PC1 donde PC2 se conectará |
| `pc2/analitica.js` | `PC1_PUB_ADDRESS` | IP real de PC1 |
| `pc2/analitica.js` | `PC3_BD_ADDRESS` | IP real de PC3 |
| `pc3/monitoreo.js` | `PC2_ANALITICA_ADDRESS` | IP real de PC2 |

Las direcciones que usan `0.0.0.0` escuchan en todas las interfaces y **no deben cambiarse**.

---

## Puertos ZeroMQ

| Puerto | Patrón | Descripción |
|---|---|---|
| `5555` | PUB/SUB | PC1 publica eventos de sensores → PC2 |
| `5560` | PUSH/PULL | `analitica.js` → `control_semaforos.js` (interno PC2) |
| `5565` | REQ/REP | PC3 envía comandos → PC2 (ambulancias, consultas) |
| `5570` | PUSH/PULL | PC2 reenvía eventos → PC3 BD principal |

---

## API de sensores — PC1 (puerto 3000)

### `POST /sensor/camara`

Evento de longitud de cola (cámara de video).

```json
{
  "sensor_id": "CAM-C5",
  "tipo_sensor": "camara",
  "interseccion": "INT-C5",
  "volumen": 10,
  "velocidad_promedio": 25,
  "timestamp": "2026-02-09T15:10:00Z"
}
```

Restricciones: `volumen ≥ 0`, `velocidad_promedio` entre 0 y 50 km/h.

---

### `POST /sensor/espira`

Evento de conteo vehicular (espira inductiva).

```json
{
  "sensor_id": "ESP-C5",
  "tipo_sensor": "espira_inductiva",
  "interseccion": "INT-C5",
  "vehiculos_contados": 12,
  "intervalo_segundos": 30,
  "timestamp_inicio": "2026-02-09T15:20:00Z",
  "timestamp_fin": "2026-02-09T15:20:30Z"
}
```

Restricciones: `intervalo_segundos` debe ser exactamente `30`.

---

### `POST /sensor/gps`

Evento de densidad de tráfico (GPS flotante).

```json
{
  "sensor_id": "GPS-C5",
  "nivel_congestion": "ALTA",
  "velocidad_promedio": 8,
  "timestamp": "2026-02-09T15:20:10Z"
}
```

Reglas de `nivel_congestion`:

| Nivel | Velocidad promedio |
|---|---|
| `ALTA` | < 10 km/h |
| `NORMAL` | 11 – 39 km/h |
| `BAJA` | > 40 km/h |

---

### `GET /health`

```json
{ "status": "ok", "pc": "PC1", "zmq": "tcp://127.0.0.1:5555", "timestamp": "..." }
```

---

## Reglas de tráfico — PC2

`analitica.js` evalúa tres variables por intersección:

- **Q** — longitud de cola (cámara, `volumen`)
- **Vp** — velocidad promedio km/h (cámara o GPS)
- **Cv** — vehículos contados en 30 s (espira)

| Condición | Criterio | Verde |
|---|---|---|
| `CONGESTION` | Q ≥ 10 **ó** Vp ≤ 15 **ó** Cv ≥ 30 | 30 s |
| `NORMAL` | Q < 5 **y** Vp > 35 **y** Cv < 20 | 15 s |
| `MODERADO` | cualquier otro caso | 20 s |

El ciclo de cada intersección es completamente independiente y se reinicia automáticamente cuando la condición detectada cambia.

---

## API de monitoreo — PC3 (puerto 3001)

### `GET /`
Dashboard web con visualización en tiempo real de la matriz de semáforos (polling cada 2 s).

### `GET /api/estado`
Estado actual de todas las intersecciones.

### `GET /api/estado/:interseccion`
Estado de una intersección específica (sensores, semáforo, regla activa, ciclo).

### `GET /api/historico`
Consulta histórica de eventos con filtros opcionales:

```
GET /api/historico?desde=2026-04-05T16:00:00Z&hasta=2026-04-05T18:00:00Z&interseccion=INT-C5
```

### `POST /api/ambulancia`
Fuerza verde prioritario en una intersección (ej. paso de ambulancia):

```json
{ "interseccion": "INT-C5", "duracion": 60 }
```

Al terminar la duración, el ciclo retoma automáticamente la condición calculada por los sensores.

---

## Persistencia

| Archivo | Nodo | Contenido |
|---|---|---|
| `pc2/replica_eventos.json` | PC2 | Copia local de todos los eventos recibidos |
| `pc2/replica_semaforos.json` | PC2 | Estado actual de la matriz de semáforos |
| `pc3/bd_principal.json` | PC3 | BD centralizada con todos los eventos |

Los archivos de réplica en PC2 están excluidos del repositorio (`.gitignore`).

---

## Diagrama de flujo de un evento

```
POST /sensor/espira (PC1)
        │
        ▼ Validación
   pub.send(["espira_inductiva", payload])
        │
        ▼ ZMQ PUB → SUB (5555)
   analitica.js recibe evento
        │
        ├── Actualiza intersectionState[INT-C5].Cv = 35
        ├── Evalúa reglas → CONGESTION (Cv ≥ 30)
        ├── Condición cambió: NORMAL → CONGESTION
        │       └── reiniciarCiclo(INT-C5, CONGESTION, 30s)
        │               └── ejecutarCiclo() en background
        │                       ├── enviarEstado(VERDE) → ZMQ PUSH (5560)
        │                       │       └── control_semaforos.js aplica VERDE
        │                       ├── espera 30 s
        │                       ├── enviarEstado(ROJO)
        │                       └── espera 15 s → repite
        │
        ├── guardarEnReplica(registro) → replica_eventos.json
        └── pushBD.send(registro) → ZMQ PUSH (5570) → bd_principal.js
```
