"""
vision.py — Clasificador de color en conos de hilo
===================================================
Ambiente cerrado/aislado. Analiza el color dominante en la region central
del frame. Se activa SOLO cuando recibe "SCAN" por stdin (enviado por
server.js al presionar el boton en el HMI).

Uso:
    python vision.py                # camara 0
    python vision.py --cam 1        # otra camara
    python vision.py --debug        # ventana OpenCV local
    python vision.py --calibrar     # calibracion HSV interactiva
"""

import cv2
import numpy as np
import json
import sys
import time
import argparse
import base64
import threading
from dataclasses import dataclass
from typing import Optional


# ══════════════════════════════════════════════
#  PATRONES DE COLOR  (HSV: H 0-180, S/V 0-255)
# ══════════════════════════════════════════════

@dataclass
class Patron:
    id:    str
    nombre: str
    bajo:  tuple
    alto:  tuple
    bajo2: Optional[tuple] = None   # segundo rango HSV (para colores que cruzan 180°)
    alto2: Optional[tuple] = None


# cob_min eliminado: ambiente cerrado, siempre hay un cono.
# El ganador es simplemente el patron con mayor cobertura detectada.
PATRONES = {
    "dots":     Patron("dots",     "Puntos fucsia",  (113,  71,   0), (167, 255, 255)),
    "halfblue": Patron("halfblue", "Mitad azul",     ( 79,  69,  60), (109, 255, 190)),
    "orange":   Patron("orange",   "Ondas naranja",  (174,  82,   0), (180, 255, 255)),
    "green":    Patron("green",    "Bloques verdes", ( 61,  90,   0), ( 76, 255, 255)),
}


# ══════════════════════════════════════════════
#  ANALISIS DE COLOR (region central circular)
# ══════════════════════════════════════════════

