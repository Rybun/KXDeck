"""Control directo de la Kobra X (jog/temperaturas/luz/job) y el pequeno
puñado de endpoints con forma OctoPrint de los que la propia webapp KXDeck
sigue dependiendo (login, /api/job, /api/history, descarga de gcode,
camara). Todo lo demas que antes vivia aqui ha desaparecido -- lo no
reclamado explicitamente cae ahora en el proxy generico hacia KX-Bridge (ver
kx_proxy.py), asi que una actualizacion de KX-Bridge que cambie su API ya no
puede romper nada aqui: este modulo solo depende de los pocos endpoints
propios de KX-Bridge que usa de verdad (/api/axis, /api/temperature,
/api/light, /printer/gcode/script, /printer/print/*, /kx/files/*)."""

import asyncio

import aiohttp
from aiohttp import web

from config import (
    API_KEY,
    AXIS_X,
    AXIS_Y,
    AXIS_Z,
    DEBUG_LAYER,
    FLAG_DEFAULTS,
    HOME_ALL,
    HOME_XY,
    HOME_Z,
    INTERPOLATE,
    KOBRA_IDLE,
    KOBRA_PREPARING,
    KX_URL,
    MOVE_HOME,
    MOVE_JOG,
    PREWARM_INTERVAL,
    log,
)

# Ultimo fichero "activo pero no indexado" ya avisado (ver job_payload): evita
# repetir el mismo aviso en cada tick de los websockets (cada ~1-2s) mientras
# dure la impresion.
_last_unmatched_fn_warned = None


def octo_state(kx):
    """Estado tipo OctoPrint a partir del estado real de la Kobra.

    kobra_state es mas fiable que print_state: distingue movimiento manual
    (busy) de impresion real, y separa las fases de preparacion. El bridge
    deja print_state en 'printing' tambien al mover ejes a mano.
    """
    kobra = (kx.get("kobra_state") or "").lower()
    raw = (kx.get("print_state") or "offline").lower()
    flags = dict(FLAG_DEFAULTS)

    if kobra in KOBRA_IDLE:
        flags.update({"operational": True, "ready": True})
        return "Operational", flags
    if kobra in KOBRA_PREPARING:
        flags.update({"operational": True, "printing": True})
        return "Printing", flags
    if kobra == "printing" or raw == "printing":
        flags.update({"operational": True, "printing": True})
        return "Printing", flags
    if kobra == "paused" or raw == "paused":
        flags.update({"operational": True, "paused": True})
        return "Paused", flags
    if kobra in ("error", "fault") or raw == "error":
        flags.update({"error": True, "closedOrError": True})
        return "Error", flags
    if kobra in ("offline", "disconnected") or raw == "offline":
        flags.update({"closedOrError": True})
        return "Offline", flags

    log.info("kobra_state desconocido: %r (print_state=%r)", kobra, raw)
    flags.update({"operational": True, "ready": True})
    return "Operational", flags


def is_printing(kx):
    """True solo si hay una impresion real en curso (no movimiento manual)."""
    kobra = (kx.get("kobra_state") or "").lower()
    if kobra in KOBRA_IDLE:
        return False
    if kobra in KOBRA_PREPARING:
        return False
    return kobra == "printing" or (kx.get("print_state") or "").lower() == "printing"


def check_key(request):
    # El navegador embebido del panel "Device" de OrcaSlicer inyecta esta
    # cabecera el solo (ademas de la que ya manda la pagina via JS),
    # duplicandola -- HTTP pliega dos cabeceras repetidas en una sola con
    # los valores separados por coma ("clave, clave"), lo que rompe una
    # comparacion exacta aunque la clave en si sea correcta.
    raw = request.headers.get("X-Api-Key") or request.query.get("apikey") or ""
    parts = [p.strip() for p in raw.split(",")]
    return API_KEY in parts


def deny():
    return web.json_response({"error": "Invalid API key"}, status=403)


async def h_login(request):
    return web.json_response({
        "name": "kx",
        "active": True,
        "admin": True,
        "user": True,
        "apikey": API_KEY,
        "groups": ["admins", "users"],
        "permissions": [],
        "session": "kxbridge",
    })


