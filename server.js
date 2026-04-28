/**
 * server.js — Puente vision.py → HMI web
 * ========================================
 * 1. Sirve index.html en localhost:3000
 * 2. Lanza vision.py como proceso hijo
 * 3. Escribe "SCAN\n" al stdin de Python cuando el browser lo pide
 * 4. Recibe eventos JSON por stdout de Python
 * 5. Sirve el video como MJPEG en GET /stream (sin base64, sin Socket.io)
 * 6. Calcula match (OK/ALERTA) aquí, no en Python
 *
 * Uso:
 *   node server.js
 *   node server.js --cam 1
 *   node server.js --web 8080
 *   node server.js --debug        (activa ventana OpenCV en Python)
 */

const express          = require("express");
const http             = require("http");
const { Server }       = require("socket.io");
const { spawn }        = require("child_process");
const path             = require("path");
const readline         = require("readline");
const { SerialPort }   = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

// ── Argumentos ──────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const hasFlag = (flag) => argv.includes(flag);

const CAM_IDX    = getArg("--cam", "0");
const PORT_WEB   = parseInt(getArg("--web", "3000"), 10);
const DEBUG_PY   = hasFlag("--debug");
const SERIAL_PORT = getArg("--serial", null);   // ej: --serial COM3
const SERIAL_BAUD = parseInt(getArg("--baud", "115200"), 10);

// ── Express + Socket.io ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── MJPEG stream en /stream ──────────────────────────────────────────────────
// Cada cliente que abre /stream queda suscrito a los frames en tiempo real.
// El browser decodifica MJPEG nativo: sin base64, sin JavaScript, sin lag.
const BOUNDARY   = "mjpegframe";
const FRAME_HEAD = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n`;

let latestFrame     = null;
let latestMaskFrame = null;
const streamClients     = new Set();
const maskStreamClients = new Set();

function makeMjpegRoute(clientSet, getLatest) {
  return (req, res) => {
    res.writeHead(200, {
      "Content-Type":      `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control":     "no-cache, no-store, must-revalidate",
      "Pragma":            "no-cache",
      "Connection":        "keep-alive",
      "Transfer-Encoding": "chunked",
    });
    clientSet.add(res);
    const latest = getLatest();
    if (latest) pushFrame(res, latest);
    req.on("close", () => clientSet.delete(res));
  };
}

app.get("/stream",      makeMjpegRoute(streamClients,     () => latestFrame));
app.get("/stream-mask", makeMjpegRoute(maskStreamClients, () => latestMaskFrame));

function pushFrame(res, jpegBuf) {
  try {
    res.write(`${FRAME_HEAD}Content-Length: ${jpegBuf.length}\r\n\r\n`);
    res.write(jpegBuf);
    res.write("\r\n");
  } catch {
    // Cliente desconectado — se limpia en el evento 'close'
  }
}

function broadcastFrame(jpegBuf) {
  latestFrame = jpegBuf;
  streamClients.forEach(res => pushFrame(res, jpegBuf));
}

function broadcastMaskFrame(jpegBuf) {
  latestMaskFrame = jpegBuf;
  maskStreamClients.forEach(res => pushFrame(res, jpegBuf));
}

// ── Estado global ────────────────────────────────────────────────────────────
const PATRONES = ["dots", "halfblue", "orange", "green"];

let estado = {
  conectado:    false,
  patronActivo: null,
  contadores:   { ok: 0, alerta: 0, total: 0 },
};

// ── Puerto Serial (ESP32) ────────────────────────────────────────────────────
function arrancarSerial() {
  if (!SERIAL_PORT) return;

  const sp = new SerialPort({ path: SERIAL_PORT, baudRate: SERIAL_BAUD });
  const parser = sp.pipe(new ReadlineParser({ delimiter: "\n" }));

  sp.on("open", () =>
    console.log(`[SERIAL] Conectado a ${SERIAL_PORT} @ ${SERIAL_BAUD} baud`)
  );

  parser.on("data", (line) => {
    const cmd = line.trim().toUpperCase();
    if (cmd === "SCAN") {
      if (pyProc?.stdin.writable) {
        pyProc.stdin.write("SCAN\n");
        console.log("[SERIAL] SCAN → Python");
        io.emit("vision", { evt: "serial_trigger" });
      }
    }
  });

  sp.on("error", (err) =>
    console.error(`[SERIAL] Error: ${err.message}`)
  );
}

// ── Proceso Python ───────────────────────────────────────────────────────────
let pyProc = null;

