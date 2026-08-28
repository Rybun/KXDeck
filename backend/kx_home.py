"""Home de KXDeck: sirve el panel nativo de KX-Bridge en / (via kx_proxy,
sin prefijo -- ya no hace falta reescribir rutas absolutas como hacia el
antiguo kxbridge_proxy.py), con las tarjetas propias de KXDeck (visor
gcode, saltar objetos, carretes, color de acento, notificaciones)
inyectadas dentro de su dashboard/ajustes. El bundle que las monta vive en
frontend/src/widgets/entry.tsx.

Insercion basada en marcadores estables (no en texto traducido -- la propia
pagina cambia de idioma en tiempo real). Si KX-Bridge cambia la estructura
de su Panel y algun marcador deja de encontrarse, esa insercion en
concreto simplemente se omite -- el panel de KX-Bridge en si nunca se ve
afectado por esto."""

import json
import os

import aiohttp
from aiohttp import web

import static
from config import KX_URL, KXDECK_VERSION, log

_WIDGET_SLOT_MARKER = '<div id="dash-hidden-bar"></div>'
_APPEARANCE_MARKER = '<div class="set-group" id="setgrp-display">'
_INTEGRATIONS_MARKER = '<div class="set-group" id="setgrp-integrations">'
_SYSTEM_MARKER = '<div class="set-group" id="setgrp-system">'
_SETCAT_SYSTEM_MARKER = 'id="setcat-system"'
_SETTINGS_CONTENT_MARKER = '<div class="settings-content">'
_CAM_MARKER = '<div class="cam-wrap" id="cam-wrap">'
# Solo el id (no el texto del boton, que KX-Bridge traduce en cliente segun
# idioma -- ver cabecera de este fichero) para no depender de en que idioma
# se sirvio esta respuesta en concreto.
_PAUSE_BTN_MARKER = 'id="d-btn-pause"'
_LOGO_OPEN = '<div class="logo">'
_STYLE_CLOSE = "</style>"

# Nueva categoria de Ajustes "KXDeck" (junto a Verbindung/Drucker/System...),
# con sus propios toggles (ver KxDeckFeaturesCard en entry.tsx) para
# activar/desactivar cada cosa que KXDeck inyecta -- por si alguna en
# concreto molesta o da problemas en un dispositivo, sin tener que tocar
# variables de entorno ni perder el resto. showSettingsCat('kxdeck') ya
# funciona solo (es la misma funcion nativa generica que usan el resto de
# categorias, busca #setgrp-kxdeck/#setcat-kxdeck por convencion de nombre).
_KXDECK_SETCAT_BTN = (
    '<button class="set-cat" id="setcat-kxdeck" onclick="showSettingsCat(\'kxdeck\')">'
    "<span>🧩</span> <span>KXDeck</span></button>"
)
_KXDECK_SETGRP = '<div class="set-group" id="setgrp-kxdeck"><div id="kxd-features-root"></div></div>'

# Pequena marca "enhanced by KXDeck" anadida DENTRO del propio div.logo
# nativo (se deja su contenido -- icono hexagono + "KX-Bridge" -- tal cual,
# esto solo se APPENDea antes de su cierre). Mismo trazo que
# branding/kx-deck-symbol.svg, pero como HTML/CSS suelto en vez de React --
# va directo en la pagina nativa de KX-Bridge (luz, no shadow DOM), asi que
# no puede depender de clases de Tailwind. "--accent"/"--txt2" (variables
# nativas) ya existen desde el primer pintado (KX-Bridge las define en su
# propio :root), asi que nunca hace FOUC aunque el bundle de widgets tarde
# en cargar -- y si el usuario elige otro color de acento en Ajustes ->
# Darstellung, el icono se recolorea solo (ver lib/accent.ts).
_LOGO_BADGE = (
    # En movil (ver el @media en _HEAD_EXTRA) se oculta entera -- el sidebar
    # nativo ahi es tan estrecho que el texto se parte en varias lineas y el
    # icono queda descolocado; mejor dejar solo "KX-Bridge" tal cual, como
    # en el resto de la app nativa.
    '<span class="kxd-logo-badge" style="display:inline-flex;align-items:center;gap:4px;'
    'margin-left:8px;font-size:11px;font-weight:500;color:var(--txt2);'
    'letter-spacing:normal;vertical-align:middle;white-space:nowrap">'
    '<span style="display:inline-flex;align-items:center;justify-content:center;'
    'width:14px;height:14px;border-radius:22%;background:var(--accent);flex-shrink:0">'
    '<svg viewBox="0 0 324 244" width="8" height="8" fill="none" stroke="#fff" '
    'stroke-width="44" stroke-linecap="butt">'
    '<path d="M122 22 L122 222"/><path d="M202 22 L202 222"/>'
    '<path d="M122 122 L22 22"/><path d="M122 122 L22 222"/>'
    '<path d="M202 122 L302 22"/><path d="M202 122 L302 222"/>'
    "</svg></span>enhanced by KXDeck</span>"
)