def empty_job(text):
    """Sin impresion activa: el bridge deja colgados los datos del trabajo
    anterior (progress 1.0, capa final). No los reportamos."""
    return {
        "job": {
            "file": {
                "id": None, "name": None, "path": None, "display": None,
                "origin": None, "size": None, "date": None,
            },
            "estimatedPrintTime": None,
            "filament": None,
            "user": None,
        },
        "progress": {
            "completion": None,
            "filepos": None,
            "printTime": None,
            "printTimeLeft": None,
            "printTimeLeftOrigin": None,
        },
        "state": text,
    }


async def job_payload(request):
    """Datos del trabajo actual, compartidos por REST y websocket."""
    kx = await request.app["kx"].get()
    files = request.app["files"]
    tracker = request.app["layer_tracker"]
    text, _ = octo_state(kx)
    kobra = (kx.get("kobra_state") or "").lower()
    printing_now = is_printing(kx)

    # En reposo o moviendo ejes a mano no hay trabajo que reportar.
    if kobra in KOBRA_IDLE:
        return empty_job(text)

    progress = float(kx.get("progress") or 0.0)
    elapsed = kx.get("print_duration") or 0
    remaining = kx.get("remain_time") or 0
    fn = kx.get("filename")
    curr_layer = kx.get("curr_layer") or 0

    size = 0
    fil_len = 0
    fil_vol = 0
    est = kx.get("slicer_time") or (elapsed + remaining)
    filepos = 0
    entry = None

    if fn:
        entry = await files.find_by_name(fn)
        if not entry:
            # Diagnostico del caso "impresion enviada fuera de esta webapp
            # (p.ej. directamente desde OrcaSlicer) no aparece en Ficheros":
            # kx-bridge reporta un filename activo que no esta en /kx/files.
            # No se intenta arreglar aqui (no hay evidencia aun de la causa
            # real) -- solo se deja constancia, una vez por fichero, para
            # poder diagnosticar con datos reales la proxima vez que ocurra.
            global _last_unmatched_fn_warned
            if fn != _last_unmatched_fn_warned:
                _last_unmatched_fn_warned = fn
                log.warning("job_payload: fichero activo no indexado en /kx/files: %s", fn)
        if entry:
            size = entry.get("size_bytes") or 0
            analysis = await files.analyze(entry)
            fil_len = analysis.get("filament_mm") or 0
            fil_vol = analysis.get("filament_cm3") or 0
            est = analysis.get("print_time") or est

    if entry and curr_layer and printing_now:
        # No bloquear el hilo caliente (websocket/REST) esperando a indexar
        # un fichero grande entero: usar el cache si ya esta, y si no,
        # dispararlo en segundo plano y caer al fallback por progreso.
        offsets = files.cached_layer_offsets(entry.get("id"))
        if offsets is None:
            files.ensure_layer_offsets(entry)
        if offsets:
            idx = min(max(curr_layer - 1, 0), len(offsets) - 1)
            start = offsets[idx]
            end = offsets[idx + 1] if idx + 1 < len(offsets) else (size or start)
            # Interpolacion dentro de la capa por tiempo transcurrido.
            # OJO: es una estimacion. La velocidad real varia mucho dentro
            # de una capa, asi que el punto mostrado es plausible, no exacto.
            if INTERPOLATE:
                frac = tracker.fraction(fn, curr_layer)
                filepos = int(start + (end - start) * frac)
                if DEBUG_LAYER:
                    log.info(
                        "capa %s frac %.2f filepos %s (rango %s-%s)",
                        curr_layer, frac, filepos, start, end,
                    )
            else:
                filepos = start
        elif size:
            filepos = int(size * progress)
    elif size:
        filepos = int(size * progress)

    return {
        "job": {
            "file": {
                "id": entry.get("id") if entry else None,
                "name": fn or None,
                "path": fn or None,
                "display": fn or None,
                "origin": "local",
                "size": size,
                "date": None,
            },
            "estimatedPrintTime": est,
            "filament": {"tool0": {"length": fil_len, "volume": fil_vol}},
            "user": "kx",
        },
        "progress": {
            "completion": progress * 100.0,
            "filepos": filepos,
            "printTime": elapsed,
            "printTimeLeft": remaining,
            "printTimeLeftOrigin": "estimate",
        },
        "state": text,
    }


