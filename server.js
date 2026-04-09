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

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { spawn }  = require("child_process");
const path       = require("path");
const readline   = require("readline");

// ── Argumentos ──────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const hasFlag = (flag) => argv.includes(flag);

const CAM_IDX  = getArg("--cam", "0");
const PORT_WEB = parseInt(getArg("--web", "3000"), 10);
const DEBUG_PY = hasFlag("--debug");

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

let latestFrame  = null;          // Buffer del último JPEG recibido
const streamClients = new Set();  // Responses HTTP activas

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type":  `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma":        "no-cache",
    "Connection":    "keep-alive",
    "Transfer-Encoding": "chunked",
  });

  streamClients.add(res);

  // Enviar el último frame disponible de inmediato para evitar pantalla en negro
  if (latestFrame) pushFrame(res, latestFrame);

  req.on("close", () => streamClients.delete(res));
});

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

// ── Estado global ────────────────────────────────────────────────────────────
const PATRONES = ["dots", "halfblue", "orange", "green"];

let estado = {
  conectado:    false,
  patronActivo: null,
  contadores:   { ok: 0, alerta: 0, total: 0 },
};

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

  // Frame de video: decodificar base64 → Buffer → broadcast MJPEG
  // No se emite por Socket.io, va directo al stream HTTP
  if (evt.evt === "frame") {
    broadcastFrame(Buffer.from(evt.data, "base64"));
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
      console.log(`[WS] patron → ${data.patron}`);
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
  console.log(`╚══════════════════════════════════════════════╝\n`);
  pyProc = arrancarVision();
});

process.on("SIGINT",  () => { if (pyProc) pyProc.kill(); process.exit(0); });
process.on("SIGTERM", () => { if (pyProc) pyProc.kill(); process.exit(0); });