function arrancarVision() {
  const pyArgs = ["vision.py", "--cam", CAM_IDX, "--stream-fps", "20"];
  if (DEBUG_PY) pyArgs.push("--debug");

  console.log(`[VISION] Arrancando: python ${pyArgs.join(" ")}`);
  const py = spawn("python", pyArgs, { cwd: __dirname });

  const rl = readline.createInterface({ input: py.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      procesarEvento(JSON.parse(line));
    } catch {
      console.warn("[PARSE ERR]", line.slice(0, 80));
    }
  });

  py.stderr.on("data", (d) => process.stderr.write(`[PY] ${d}`));

  py.on("close", (code) => {
    console.log(`[VISION] Proceso terminado (code ${code})`);
    estado.conectado = false;
    io.emit("vision", { evt: "desconectado" });
  });

  estado.conectado = true;
  return py;
}

// ── Procesar evento de Python ────────────────────────────────────────────────
function procesarEvento(evt) {

  if (evt.evt === "frame") {
    broadcastFrame(Buffer.from(evt.data, "base64"));
    return;
  }

  if (evt.evt === "frame_mask") {
    broadcastMaskFrame(Buffer.from(evt.data, "base64"));
    return;
  }

  // Scan: calcular match según patrón activo del servidor
  if (evt.evt === "scan") {
    const match = (estado.patronActivo && evt.detectado)
      ? evt.detectado === estado.patronActivo
      : null;

    evt.match    = match;
    evt.esperado = estado.patronActivo;

    if (match === true)  estado.contadores.ok++;
    if (match === false) estado.contadores.alerta++;
    if (match !== null)  estado.contadores.total++;

    evt._contadores = { ...estado.contadores };
    io.emit("vision", evt);
    console.log(`[SCAN #${evt.n}] det=${evt.detectado ?? "—"}  match=${match}  conf=${(evt.confianza * 100).toFixed(0)}%`);
    return;
  }

  io.emit("vision", evt);
}

// ── Socket.io: conexiones del browser ────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Cliente conectado: ${socket.id}`);

  socket.emit("estado_inicial", {
    conectado:    estado.conectado,
    patronActivo: estado.patronActivo,
    contadores:   estado.contadores,
    patrones:     PATRONES,
  });

  socket.on("trigger_scan", () => {
    if (pyProc && pyProc.stdin.writable) {
      pyProc.stdin.write("SCAN\n");
      console.log(`[WS] SCAN → Python`);
    } else {
      console.warn("[WS] trigger_scan ignorado: Python no disponible");
    }
  });

  socket.on("set_patron", (data) => {
    if (PATRONES.includes(data.patron) || data.patron === null) {
      estado.patronActivo = data.patron;
      io.emit("patron_cambiado", { patron: data.patron });
      // Reenviar a Python para que actualice la máscara en vivo
      if (pyProc?.stdin.writable) {
        pyProc.stdin.write(`PATRON ${data.patron || ""}\n`);
      }
      console.log(`[WS] patron → ${data.patron}`);
    }
  });

  socket.on("set_hsv_range", (data) => {
    if (pyProc?.stdin.writable) {
      const { h1, h2, s1, s2, v1, v2 } = data;
      pyProc.stdin.write(`HSV ${h1} ${h2} ${s1} ${s2} ${v1} ${v2}\n`);
    }
  });

  socket.on("clear_hsv_range", () => {
    if (pyProc?.stdin.writable) {
      pyProc.stdin.write("HSV_CLEAR\n");
      // Restaurar máscara del patrón activo si hay uno
      if (estado.patronActivo && pyProc.stdin.writable) {
        pyProc.stdin.write(`PATRON ${estado.patronActivo}\n`);
      }
    }
  });

  socket.on("reset_contadores", () => {
    estado.contadores = { ok: 0, alerta: 0, total: 0 };
    io.emit("contadores", { ...estado.contadores });
    console.log("[WS] Contadores reseteados");
  });

  socket.on("disconnect", () => console.log(`[WS] Desconectado: ${socket.id}`));
});

// ── Iniciar servidor ─────────────────────────────────────────────────────────
server.listen(PORT_WEB, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  PDM Scanner                                 ║`);
  console.log(`║  HMI    → http://localhost:${PORT_WEB}               ║`);
  console.log(`║  Stream → http://localhost:${PORT_WEB}/stream        ║`);
  console.log(`║  Cam    → ${CAM_IDX}   Debug → ${DEBUG_PY ? "sí" : "no"}                  ║`);
  console.log(`║  Serial → ${(SERIAL_PORT ?? "no configurado").padEnd(34)}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  pyProc = arrancarVision();
  arrancarSerial();
});

process.on("SIGINT",  () => { if (pyProc) pyProc.kill(); process.exit(0); });
process.on("SIGTERM", () => { if (pyProc) pyProc.kill(); process.exit(0); });