async def h_job(request):
    if not check_key(request):
        return deny()
    return web.json_response(await job_payload(request))


async def h_history(request):
    if not check_key(request):
        return deny()
    jobs = await request.app["history"].get()
    out = []
    for job in jobs:
        out.append({
            "name": job.get("filename"),
            "path": job.get("filename"),
            "origin": "local",
            "startTime": job.get("start_time"),
            "endTime": job.get("end_time"),
            "printTime": job.get("print_duration") or 0,
            "success": (job.get("status") or "").lower() == "completed",
            "status": job.get("status"),
        })
    return web.json_response({"history": out, "count": len(out)})


async def h_download(request):
    """Proxy del gcode con soporte de Range, usado por el visor de capas de
    la propia webapp KXDeck (no solo por clientes externos)."""
    # match_info ya llega decodificado una vez por el propio router de
    # aiohttp -- un unquote() manual aqui decodificaria DOS veces, lo que
    # rompe cualquier fichero cuyo nombre real contenga %20/%28/%29
    # (KX-Bridge los codifica asi al guardar el fichero).
    fn = request.match_info.get("fn", "")
    log.info("descarga solicitada: %s (range=%s)", fn, request.headers.get("Range"))
    entry = await request.app["files"].find_by_name(fn)
    if not entry:
        log.warning("descarga: fichero no encontrado %s", fn)
        return web.Response(status=404)

    file_id = entry.get("id")
    session = request.app["session"]
    headers = {}
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]

    try:
        async with session.get(
            f"{KX_URL}/kx/files/{file_id}/download",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=None, sock_read=60),
        ) as upstream:
            if upstream.status not in (200, 206):
                log.warning("download %s HTTP %s", fn, upstream.status)
                return web.Response(status=upstream.status)

            out_headers = {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": f'attachment; filename="{fn}"',
                "Accept-Ranges": "bytes",
            }
            for h in ("Content-Length", "Content-Range"):
                if upstream.headers.get(h):
                    out_headers[h] = upstream.headers[h]

            resp = web.StreamResponse(status=upstream.status, headers=out_headers)
            await resp.prepare(request)
            sent = 0
            async for chunk in upstream.content.iter_chunked(65536):
                await resp.write(chunk)
                sent += len(chunk)
            await resp.write_eof()
            log.info("descarga completada: %s (%s bytes)", fn, sent)
            return resp
    except Exception as exc:
        log.error("download failed %s: %s", fn, exc)
        return web.Response(status=502)


async def _send_job_command(session, target):
    """POST real a KX-Bridge para un comando de impresion (pause/resume/
    cancel). Compartido por h_job_command y el disparo de pausas
    programadas en tracker_loop, para no duplicar la logica de la llamada."""
    async with session.post(
        f"{KX_URL}{target}",
        json={},
        timeout=aiohttp.ClientTimeout(total=10),
    ) as resp:
        txt = await resp.text()
        log.info("job cmd -> %s HTTP %s %s", target, resp.status, txt[:120])


