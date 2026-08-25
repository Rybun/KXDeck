"""Integracion con Home Assistant: interruptores de luces junto a la luz de
la camara (una o varias), via webhooks en los dos sentidos (nunca se guarda
ningun token de acceso de HA en KXDeck):

- KXDeck -> HA: al pulsar un interruptor, POST a un webhook de HA (uno por
  luz, configurado por el usuario), que dispara una automatizacion suya
  (ver HaLightSettingsCard en el frontend, que ensena el YAML exacto a
  pegar, una vez por luz).
- HA -> KXDeck: una automatizacion de HA, disparada por el cambio de
  estado de la luz real, hace un rest_command contra
  /api/kxdeck/ha/light-state con el secreto de ESA luz (cada luz tiene el
  suyo propio, generado por KXDeck) -- el propio secreto identifica de que
  luz se trata, no hace falta mandar ningun otro id en el payload.

Todas las luces comparten la misma URL de Home Assistant (base_url) --
tiene sentido, es la misma instancia -- pero cada una tiene su propio
webhook_id (accion) e incoming_secret (para el reporte de estado)."""

import json
import os
import secrets

import aiohttp
from aiohttp import web

from config import log

DATA_DIR = os.environ.get("KXDECK_DATA_DIR", "/app/data")
SETTINGS_PATH = os.path.join(DATA_DIR, "ha_settings.json")

DEFAULTS = {"base_url": "", "lights": []}


def load_settings():
    """Se llama una vez al arrancar (ver app.py::on_startup)."""
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    # Solo se copian las claves del esquema ACTUAL -- si se hiciera con un
    # simple {**DEFAULTS, **data}, las claves sueltas del formato viejo
    # (webhook_id/light_label/incoming_secret al nivel superior) se
    # colarian y se quedarian ahi para siempre, sin usarse, cada vez que se
    # reescribe el fichero.
    settings = {"base_url": data.get("base_url", DEFAULTS["base_url"]), "lights": data.get("lights") or []}

    # Migracion desde el formato viejo (una sola luz, campos sueltos
    # "webhook_id"/"light_label"/"incoming_secret" al nivel superior en vez
    # de una lista "lights") -- si el fichero es de antes de admitir varias
    # luces y de verdad habia algo configurado, se convierte en la primera
    # entrada de la lista en vez de perderse.
    if not settings["lights"] and data.get("webhook_id"):
        settings["lights"] = [{
            "id": secrets.token_hex(8),
            "label": data.get("light_label") or "Luz habitación",
            "webhook_id": data["webhook_id"],
            "incoming_secret": data.get("incoming_secret") or secrets.token_urlsafe(24),
        }]
        _save(settings)
    elif any(k in data for k in ("webhook_id", "light_label", "incoming_secret")):
        # El fichero ya se habia migrado en un arranque anterior, pero las
        # claves sueltas del formato viejo seguian sin limpiar (la rama de
        # arriba solo reescribe el fichero la PRIMERA vez, cuando "lights"
        # todavia esta vacio) -- una sola pasada mas de limpieza basta.
        _save(settings)

    return settings


def _save(settings):
    # Escritura atomica (fichero temporal + rename): evita dejar un JSON a
    # medio escribir si el proceso muriera justo en mitad de un guardado.
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp_path = SETTINGS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, SETTINGS_PATH)


def _public(request):
    """Los mismos settings, mas el ultimo estado conocido de cada luz -- lo
    que de verdad necesita pintar la tarjeta de Ajustes y los
    interruptores."""
    settings = request.app["ha_settings"]
    states = request.app["ha_light_states"]
    return {
        "base_url": settings["base_url"],
        "lights": [{**light, "state": states.get(light["id"])} for light in settings["lights"]],
    }


async def h_get_settings(request):
    return web.json_response(_public(request))


