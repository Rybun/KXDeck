"""Configuracion y constantes compartidas por KXDeck."""

import logging
import os
import re

KX_URL = os.environ.get("KX_URL", "http://192.168.1.100:7125").rstrip("/")
# Identificador del build desplegado (commit corto de git), para ensenarlo
# en la tarjeta "Acerca de KXDeck" (ver kx_home.py). El workflow de CI pasa
# el SHA completo como build-arg -- se recorta aqui a 7 caracteres (lo
# habitual en git); "dev" tal cual si se construyo en local sin pasarlo.
KXDECK_VERSION = os.environ.get("KXDECK_VERSION", "dev")[:7]
API_KEY = os.environ.get("API_KEY", "kxbridge0000000000000000000000000")
# Dominios por los que NO se debe poder entrar (p.ej. un dominio publico que
# en su dia se uso para acceso externo y ya no se quiere mantener). Vacio
# por defecto -- se rellena por entorno, nunca hardcodeado aqui (ver
# app.py::block_hosts).
BLOCKED_HOSTS = {h.strip().lower() for h in os.environ.get("BLOCKED_HOSTS", "").split(",") if h.strip()}
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "5000"))
CACHE_TTL = float(os.environ.get("CACHE_TTL", "1.0"))
FILES_TTL = float(os.environ.get("FILES_TTL", "10.0"))
TAIL_BYTES = int(os.environ.get("TAIL_BYTES", str(96 * 1024)))
PREWARM = os.environ.get("PREWARM", "1") not in ("0", "false", "False")
PREWARM_INTERVAL = float(os.environ.get("PREWARM_INTERVAL", "900"))
# Prioridad de CPU (nice, 0-19) del hilo que parsea el gcode para el render
# 3D: en Linux nice() es POR HILO, asi que rebajarla aqui no afecta al hilo
# principal del event loop (UI, estado de la impresora siguen respondiendo
# con normalidad) mientras se genera un render pesado en segundo plano.
RENDER_NICE = int(os.environ.get("RENDER_NICE", "15"))
# Cache en DISCO de los renders 3D/2D generados (ver kx_client.py,
# _render_both): antes se guardaban indefinidamente en RAM (un diccionario
# por proceso), y con ~80 ficheros en la biblioteca eso sumaba ~2GB
# permanentes en un Pi que comparte memoria con otros ~20 contenedores.
# Guardarlos en disco en vez de en RAM evita ese coste fijo: cada fichero
# solo ocupa memoria TRANSITORIA mientras se sirve esa peticion en concreto.
# Necesita un volumen montado en docker-compose.yml para sobrevivir a un
# `docker compose up --build` (si no, es solo la capa escribible del
# contenedor, que se descarta al recrearlo).
RENDER_CACHE_DIR = os.environ.get("RENDER_CACHE_DIR", "/app/render_cache")
DEBUG_REQUESTS = os.environ.get("DEBUG_REQUESTS", "0") not in ("0", "false", "False")
DEBUG_LAYER = os.environ.get("DEBUG_LAYER", "0") not in ("0", "false", "False")
LAYER_INDEX = os.environ.get("LAYER_INDEX", "1") not in ("0", "false", "False")
# Volumen de impresion de la Kobra X, reutilizado por el render de
# gcode_render.py.
BED_WIDTH = 260.0
BED_HEIGHT = 260.0
INTERPOLATE = os.environ.get("INTERPOLATE", "1") not in ("0", "false", "False")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(name)s - %(message)s",
)
log = logging.getLogger("kxdeck")

FLAG_DEFAULTS = {
    "operational": False,
    "paused": False,
    "printing": False,
    "pausing": False,
    "cancelling": False,
    "sdReady": False,
    "error": False,
    "ready": False,
    "closedOrError": False,
}

# Estados de kobra_state observados en la Kobra X:
#   free           -> reposo
#   busy           -> movimiento manual (home, jog): NO es impresion
#   auto_leveling  -> nivelando antes de imprimir
#   preheating     -> calentando antes de imprimir
#   printing       -> imprimiendo de verdad
KOBRA_IDLE = ("free", "busy", "idle", "")
KOBRA_PREPARING = ("auto_leveling", "leveling", "preheating", "heating")

# Mapeo de ejes de KX-Bridge (/api/axis)
#   move_type 1 = jog (distance con signo)
#   move_type 2 = home (distance 0)
AXIS_X = 1
AXIS_Y = 2
AXIS_Z = 3
HOME_Z = 3
HOME_XY = 4
HOME_ALL = 5
MOVE_JOG = 1
MOVE_HOME = 2

RE_FIL_MM = re.compile(r";\s*filament used \[mm\]\s*=\s*(.+)")
RE_FIL_CM3 = re.compile(r";\s*filament used \[cm3\]\s*=\s*(.+)")
RE_FIL_G = re.compile(r";\s*total filament used \[g\]\s*=\s*([\d.]+)")
RE_TIME = re.compile(r";\s*estimated printing time \(normal mode\)\s*=\s*(.+)")
RE_MAXZ = re.compile(r";\s*max_z_height:\s*([\d.]+)")
RE_LAYER_N = re.compile(r";\s*total layer number:\s*(\d+)")
RE_SVG_COORD = re.compile(r"[ML]\s+([\d.]+)\s+([\d.]+)")
RE_FIL_COLOUR = re.compile(r"^\s*;\s*filament_colour\s*=\s*(.+)$", re.MULTILINE)
RE_FIL_MULTI_COLOUR = re.compile(r"^\s*;\s*filament_multi_colour\s*=\s*(.+)$", re.MULTILINE)
RE_FIL_TYPE = re.compile(r"^\s*;\s*filament_type\s*=\s*(.+)$", re.MULTILINE)
RE_TOOL_CHANGE = re.compile(r"(?m)^[ \t]*T([0-9]+)\b")

LAYER_MARKER = b";LAYER_CHANGE"