# Tarjeta de "Acerca de KXDeck" anadida al final del grupo de Ajustes ->
# System (justo al lado de la propia tarjeta "Version" de KX-Bridge) --
# deja claro que lo que se esta viendo es KX-Bridge con KXDeck inyectado
# encima (proyecto de terceros, independiente), mas su licencia y el build
# concreto desplegado (KXDECK_VERSION, ver config.py -- viene del commit de
# git con el que se genero la imagen, "dev" si se construyo en local sin
# pasar ese build-arg).
_ABOUT_CARD = (
    '<div class="card" style="margin-top:10px">'
    '<div class="card-title"><span>ℹ️</span> KXDeck</div>'
    '<p style="font-size:12px;color:var(--txt2);margin:6px 0 0;line-height:1.5">'
    'Este panel es <b>KX-Bridge</b> con <b>KXDeck</b> inyectado encima -- un '
    "proyecto de terceros, independiente, no mantenido por el equipo de "
    "KX-Bridge.</p>"
    '<div style="font-size:11px;color:var(--txt2);margin-top:8px;font-family:var(--mono)">'
    f"KXDeck {KXDECK_VERSION} &middot; Licencia MIT &middot; "
    '<a href="https://github.com/Rybun/KXDeck" target="_blank" rel="noreferrer" '
    'style="color:inherit">github.com/Rybun/KXDeck</a>'
    "</div></div>"
)

# Favicon: KX-Bridge no trae ninguno propio (su <head> no tiene ni un solo
# <link rel="icon">, el navegador cae al default /favicon.ico, que el
# catchall generico reenvia a KX-Bridge y probablemente ni existe ahi).
# Los ficheros SI existen y ya se sirven en la raiz por static.py
# (ROOT_STATIC_FILES) -- solo faltaba enlazarlos desde el <head>.
_HEAD_EXTRA = (
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">'
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    "<style>"
    # ".layout" (sidebar + main) vive dentro de un body flex-column con solo
    # min-height:100vh (sin height ni overflow propios): si el contenido de
    # main crece mas de una pantalla, el body entero crece con el y quien
    # scrollea pasa a ser LA PAGINA, arrastrando consigo a "nav.sidebar" (un
    # simple hermano en flujo normal, sin position:sticky/fixed) -- se
    # pierde de la izquierda al bajar. Fijar la altura del body a 100vh y
    # cortar su overflow obliga a que SIEMPRE sea "main" (overflow-y:auto)
    # quien scrollea por dentro, como el propio CSS de KX-Bridge ya da a
    # entender que queria (de ahi el min-height:0 en .layout, un truco que
    # solo tiene sentido si el contenedor exterior tiene altura fija) -- el
    # sidebar, al quedar fuera de "main", deja de moverse nunca.
    "html,body{height:100vh;overflow:hidden}"
    # Ver _LOGO_BADGE: en pantallas estrechas (movil) el sidebar nativo no
    # tiene sitio para el badge sin partirlo en varias lineas -- se oculta
    # entero y se deja solo "KX-Bridge".
    "@media(max-width:640px){.kxd-logo-badge{display:none!important}}"
    "</style>"
)

MANIFEST_PATH = os.path.join(static.STATIC_DIR, ".vite", "manifest.json")
_WIDGETS_ENTRY = "src/widgets/entry.tsx"


def load_widgets_js():
    """Resuelve el nombre real (con hash) del bundle de widgets a partir del
    manifest de Vite. Se llama una vez al arrancar (ver app.py); si falta el
    manifest o la entrada, se degrada a "sin widgets" sin romper nada."""
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        entry = manifest.get(_WIDGETS_ENTRY)
        if entry and entry.get("file"):
            return f"/{entry['file']}"
        log.warning("entrada '%s' no encontrada en el manifest de Vite: sin widgets en /", _WIDGETS_ENTRY)
    except FileNotFoundError:
        log.warning("manifest de Vite no encontrado (%s): sin widgets inyectados en /", MANIFEST_PATH)
    except Exception as exc:
        log.warning("no se pudo leer el manifest de Vite: %s", exc)
    return None


def _badge_logo(html):
    start = html.find(_LOGO_OPEN)
    if start == -1:
        log.warning("'.logo' no encontrado en el panel de KX-Bridge: sin marca de KXDeck ahi")
        return html
    close = html.find("</div>", start)
    if close == -1:
        return html
    return html[:close] + _LOGO_BADGE + html[close:]


def _insert_after(html, marker, extra, warn_msg):
    idx = html.find(marker)
    if idx == -1:
        log.warning(warn_msg)
        return html
    pos = idx + len(marker)
    return html[:pos] + extra + html[pos:]