async def h_save_settings(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON invalido"}, status=400)

    settings = request.app["ha_settings"]
    existing_by_id = {light["id"]: light for light in settings["lights"]}

    new_lights = []
    for item in body.get("lights", []) or []:
        if not isinstance(item, dict):
            continue
        light_id = item.get("id")
        existing = existing_by_id.get(light_id) if light_id else None
        label = str(item.get("label", "")).strip() or "Luz"
        webhook_id = str(item.get("webhook_id", "")).strip()
        if existing:
            # Conserva su id y secreto -- solo etiqueta/webhook son editables.
            new_lights.append({
                "id": existing["id"],
                "label": label,
                "webhook_id": webhook_id,
                "incoming_secret": existing["incoming_secret"],
            })
        else:
            new_lights.append({
                "id": secrets.token_hex(8),
                "label": label,
                "webhook_id": webhook_id,
                "incoming_secret": secrets.token_urlsafe(24),
            })

    settings["base_url"] = str(body.get("base_url", settings["base_url"])).strip().rstrip("/")
    settings["lights"] = new_lights
    _save(settings)

    # Cualquier luz que ya no este en la lista (se borro) tambien pierde su
    # estado en memoria -- si se vuelve a crear despues sera un id nuevo.
    valid_ids = {light["id"] for light in new_lights}
    request.app["ha_light_states"] = {
        k: v for k, v in request.app["ha_light_states"].items() if k in valid_ids
    }

    return web.json_response(_public(request))


async def h_regenerate_secret(request):
    light_id = request.match_info["id"]
    settings = request.app["ha_settings"]
    for light in settings["lights"]:
        if light["id"] == light_id:
            light["incoming_secret"] = secrets.token_urlsafe(24)
            _save(settings)
            break
    else:
        return web.json_response({"error": "luz no encontrada"}, status=404)
    return web.json_response(_public(request))


async def h_light_state_webhook(request):
    """Webhook DE ENTRADA: lo llama la automatizacion de HA (via
    rest_command) cada vez que una luz real cambia de estado. El secreto
    identifica de que luz se trata -- no hace falta mandar ningun id."""
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400)
    secret = body.get("secret")
    on = body.get("on")
    if not isinstance(on, bool):
        return web.json_response({"error": "'on' debe ser true/false"}, status=400)

    settings = request.app["ha_settings"]
    for light in settings["lights"]:
        if light["incoming_secret"] and light["incoming_secret"] == secret:
            request.app["ha_light_states"][light["id"]] = on
            return web.Response(status=204)
    return web.Response(status=403)


async def h_light_toggle(request):
    """Lo llama el propio dashboard de KXDeck (interruptor junto a la
    camara, o el boton "Probar" de Ajustes) -- dispara el webhook DE
    SALIDA de esa luz, que en HA arranca la automatizacion real
    (normalmente light.toggle sobre la luz de verdad). No hace falta
    esperar ni reintentar nada: el estado real que se acaba viendo en el
    dashboard siempre llega, por separado, por el webhook de entrada."""
    light_id = request.match_info["id"]
    settings = request.app["ha_settings"]
    light = next((l for l in settings["lights"] if l["id"] == light_id), None)
    if not light:
        return web.json_response({"error": "luz no encontrada"}, status=404)
    if not settings["base_url"] or not light["webhook_id"]:
        return web.json_response({"error": "falta la URL de HA o el ID de webhook de esta luz"}, status=400)

    url = f"{settings['base_url']}/api/webhook/{light['webhook_id']}"
    session = request.app["session"]
    try:
        async with session.post(url, timeout=aiohttp.ClientTimeout(total=10)):
            pass
    except Exception as exc:
        log.warning("webhook de HA fallo (%s): %s", url, exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.Response(status=204)


def register(router):
    router.add_get("/api/kxdeck/ha/settings", h_get_settings)
    router.add_post("/api/kxdeck/ha/settings", h_save_settings)
    router.add_post("/api/kxdeck/ha/settings/lights/{id}/regenerate-secret", h_regenerate_secret)
    router.add_post("/api/kxdeck/ha/light-state", h_light_state_webhook)
    router.add_post("/api/kxdeck/ha/lights/{id}/toggle", h_light_toggle)
