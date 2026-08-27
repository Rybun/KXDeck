#!/usr/bin/env python3
"""
KXDeck backend

La unica interfaz es la home (/): el propio panel nativo de KX-Bridge, con
las tarjetas de KXDeck inyectadas dentro (ver kx_home.py). No hay ninguna
SPA propia aparte. Ademas sirve el minimo punado de endpoints con forma
OctoPrint/Moonraker de los que esas tarjetas dependen. Cualquier otra ruta
no reclamada explicitamente se reenvia tal cual a KX-Bridge (ver
kx_proxy.py) -- asi una actualizacion de KX-Bridge no puede romper nada
aqui, solo puede anadir funciones nuevas que ya llegan solas.
"""

import asyncio

import aiohttp
from aiohttp import web

import general_settings
import ha_settings
import kx_home
import kx_proxy
import kxdeck_api
import moonraker_api
import printer_control as pc
import static
from config import BLOCKED_HOSTS, DEBUG_REQUESTS, LISTEN_PORT, KX_URL, log
from kx_client import KxFiles, KxHistory, KxState, LayerTracker, PauseSchedule, TempHistory


# Pagina redirectora para que una notificacion de Home Assistant abra la
# PWA instalada en pantalla de inicio (webapp://) en vez del navegador --
# vive en el mismo origen que octoapp.rybun.rocks (ver docker-compose.yml,
# ese dominio tunelizado por Cloudflare apunta a este mismo contenedor,
# puerto 5000) porque la app de HA necesita una URL https normal a la que
# apuntar, no puede lanzar esquemas custom directamente. Sin auth (no llama
# a check_key ni depende de ningun middleware de sesion -- no hay ninguno
# global aqui, ver build_app()) y sin cache, para que el salto se ejecute
# siempre. IMPORTANTE: esto NO basta por si solo -- octoapp.rybun.rocks
# esta ademas detras de Cloudflare Access A NIVEL DE BORDE (confirmado con
# curl -I contra el dominio publico: 302 a cloudflareaccess.com), que
# intercepta la peticion antes de que llegue siquiera al tunel/este
# contenedor. Hace falta una Access Application aparte para la ruta
# /abrir con politica "Bypass" en el dashboard de Cloudflare Zero Trust
# (o via su API, que no esta configurada aqui) para que de verdad no pida
# login -- ese paso no se puede hacer desde este servidor.
_ABRIR_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Abriendo OctoApp…</title>
  <style>
    body { font: 17px -apple-system, sans-serif; text-align: center;
           padding: 3rem 1.5rem; }
    a.btn { display: inline-block; margin-top: 1.5rem; padding: 1rem 2rem;
            background: #2196F3; color: #fff; border-radius: 12px;
            text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <script>
    window.location.replace("shortcuts://run-shortcut?name=OctoApp");
    setTimeout(function () {
      window.location.replace("https://octoapp.rybun.rocks");
    }, 4000);
  </script>
  <p>Abriendo OctoApp…</p>
  <a class="btn" href="shortcuts://run-shortcut?name=OctoApp">Abrir OctoApp</a>
</body>
</html>
"""


async def h_abrir(request):
    return web.Response(
        text=_ABRIR_HTML,
        content_type="text/html",
        charset="utf-8",
        headers={"Cache-Control": "no-store"},
    )


@web.middleware
async def log_requests(request, handler):
    if DEBUG_REQUESTS:
        log.info("-> %s %s", request.method, request.path_qs)
    return await handler(request)


@web.middleware
async def block_hosts(request, handler):
    """Corta cualquier peticion cuyo Host este en BLOCKED_HOSTS antes de que
    llegue a ninguna ruta (ni siquiera al catchall que reenvia a KX-Bridge)
    -- pensado para un dominio publico que en su dia se expuso hacia este
    contenedor y que ya no debe tener ninguna entrada, sea cual sea la ruta."""
    host = request.headers.get("Host", "").split(":")[0].lower()
    if host in BLOCKED_HOSTS:
        return web.Response(status=404)
    return await handler(request)


async def on_startup(app):
    app["session"] = aiohttp.ClientSession()
    app["kx"] = KxState(app["session"])
    app["files"] = KxFiles(app["session"])
    app["history"] = KxHistory(app["session"])
    app["layer_tracker"] = LayerTracker()
    app["pause_schedule"] = PauseSchedule()
    app["temp_history"] = TempHistory()
    app["widgets_js"] = kx_home.load_widgets_js()
    app["ha_settings"] = ha_settings.load_settings()
    # id de luz -> True/False. Una luz sin entrada aqui todavia es
    # "desconocida" hasta que llegue su primer webhook de estado real de HA
    # (ver ha_settings.py::h_light_state_webhook) -- nunca se asume on/off.
    app["ha_light_states"] = {}
    app["general_settings"] = general_settings.load_settings()

    log.info("KXDeck -> %s (puerto %s)", KX_URL, LISTEN_PORT)

    app["tracker_task"] = asyncio.create_task(pc.tracker_loop(app))
    # Siempre se lanza (antes solo si PREWARM) -- el propio bucle mira
    # app["general_settings"]["prewarm_enabled"] en cada vuelta, asi que
    # activarlo/desactivarlo desde Ajustes -> KXDeck se aplica sin reiniciar
    # el contenedor (ver printer_control.py::prewarm_loop).
    app["prewarm_task"] = asyncio.create_task(pc.prewarm_loop(app))


async def on_cleanup(app):
    for key in ("prewarm_task", "tracker_task"):
        task = app.get(key)
        if task:
            task.cancel()
    await app["session"].close()


def build_app():
    app = web.Application(client_max_size=1024 ** 3, middlewares=[block_hosts, log_requests])
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    r = app.router

    # --- Home: panel nativo de KX-Bridge, con las tarjetas de KXDeck
    #     inyectadas dentro (ver kx_home.py) ---
    r.add_get("/", kx_home.h_home)

    # --- Redirector a la PWA instalada (notificaciones de Home Assistant) ---
    r.add_get("/abrir", h_abrir)

    # --- Control directo de la Kobra, del que la webapp KXDeck depende ---
    r.add_post("/api/login", pc.h_login)
    r.add_get("/api/job", pc.h_job)
    r.add_post("/api/job", pc.h_job_command)
    r.add_get("/api/history", pc.h_history)
    r.add_get("/downloads/files/local/{fn:.*}", pc.h_download)
    r.add_post("/api/printer/printhead", pc.h_printhead)
    r.add_post("/api/printer/tool", pc.h_tool)
    r.add_post("/api/printer/bed", pc.h_bed)
    r.add_get("/webcam/", pc.h_stream)
    r.add_get("/webcam", pc.h_stream)
    r.add_get("/snapshot", pc.h_snapshot)

    # --- KXDeck (webapp nueva) ---
    kxdeck_api.register(r)

    # --- Integracion con Home Assistant (luz de la habitacion) ---
    ha_settings.register(r)

    # --- Ajustes generales de KXDeck (Ajustes -> KXDeck) ---
    general_settings.register(r)

    # --- Los pocos endpoints Moonraker donde KXDeck aporta algo real ---
    moonraker_api.register(r)

    static.register(app)

    # --- Todo lo demas: directo a KX-Bridge, tal cual (ver kx_proxy.py) ---
    r.add_route("*", "/{path:.*}", kx_proxy.h_catchall)

    return app


if __name__ == "__main__":
    web.run_app(build_app(), host="0.0.0.0", port=LISTEN_PORT, access_log=None)