async def h_job_command(request):
    """POST /api/job -> start/pause/cancel/restart"""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    cmd = body.get("command")
    action = body.get("action")
    session = request.app["session"]

    if cmd == "cancel":
        target = "/printer/print/cancel"
    elif cmd == "pause":
        if action == "resume":
            target = "/printer/print/resume"
        elif action == "pause":
            target = "/printer/print/pause"
        else:
            kx = await request.app["kx"].get(force=True)
            paused = (kx.get("kobra_state") or "").lower() == "paused" or \
                     (kx.get("print_state") or "").lower() == "paused"
            target = "/printer/print/resume" if paused else "/printer/print/pause"
    elif cmd in ("start", "restart"):
        target = "/printer/print/resume"
    else:
        return web.json_response({"error": f"unknown command {cmd}"}, status=400)

    try:
        await _send_job_command(session, target)
    except Exception as exc:
        log.error("job cmd failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)

    if cmd == "cancel":
        request.app["layer_tracker"].reset()
        request.app["pause_schedule"].reset()

    return web.Response(status=204)


async def send_axis(request, axis, move_type, distance=0):
    """Movimiento via /api/axis del bridge (el gcode crudo lo ignora)."""
    session = request.app["session"]
    payload = {"axis": axis, "move_type": move_type, "distance": distance}
    try:
        async with session.post(
            f"{KX_URL}/api/axis",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            txt = await resp.text()
            log.info("axis %s -> HTTP %s %s", payload, resp.status, txt[:120])
            return resp.status < 400
    except Exception as exc:
        log.error("axis failed %s: %s", payload, exc)
        return False


async def send_gcode(request, scripts):
    """Envia una lista de comandos gcode al bridge."""
    session = request.app["session"]
    for script in scripts:
        try:
            async with session.post(
                f"{KX_URL}/printer/gcode/script",
                params={"script": script},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                log.info("gcode %r -> HTTP %s", script, resp.status)
        except Exception as exc:
            log.error("gcode failed %r: %s", script, exc)
            return False
    return True


async def h_printhead(request):
    """POST /api/printer/printhead -> home y jog via /api/axis."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    cmd = body.get("command")

    if cmd == "home":
        axes = {a.lower() for a in (body.get("axes") or [])}
        if not axes or axes >= {"x", "y", "z"}:
            ok = await send_axis(request, HOME_ALL, MOVE_HOME)
        elif axes == {"z"}:
            ok = await send_axis(request, HOME_Z, MOVE_HOME)
        else:
            # El bridge no tiene home de X o Y por separado: hace XY juntos.
            ok = await send_axis(request, HOME_XY, MOVE_HOME)
            if ok and "z" in axes:
                ok = await send_axis(request, HOME_Z, MOVE_HOME)
        return web.Response(status=204) if ok else web.json_response(
            {"error": "axis failed"}, status=502)

    if cmd == "jog":
        mapping = (("x", AXIS_X), ("y", AXIS_Y), ("z", AXIS_Z))
        moved = False
        for name, axis_id in mapping:
            val = body.get(name)
            if val is None:
                continue
            try:
                dist = float(val)
            except (TypeError, ValueError):
                continue
            if dist == 0:
                continue
            if not await send_axis(request, axis_id, MOVE_JOG, dist):
                return web.json_response({"error": "axis failed"}, status=502)
            moved = True
        if not moved:
            log.info("jog sin desplazamiento util: %s", body)
        return web.Response(status=204)

    if cmd == "feedrate":
        factor = body.get("factor")
        if factor:
            pct = int(factor * 100) if factor <= 5 else int(factor)
            await send_gcode(request, [f"M220 S{pct}"])
        return web.Response(status=204)

    log.info("printhead cmd no soportado: %s", cmd)
    return web.Response(status=204)


async def h_tool(request):
    """POST /api/printer/tool -> temperatura y extrusion."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    cmd = body.get("command")
    session = request.app["session"]

    if cmd == "target":
        temp = (body.get("targets") or {}).get("tool0")
        if temp is None:
            return web.Response(status=204)
        try:
            async with session.post(
                f"{KX_URL}/api/temperature",
                json={"nozzle": temp},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                log.info("temp tool0=%s HTTP %s", temp, resp.status)
        except Exception as exc:
            log.error("temp failed: %s", exc)
            return web.json_response({"error": str(exc)}, status=502)
        return web.Response(status=204)

    if cmd == "extrude":
        amount = body.get("amount")
        if amount is None:
            return web.Response(status=204)
        speed = body.get("speed") or 300
        await send_gcode(request, ["G91", f"G1 E{amount} F{speed}", "G90"])
        return web.Response(status=204)

    if cmd == "flowrate":
        factor = body.get("factor")
        if factor:
            pct = int(factor * 100) if factor <= 5 else int(factor)
            await send_gcode(request, [f"M221 S{pct}"])
        return web.Response(status=204)

    log.info("tool cmd no soportado: %s", cmd)
    return web.Response(status=204)


async def h_bed(request):
    """POST /api/printer/bed -> temperatura de cama."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    if body.get("command") != "target":
        return web.Response(status=204)

    temp = (body.get("target") if body.get("target") is not None
            else (body.get("targets") or {}).get("bed"))
    if temp is None:
        return web.Response(status=204)

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/api/temperature",
            json={"bed": temp},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            log.info("temp bed=%s HTTP %s", temp, resp.status)
    except Exception as exc:
        log.error("temp failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.Response(status=204)


# --------------------------------------------------------------------------
# PSU Control -> luz de la Kobra X
# --------------------------------------------------------------------------

async def set_light(session, on, brightness=80):
    async with session.post(
        f"{KX_URL}/api/light",
        json={"on": bool(on), "brightness": brightness},
        timeout=aiohttp.ClientTimeout(total=10),
    ) as resp:
        return resp.status


# --------------------------------------------------------------------------
# Camara (proxy hacia KX-Bridge)
# --------------------------------------------------------------------------

async def h_snapshot(request):
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/api/camera/snapshot",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            data = await resp.read()
            return web.Response(
                body=data,
                content_type=resp.headers.get("Content-Type", "image/jpeg"),
            )
    except Exception as exc:
        log.error("snapshot failed: %s", exc)
        return web.Response(status=502)


async def h_stream(request):
    """Proxy del MJPEG. OJO: KX-Bridge sirve un solo cliente a la vez."""
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/api/camera/stream",
            timeout=aiohttp.ClientTimeout(total=None, sock_read=30),
        ) as upstream:
            resp = web.StreamResponse(
                status=upstream.status,
                headers={
                    "Content-Type": upstream.headers.get(
                        "Content-Type", "multipart/x-mixed-replace"
                    ),
                    "Cache-Control": "no-cache, no-store",
                    "X-Accel-Buffering": "no",
                },
            )
            await resp.prepare(request)
            async for chunk in upstream.content.iter_chunked(8192):
                await resp.write(chunk)
            return resp
    except Exception as exc:
        log.warning("stream ended: %s", exc)
        return web.Response(status=502)


async def tracker_loop(app):
    """Vigila el cambio de capa con resolucion fina.

    Es el unico sitio que llama a observe(): asi las duraciones se miden
    una sola vez por capa, sin que las consultas de REST/websocket alteren
    el estado del tracker.
    """
    tracker = app["layer_tracker"]
    pause_schedule = app["pause_schedule"]
    temp_history = app["temp_history"]
    kx = app["kx"]
    session = app["session"]
    try:
        while True:
            try:
                state = await kx.get()
                temp_history.record(state.get("nozzle_temp", 0.0), state.get("bed_temp", 0.0))
                if is_printing(state):
                    filename = state.get("filename")
                    tracker.observe(filename, state.get("curr_layer") or 0)
                    # Pausas programadas (ver PauseSchedule/kxdeck_api.py):
                    # se vigilan aqui, en el mismo sondeo de 1s que ya existe
                    # para el tracker de capas, en vez de un bucle propio.
                    due = pause_schedule.check(
                        filename, state.get("curr_layer") or 0, state.get("print_duration") or 0,
                    )
                    if due is not None:
                        log.info("pausa programada disparada: %s", due)
                        try:
                            await _send_job_command(session, "/printer/print/pause")
                        except Exception as exc:
                            log.error("pausa programada fallo: %s", exc)
            except Exception as exc:
                log.debug("tracker loop: %s", exc)
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        pass


async def prewarm_loop(app):
    """Analiza la biblioteca y precalienta el render 3D de todos los
    ficheros al arrancar y cada PREWARM_INTERVAL segundos, para que abrir
    cualquier pieza sea instantaneo en vez de esperar a que se genere.

    Mira app["general_settings"]["prewarm_enabled"] en cada vuelta (no solo
    al arrancar) -- asi que activarlo/desactivarlo desde Ajustes -> KXDeck
    (ver general_settings.py) se aplica en la siguiente vuelta, sin
    reiniciar el contenedor."""
    try:
        while True:
            try:
                if app["general_settings"]["prewarm_enabled"]:
                    await app["files"].prewarm()
                    await app["files"].prewarm_renders()
            except Exception as exc:
                log.warning("prewarm error: %s", exc)
            await asyncio.sleep(PREWARM_INTERVAL)
    except asyncio.CancelledError:
        pass
