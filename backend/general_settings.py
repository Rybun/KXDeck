"""Ajustes generales de KXDeck (Ajustes -> KXDeck en el panel, ver
KxDeckFeaturesCard en frontend/src/widgets/entry.tsx). De momento solo
guarda si el renderizado 3D/2D en segundo plano (precalentado periodico de
toda la biblioteca, ver printer_control.py::prewarm_loop) debe correr o no
-- en un Pi compartido con otros ~20 contenedores puede interesar apagarlo.
Los demas toggles de esa tarjeta (que inyectar en el panel) son solo del
navegador (localStorage), no necesitan estado en el servidor."""

import json
import os

from aiohttp import web

from config import PREWARM, log

DATA_DIR = os.environ.get("KXDECK_DATA_DIR", "/app/data")
SETTINGS_PATH = os.path.join(DATA_DIR, "general_settings.json")


def load_settings():
    """Se llama una vez al arrancar (ver app.py::on_startup). El valor por
    defecto viene de la variable de entorno PREWARM -- asi que quien ya la
    tuviera puesta a 0 en su .env no ve un cambio de comportamiento hasta
    que entre aqui y lo cambie a mano."""
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    return {"prewarm_enabled": bool(data.get("prewarm_enabled", PREWARM))}


def _save(settings):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp_path = SETTINGS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, SETTINGS_PATH)


async def h_get_settings(request):
    return web.json_response(request.app["general_settings"])


async def h_save_settings(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON invalido"}, status=400)

    settings = request.app["general_settings"]
    if "prewarm_enabled" in body:
        settings["prewarm_enabled"] = bool(body["prewarm_enabled"])
        _save(settings)
        log.info("renderizado en segundo plano: %s", "activado" if settings["prewarm_enabled"] else "desactivado")

    return web.json_response(settings)


def register(router):
    router.add_get("/api/kxdeck/settings/general", h_get_settings)
    router.add_post("/api/kxdeck/settings/general", h_save_settings)
