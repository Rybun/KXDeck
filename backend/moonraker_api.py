"""Los unicos endpoints con forma Moonraker donde KXDeck aporta algo real
sobre lo que ya sirve KX-Bridge de forma nativa en esos mismos paths (KX-Bridge
es en si mismo un bridge Moonraker -- confirmado con curl contra /server/info,
/printer/info, /printer/objects/query, etc.: devuelve datos reales, mas
completos que cualquier traduccion que hiciera KXDeck aqui). Todo lo demas
(estado, temperaturas, objetos, impresion, websocket JSON-RPC...) ya no se
reimplementa: cae en el catch-all generico (kx_proxy.py) y se reenvia tal
cual a KX-Bridge, asi que sigue funcionando sin tocar este fichero aunque
KX-Bridge cambie o amplie su API."""

import aiohttp
from aiohttp import web

from config import API_KEY, KX_URL, log


async def h_access_api_key(request):
    """KX-Bridge devuelve un sentinela fijo de "sin autenticacion" en su
    propio /access/api_key; aqui se devuelve la API key real de KXDeck, que
    es la que de verdad hace falta para hablar con KXDeck (no con KX-Bridge
    directamente)."""
    return web.json_response({"result": API_KEY})


async def h_webcams_list(request):
    """KX-Bridge apunta esta lista a sus propias URLs de camara; se
    reescriben para que pasen por KXDeck (mismo origen que el resto de la
    API, funciona igual en LAN que a traves de un tunel remoto)."""
    host = request.host
    return web.json_response({
        "result": {
            "webcams": [{
                "name": "KXDeck",
                "location": "printer",
                "service": "mjpegstreamer",
                "enabled": True,
                "target_fps": 5,
                "stream_url": f"http://{host}/webcam/",
                "snapshot_url": f"http://{host}/snapshot",
                "flip_horizontal": False,
                "flip_vertical": False,
                "rotation": 0,
                "aspect_ratio": "16:9",
            }]
        }
    })


async def h_files_upload(request):
    """Proxy crudo del multipart -- KX-Bridge ya hace subida + auto-print
    server-side. Se mantiene como endpoint propio (en vez de dejarlo caer al
    catch-all generico) solo por el efecto secundario de refrescar la cache
    de ficheros de KXDeck nada mas terminar, para que aparezca al instante
    en el listado sin esperar al siguiente sondeo periodico."""
    session = request.app["session"]
    ct = request.headers.get("Content-Type", "")
    try:
        async with session.post(
            f"{KX_URL}/server/files/upload",
            data=request.content,
            headers={"Content-Type": ct},
            timeout=aiohttp.ClientTimeout(total=300),
        ) as upstream:
            body = await upstream.read()
            log.info("moonraker upload -> HTTP %s (%s bytes)", upstream.status, len(body))
            if upstream.status < 400:
                await request.app["files"].get(force=True)
            # upstream.content_type es solo el mime-type (sin ";charset=..."):
            # pasar la cabecera Content-Type completa a web.Response revienta
            # ("charset must not be in content_type argument") porque ese
            # parametro exige el tipo desnudo, el charset va aparte.
            return web.Response(
                body=body,
                status=upstream.status,
                content_type=upstream.content_type or "application/json",
            )
    except Exception as exc:
        log.error("moonraker upload failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)


def register(router):
    router.add_get("/access/api_key", h_access_api_key)
    router.add_get("/server/webcams/list", h_webcams_list)
    router.add_post("/server/files/upload", h_files_upload)