def analizar(frame: np.ndarray):
    """
    Detecta el color dominante en la region central circular del frame.

    Estrategia permisiva (ambiente cerrado, siempre hay un cono):
    - Analiza el 48% central del lado menor del frame
    - Calcula que porcentaje de esa area corresponde a cada patron
    - Gana el patron con mayor cobertura, sin importar cuan baja sea
    - cobs: {patron_id: porcentaje 0.0-1.0} para las barras de la UI

    Devuelve (patron_id | None, cobs).
    None solo si todas las coberturas son exactamente 0.0 (frame negro).
    """
    h, w    = frame.shape[:2]
    r       = int(min(h, w) * 0.48)   # region un poco mas generosa
    mascara = np.zeros((h, w), np.uint8)
    cv2.circle(mascara, (w // 2, h // 2), r, 255, -1)

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    pix = max(int(np.count_nonzero(mascara)), 1)
    cobs = {}

    for pid, p in PATRONES.items():
        mc = cv2.inRange(hsv, np.array(p.bajo), np.array(p.alto))
        if p.bajo2:
            mc |= cv2.inRange(hsv, np.array(p.bajo2), np.array(p.alto2))
        cobs[pid] = round(float(np.count_nonzero(cv2.bitwise_and(mc, mascara))) / pix, 4)

    # Gana el de mayor cobertura (sin umbral minimo — ambiente cerrado)
    mejor = max(cobs, key=cobs.get) if any(v > 0 for v in cobs.values()) else None

    # Confianza = dominancia relativa del ganador sobre todos los colores detectados.
    # Ej: dots=0.008, halfblue=0.002, orange=0.001, green=0.001 → total=0.012
    #     confianza(dots) = 0.008/0.012 = 0.67  (67%)
    # Esto evita mostrar "0.8%" cuando la deteccion es correcta pero los puntos
    # son pequenos en el frame. El numero refleja CERTEZA, no area fisica.
    total_cob = sum(cobs.values())
    if mejor and total_cob > 0:
        confianza = round(cobs[mejor] / total_cob, 3)
    else:
        confianza = 0.0

    return mejor, cobs, confianza


# ══════════════════════════════════════════════
#  CALIBRACION INTERACTIVA
# ══════════════════════════════════════════════

def modo_calibrar(cam_idx: int):
    cap = cv2.VideoCapture(cam_idx)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cv2.namedWindow("Calibracion HSV")
    sliders = [("H_min", 0, 180), ("H_max", 180, 180),
               ("S_min", 0, 255), ("S_max", 255, 255),
               ("V_min", 0, 255), ("V_max", 255, 255)]
    for name, val, mx in sliders:
        cv2.createTrackbar(name, "Calibracion HSV", val, mx, lambda x: None)
    print("[CALIBRACION] 'p' = imprimir rango   'q' = salir")
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        hsv  = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        lo   = np.array([cv2.getTrackbarPos(n, "Calibracion HSV") for n in ("H_min", "S_min", "V_min")])
        hi   = np.array([cv2.getTrackbarPos(n, "Calibracion HSV") for n in ("H_max", "S_max", "V_max")])
        mask = cv2.inRange(hsv, lo, hi)
        cv2.imshow("Calibracion HSV", np.hstack([frame, cv2.bitwise_and(frame, frame, mask=mask)]))
        k = cv2.waitKey(1) & 0xFF
        if k == ord('q'):
            break
        if k == ord('p'):
            print(f"  bajo = {tuple(lo)}")
            print(f"  alto = {tuple(hi)}")
    cap.release()
    cv2.destroyAllWindows()


# ══════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════

def emit(payload: dict):
    """Emite JSON por stdout (leido por server.js via pipe)."""
    print(json.dumps(payload), flush=True)


def main():
    ap = argparse.ArgumentParser(description="Clasificador de color para conos de hilo")
    ap.add_argument("--cam",        type=int, default=0,  help="Indice de camara (default: 0)")
    ap.add_argument("--stream-fps", type=int, default=12,  help="FPS del stream visual al browser (default: 8)")
    ap.add_argument("--debug",      action="store_true",  help="Mostrar ventana OpenCV local")
    ap.add_argument("--calibrar",   action="store_true",  help="Modo calibracion HSV interactivo")
    args = ap.parse_args()

    if args.calibrar:
        modo_calibrar(args.cam)
        return

    # ── Inicializar camara ──
    cap = cv2.VideoCapture(args.cam)
    if not cap.isOpened():
        sys.stderr.write(f"[ERROR] No se pudo abrir camara {args.cam}\n")
        sys.exit(1)

    # Intentar la mayor resolucion posible; el driver cae al maximo soportado
    # si la camara no llega a 1280x720.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    cap.set(cv2.CAP_PROP_FPS, 30)

    # Leer la resolucion real que acepto el driver
    w_real = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_real = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    sys.stderr.write(f"[VISION] Camara {args.cam} — {w_real}x{h_real}. Esperando SCAN...\n")

    # ── Hilo para leer stdin sin bloquear el loop de video ──
    cmds = []
    lock = threading.Lock()

    def leer_stdin():
        for line in sys.stdin:
            s = line.strip()
            if s:
                with lock:
                    cmds.append(s)

    threading.Thread(target=leer_stdin, daemon=True).start()

    # ── Loop principal ──
    intervalo_stream = 1.0 / max(args.stream_fps, 1)
    t_stream  = 0.0
    contador  = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            sys.stderr.write("[ERROR] Sin frame de camara\n")
            break

        ahora = time.time()

        # ── Stream de video al browser ──
        # Calidad 90: visualmente indistinguible del original, mucho mejor que 60.
        # server.js lo sirve como MJPEG via HTTP; el browser lo decodifica nativo.
        if (ahora - t_stream) >= intervalo_stream:
            t_stream = ahora
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            emit({"evt": "frame", "data": base64.b64encode(buf).decode()})

        # ── Procesar comandos SCAN recibidos por stdin ──
        with lock:
            pendientes = cmds[:]
            cmds.clear()

        for cmd in pendientes:
            if cmd == "SCAN":
                contador += 1
                det, cobs, confianza = analizar(frame)
                emit({
                    "evt":       "scan",
                    "n":          contador,
                    "detectado":  det,
                    "confianza":  confianza,   # dominancia relativa 0.0-1.0
                    "coberturas": cobs,        # cobertura bruta de area por patron
                    "ts":         round(ahora, 2),
                })
                sys.stderr.write(f"[SCAN #{contador}] det={det}  confianza={confianza:.0%}  cobs={cobs}\n")

        # ── Ventana debug local ──
        if args.debug:
            # Dibujar guia circular en el frame
            h, w = frame.shape[:2]
            r    = int(min(h, w) * 0.45)
            dbg  = frame.copy()
            cv2.circle(dbg, (w // 2, h // 2), r, (100, 220, 100), 2)
            cv2.imshow("Vision — conos de hilo", dbg)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    cap.release()
    if args.debug:
        cv2.destroyAllWindows()
    sys.stderr.write(f"[VISION] Fin. Total scans: {contador}\n")


if __name__ == "__main__":
    main()
