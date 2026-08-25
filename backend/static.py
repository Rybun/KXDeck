"""Sirve los estaticos del build de Vite (el bundle de widgets que
kx_home.py inyecta en el panel nativo de KX-Bridge, ver entry.tsx) y los
ficheros sueltos de frontend/public/ (favicon, manifest) desde el mismo
puerto que la API. No hay ninguna SPA propia -- la unica interfaz es el
panel nativo de KX-Bridge con las tarjetas de KXDeck inyectadas dentro."""

import os

from aiohttp import web

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
ASSETS_DIR = os.path.join(STATIC_DIR, "assets")


# Ficheros sueltos que Vite copia de frontend/public/ a la raiz del build:
# sin rutas propias caian en el catch-all generico (devuelve JSON {})
# porque solo /assets tenia servido de estaticos, asi que el
# favicon/manifest nunca se veian de verdad -- el navegador terminaba
# mostrando su propio default (o el de un proxy delante, tipo Cloudflare).
ROOT_STATIC_FILES = (
    "favicon.svg", "favicon-32.png", "apple-touch-icon.png",
    "icon-192.png", "icon-512.png", "manifest.webmanifest",
)


def register(app):
    if os.path.isdir(ASSETS_DIR):
        app.router.add_static("/assets", ASSETS_DIR, show_index=False)
    for name in ROOT_STATIC_FILES:
        path = os.path.join(STATIC_DIR, name)
        if os.path.isfile(path):
            app.router.add_get(f"/{name}", _serve_file(path))


def _serve_file(path):
    async def handler(request):
        return web.FileResponse(path)
    return handler