def _insert_after_closing(html, marker, close_tag, extra, warn_msg):
    """Como _insert_after, pero inserta despues del primer close_tag que
    aparezca DETRAS de marker -- para anadir un hermano justo despues de un
    elemento entero (marker solo necesita ser un fragmento estable dentro
    de ese elemento, no hace falta su apertura exacta)."""
    idx = html.find(marker)
    if idx == -1:
        log.warning(warn_msg)
        return html
    close_idx = html.find(close_tag, idx)
    if close_idx == -1:
        return html
    pos = close_idx + len(close_tag)
    return html[:pos] + extra + html[pos:]


async def h_home(request):
    session = request.app["session"]
    try:
        async with session.get(f"{KX_URL}/", timeout=aiohttp.ClientTimeout(total=15)) as upstream:
            html = await upstream.text()
            status = upstream.status
            cache_control = upstream.headers.get("Cache-Control", "no-store, no-cache, must-revalidate")
    except Exception as exc:
        log.error("kx-bridge home fetch failed: %s", exc)
        return web.Response(status=502, text=f"kx-bridge unreachable: {exc}")

    if _STYLE_CLOSE in html:
        html = html.replace(_STYLE_CLOSE, _STYLE_CLOSE + _HEAD_EXTRA, 1)
    else:
        log.warning("cierre de '<style>' no encontrado: sin favicon/fix de sidebar en KX-Bridge")

    html = _badge_logo(html)
    html = _insert_after(
        html, _SYSTEM_MARKER, _ABOUT_CARD,
        "marcador de Ajustes -> System no encontrado: sin tarjeta 'Acerca de KXDeck' ahi",
    )
    html = _insert_after_closing(
        html, _SETCAT_SYSTEM_MARKER, "</button>", _KXDECK_SETCAT_BTN,
        "marcador de la categoria 'System' de Ajustes no encontrado: sin pestaña KXDeck ahi",
    )
    html = _insert_after(
        html, _SETTINGS_CONTENT_MARKER, _KXDECK_SETGRP,
        "'.settings-content' no encontrado: sin categoria KXDeck en Ajustes",
    )

    widgets_js = request.app.get("widgets_js")
    if widgets_js:
        if _WIDGET_SLOT_MARKER in html:
            slot = (
                f'{_WIDGET_SLOT_MARKER}\n'
                f'      <div id="kxdeck-widgets-root"></div>'
                f'<script type="module" src="{widgets_js}"></script>'
            )
            html = html.replace(_WIDGET_SLOT_MARKER, slot, 1)
        else:
            log.warning("marcador de insercion de widgets no encontrado en el panel de KX-Bridge")

        html = _insert_after(
            html, _APPEARANCE_MARKER,
            '\n      <div id="kxd-appearance-root" style="margin-bottom:10px"></div>',
            "marcador de Ajustes -> Darstellung no encontrado: sin selector de acento ahi",
        )
        html = _insert_after(
            html, _INTEGRATIONS_MARKER,
            '\n      <div id="kxd-integrations-root" style="margin-bottom:10px"></div>',
            "marcador de Ajustes -> Integrationen no encontrado: sin notificaciones ahi",
        )

        # Dos marcadores vacios justo antes de #cam-wrap (el propio bundle de
        # widgets se encarga de rellenarlos en JS, no aqui):
        # - kxd-cam-filament-root: tira de bobinas de filamento, entre el
        #   titulo y el video (ver patchCameraFilamentStrip en entry.tsx).
        # - kxd-cam-gcode-root: mueve #cam-wrap junto a el dentro de una fila
        #   comun, para que el visor de gcode comparta tarjeta con la camara
        #   (lado a lado si cabe, con pestañas si no).
        # Se hace en JS y no con string-matching aqui porque #cam-wrap
        # contiene divs anidados (placeholder, overlay...) y encontrar SU
        # cierre exacto por texto seria fragil.
        if _CAM_MARKER in html:
            html = html.replace(
                _CAM_MARKER,
                '<div id="kxd-cam-filament-root"></div><div id="kxd-cam-gcode-root"></div>' + _CAM_MARKER,
                1,
            )
        else:
            log.warning("'#cam-wrap' no encontrado: sin visor de gcode junto a la camara")

        # Boton "⋮" justo despues del boton nativo de Pausa (#d-btn-pause):
        # abre el menu de pausas programadas (ver PauseScheduleMenu en
        # entry.tsx / PauseSchedule en kx_client.py -- ya vigiladas por
        # tracker_loop, esto solo le faltaba interfaz).
        html = _insert_after_closing(
            html, _PAUSE_BTN_MARKER, "</button>",
            '<div id="kxd-pause-menu-root" style="display:inline-block"></div>',
            "'#d-btn-pause' no encontrado: sin menu de pausas programadas",
        )

    return web.Response(
        text=html, status=status, content_type="text/html",
        headers={"Cache-Control": cache_control},
    )
