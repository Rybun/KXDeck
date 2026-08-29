"""Endpoints nuevos para la webapp KXDeck.

Reutilizan los mismos objetos KxState/KxFiles y helpers ya usados por
printer_control: check_key para la autenticacion, octo_state/job_payload
para el estado, set_light para la luz, etc. Nada de logica se duplica
cuando un endpoint ya expone el mismo dato (jog, temperaturas, historial,
job, camara siguen sirviendose desde /api/printer/*, /api/job, /api/history,
/webcam, /snapshot -- ver printer_control.py).
"""

import asyncio

import aiohttp
from aiohttp import web

from config import KX_URL, log
from kx_client import iso_to_epoch
from printer_control import check_key, deny, job_payload, octo_state, set_light


async def h_kxdeck_state(request):
    if not check_key(request):
        return deny()
    kx = await request.app["kx"].get()
    text, flags = octo_state(kx)
    history = request.app["temp_history"].as_dict()
    return web.json_response({"state": {"text": text, "flags": flags}, **kx, **history})


async def h_kxdeck_files(request):
    """Listado de ficheros en formato KX nativo (thumbnail inline, colores de
    filamento, tamano...) en vez del formato reducido de OctoPrint."""
    if not check_key(request):
        return deny()
    files = request.app["files"]
    history = request.app["history"]
    entries = await files.get()
    out = []
    for entry in entries:
        analysis = files.cached_analysis(entry.get("id"))
        stats = await history.stats_for(entry.get("filename") or "")
        item = dict(entry)
        item["date"] = iso_to_epoch(entry.get("uploaded_at"))
        item["filament_colors"] = analysis.get("filament_colors") or []
        item["filament_materials"] = analysis.get("filament_materials") or []
        item["est_print_time_sec"] = analysis.get("print_time") or entry.get("est_print_time_sec") or 0
        item["prints"] = {"success": stats["success"], "failure": stats["failure"]}
        out.append(item)
    out.sort(key=lambda f: f["date"], reverse=True)
    return web.json_response({"files": out})


async def h_kxdeck_file_print(request):
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    entry = await request.app["files"].find_by_id(file_id)
    if not entry:
        return web.json_response({"error": "not found"}, status=404)

    try:
        body = await request.json()
    except Exception:
        body = {}
    assignments = body.get("filament_assignments")
    excluded_objects = body.get("excluded_objects")

    # /kx/print (en vez de /printer/print/start) permite mapear que color de
    # cada paint del gcode usa que slot fisico cargado; sin assignments hace
    # el mismo auto-mapeo que un print normal (compatibilidad).
    session = request.app["session"]
    payload = {"file_id": file_id}
    if assignments:
        payload["filament_assignments"] = assignments
    if isinstance(excluded_objects, list) and excluded_objects:
        # Pre-print skip: KX-Bridge aplica esto solo (handle_kx_print), en
        # cuanto el drucker confirma el arranque y reporta la lista real de
        # objetos (ventana de ~12s); no hace falta reenviar nada mas.
        payload["excluded_objects"] = [str(n) for n in excluded_objects if isinstance(n, str) and n]
    if "auto_leveling" in body:
        payload["auto_leveling"] = 1 if body.get("auto_leveling") else 0
    if "vibration_compensation" in body:
        # OJO: en esta version de KX-Bridge, handle_kx_print ignora este campo
        # y siempre manda vibration_compensation=0 al firmware (no esta
        # cableado server-side); se envia igualmente por si una version futura
        # del bridge lo empieza a leer, pero hoy no tiene efecto real.
        payload["vibration_compensation"] = 1 if body.get("vibration_compensation") else 0
    try:
        async with session.post(
            f"{KX_URL}/kx/print",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck print %s -> HTTP %s %s", entry.get("filename"), resp.status, txt[:200])
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck print failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)

    request.app["layer_tracker"].reset()
    return web.json_response({"result": "ok"})


async def h_kxdeck_file_delete(request):
    """DELETE /api/kxdeck/files/{id} -> reenvia a KX-Bridge (DELETE
    /kx/files/{id}, confirmado contra el bridge real: {"result":"ok"} o 404
    {"error":"not found"}) y refresca la cache local."""
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    session = request.app["session"]
    try:
        async with session.delete(
            f"{KX_URL}/kx/files/{file_id}",
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck delete %s -> HTTP %s %s", file_id, resp.status, txt[:200])
            if resp.status == 404:
                return web.json_response({"error": "not found"}, status=404)
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck delete failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)

    await request.app["files"].get(force=True)
    return web.json_response({"result": "ok"})


async def h_kxdeck_file_layers(request):
    """Offsets de byte por capa, para que el visor de gcode pida cada capa
    con un Range request contra /downloads/files/local/{fn} (ya existente)."""
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    files = request.app["files"]
    entry = await files.find_by_id(file_id)
    if not entry:
        return web.json_response({"error": "not found"}, status=404)

    offsets = await files.layer_offsets(entry)
    if offsets is None:
        return web.json_response({"error": "no se pudo indexar"}, status=502)

    return web.json_response({
        "filename": entry.get("filename"),
        "size": entry.get("size_bytes") or 0,
        "count": len(offsets),
        "offsets": offsets,
        # Herramienta activa al INICIO de cada capa (mismo indice que
        # offsets): el visor de gcode parsea cada capa de forma
        # independiente (sin arrastrar estado de las anteriores, para poder
        # saltar a cualquier capa al instante), asi que sin esto arrancaba
        # siempre asumiendo herramienta 0 -- si el "Tn" real solo se fija
        # una vez al principio del fichero (habitual en bandejas de un solo
        # canal/color), el resaltado por color nunca coincidia salvo en la
        # capa 0.
        "start_tools": files.layer_start_tools(file_id),
    })


async def h_kxdeck_file_render(request):
    """GET /api/kxdeck/files/{id}/render -> render 3D interactivo de la pieza
    entera (todas las capas, sin soportes): contenedor binario de vertices
    por objeto+color (ver gcode_render.py), consumido directo por Three.js
    como BufferGeometry. Se usa para resaltar visualmente el mapeo de
    colores y la eleccion de objetos a saltar, y para ver/rotar la pieza en
    3D. Generado en el servidor y cacheado en DISCO, no en RAM (ver
    KxFiles.render_preview / kx_client._render_both): el navegador nunca
    parsea gcode, solo construye geometria a partir de vertices ya
    calculados (el dibujado interactivo lo hace la GPU via WebGL)."""
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    entry = await request.app["files"].find_by_id(file_id)
    if not entry:
        return web.json_response({"error": "not found"}, status=404)

    result = await request.app["files"].render_preview(entry)
    if result is None:
        return web.json_response({"error": "no se pudo generar el render"}, status=502)
    return web.Response(body=result, content_type="application/octet-stream")


async def h_kxdeck_file_render_2d(request):
    """GET /api/kxdeck/files/{id}/render2d -> version 2D (vista cenital o
    isometrica, solo contorno de pared exterior) del mismo render de
    arriba: se usa para el resaltado de mapeo de colores/saltar objetos
    cuando el render 3D esta desactivado (mas ligero, sin Three.js -- para
    dispositivos menos potentes). Sale del mismo parseo que el 3D
    (KxFiles.render_preview_2d delega en render_preview), asi que si ya se
    pidio el render 3D de este fichero esto es instantaneo. JSON plano (los
    <path> SVG de ambas vistas ya vienen construidos por gcode_render.py,
    el navegador no calcula ninguna proyeccion ni geometria)."""
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    entry = await request.app["files"].find_by_id(file_id)
    if not entry:
        return web.json_response({"error": "not found"}, status=404)

    result = await request.app["files"].render_preview_2d(entry)
    if result is None:
        return web.json_response({"error": "no se pudo generar el render"}, status=502)
    return web.Response(body=result, content_type="application/json")


async def h_kxdeck_file_objects(request):
    """GET /api/kxdeck/files/{id}/objects -> nombres de objetos imprimibles
    del fichero (para el dialogo de 'saltar objetos' antes de imprimir).
    Si el fichero aun no tiene objetos indexados, KX-Bridge los pide en
    segundo plano al drucker; una recarga posterior del dialogo los trae."""
    if not check_key(request):
        return deny()
    file_id = request.match_info.get("id", "")
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/kx/files/{file_id}/objects",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return web.json_response({"result": {"names": [], "svg_b64": ""}})
            payload = await resp.json()
    except Exception as exc:
        log.warning("kxdeck file objects error: %s", exc)
        return web.json_response({"result": {"names": [], "svg_b64": ""}})
    return web.json_response(payload)


async def fetch_skip_state(session):
    """Estado de 'saltar objeto' de la impresion en curso (objetos totales +
    ya saltados). Se llama desde dentro del propio tick del websocket
    (h_kxdeck_ws) mientras se imprime, no como sondeo aparte del frontend."""
    try:
        async with session.get(
            f"{KX_URL}/kx/skip/state",
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            if resp.status == 200:
                payload = await resp.json()
                return payload.get("result")
    except Exception as exc:
        log.debug("kxdeck skip state error: %s", exc)
    return None


async def h_kxdeck_skip_query(request):
    """POST /api/kxdeck/skip/query -> reconsulta a la impresora la lista de
    objetos (util justo tras iniciar una impresion, antes de que llegue el
    primer reporte espontaneo del drucker)."""
    if not check_key(request):
        return deny()
    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/kx/skip/query",
            json={},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            if resp.status != 200:
                return web.json_response({"result": None})
            payload = await resp.json()
    except Exception as exc:
        log.warning("kxdeck skip query error: %s", exc)
        return web.json_response({"result": None})
    return web.json_response(payload)


async def h_kxdeck_skip(request):
    """POST /api/kxdeck/skip {names: [...]} -> salta objeto(s) EN MEDIO de
    la impresion en curso. Accion real e irreversible sobre el hardware."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        body = {}
    names = body.get("names")
    if not isinstance(names, list) or not names or not all(isinstance(n, str) and n for n in names):
        return web.json_response({"error": "names must be a non-empty list[str]"}, status=400)

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/kx/skip",
            json={"names": names},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck skip %s -> HTTP %s %s", names, resp.status, txt[:200])
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck skip failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.json_response({"result": "ok"})


async def h_kxdeck_upload(request):
    """POST /api/kxdeck/files/upload -> reenvia el gcode subido desde el
    navegador a KX-Bridge como multipart, igual que hace su propia UI."""
    if not check_key(request):
        return deny()

    reader = await request.multipart()
    filename = None
    file_bytes = None
    async for part in reader:
        if part.name == "file":
            filename = part.filename or "upload.gcode"
            file_bytes = await part.read(decode=False)
            break

    if not file_bytes:
        return web.json_response({"error": "no file received"}, status=400)

    form = aiohttp.FormData()
    form.add_field("file", file_bytes, filename=filename, content_type="application/octet-stream")

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/server/files/upload",
            data=form,
            timeout=aiohttp.ClientTimeout(total=180),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck upload %s -> HTTP %s %s", filename, resp.status, txt[:200])
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck upload failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)

    await request.app["files"].get(force=True)
    return web.json_response({"result": "ok", "filename": filename})


async def h_kxdeck_filament_slots(request):
    if not check_key(request):
        return deny()
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/kx/filament/slots",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return web.json_response({"result": []}, status=200)
            payload = await resp.json()
    except Exception as exc:
        log.warning("kxdeck filament slots error: %s", exc)
        return web.json_response({"result": []}, status=200)
    return web.json_response(payload)


async def h_kxdeck_filament_profiles(request):
    """GET /api/kxdeck/filament/profiles?type=PLA -> proxy de la lista
    estatica de perfiles OrcaSlicer de KX-Bridge (bridge/data/orca_filaments.json)."""
    if not check_key(request):
        return deny()
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/kx/filament/profiles",
            params=request.rel_url.query,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return web.json_response({"result": []}, status=200)
            payload = await resp.json()
    except Exception as exc:
        log.warning("kxdeck filament profiles error: %s", exc)
        return web.json_response({"result": []}, status=200)
    return web.json_response(payload)


async def h_kxdeck_visible_vendors(request):
    """GET /api/kxdeck/filament/visible_vendors -> proxy del filtro de
    fabricantes configurado en KX-Bridge, para no listar los ~200 perfiles
    completos en el desplegable (solo los del fabricante(s) configurado(s),
    + Generic, igual que hace la propia UI de KX-Bridge)."""
    if not check_key(request):
        return deny()
    session = request.app["session"]
    try:
        async with session.get(
            f"{KX_URL}/kx/filament/visible_vendors",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                return web.json_response({"result": []}, status=200)
            payload = await resp.json()
    except Exception as exc:
        log.warning("kxdeck visible vendors error: %s", exc)
        return web.json_response({"result": []}, status=200)
    return web.json_response(payload)


async def h_kxdeck_set_slot_profile(request):
    """POST /api/kxdeck/filament/slots/{idx}/profile -> asigna (o quita, con
    vendor/name vacios) el perfil comercial OrcaSlicer de un slot."""
    if not check_key(request):
        return deny()
    try:
        slot_idx = int(request.match_info.get("idx", "-1"))
    except ValueError:
        return web.json_response({"error": "bad slot index"}, status=400)
    if slot_idx < 0:
        return web.json_response({"error": "bad slot index"}, status=400)

    try:
        body = await request.json()
    except Exception:
        body = {}

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/kx/filament/slots/{slot_idx}/profile",
            json={
                "vendor": body.get("vendor", ""),
                "name": body.get("name", ""),
                "id": body.get("id", ""),
            },
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck set_slot_profile %s -> HTTP %s %s", slot_idx, resp.status, txt[:200])
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck set_slot_profile failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.json_response({"result": "ok"})


async def h_kxdeck_set_slot(request):
    """POST /api/kxdeck/filament/slots/{idx} -> edita color+material real de
    un slot cargado, igual que el editor de slot de la propia UI de KX-Bridge
    (/api/ams/set_slot: manda el cambio al hardware via multiColorBox/setInfo).
    """
    if not check_key(request):
        return deny()
    try:
        slot_idx = int(request.match_info.get("idx", "-1"))
    except ValueError:
        return web.json_response({"error": "bad slot index"}, status=400)
    if slot_idx < 0:
        return web.json_response({"error": "bad slot index"}, status=400)

    try:
        body = await request.json()
    except Exception:
        body = {}
    material = str(body.get("material") or "PLA").upper()
    color = body.get("color")
    if not (isinstance(color, list) and len(color) == 3):
        return web.json_response({"error": "color must be [r,g,b]"}, status=400)

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/api/ams/set_slot",
            json={"index": slot_idx, "type": material, "color": color},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            txt = await resp.text()
            log.info("kxdeck set_slot %s -> HTTP %s %s", slot_idx, resp.status, txt[:200])
            if resp.status >= 400:
                return web.json_response({"error": txt[:200]}, status=502)
    except Exception as exc:
        log.error("kxdeck set_slot failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.json_response({"result": "ok"})


async def h_kxdeck_speed(request):
    """POST /api/kxdeck/speed {mode: 1|2|3} -> silencioso/normal/deportivo."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        body = {}
    mode = body.get("mode")
    if mode not in (1, 2, 3):
        return web.json_response({"error": "mode must be 1, 2 or 3"}, status=400)

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/api/speed",
            json={"mode": mode},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            log.info("kxdeck speed mode=%s HTTP %s", mode, resp.status)
    except Exception as exc:
        log.error("kxdeck speed failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    await request.app["kx"].get(force=True)
    return web.json_response({"result": "ok"})


async def h_kxdeck_fan(request):
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        body = {}
    speed = body.get("speed")
    if speed is None:
        return web.json_response({"error": "missing speed"}, status=400)

    session = request.app["session"]
    try:
        async with session.post(
            f"{KX_URL}/api/fan",
            json={"speed": speed},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            log.info("kxdeck fan=%s HTTP %s", speed, resp.status)
    except Exception as exc:
        log.error("kxdeck fan failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    return web.json_response({"result": "ok"})


async def h_kxdeck_light(request):
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        body = {}

    kx_cache = request.app["kx"]
    kx = await kx_cache.get()
    on = body.get("on")
    if on is None:
        on = bool(kx.get("light_on"))
    brightness = body.get("brightness")
    if brightness is None:
        brightness = kx.get("light_brightness") or 80

    session = request.app["session"]
    try:
        await set_light(session, on, brightness)
    except Exception as exc:
        log.error("kxdeck light failed: %s", exc)
        return web.json_response({"error": str(exc)}, status=502)
    await kx_cache.get(force=True)
    return web.json_response({"result": "ok"})


async def h_kxdeck_pause_schedule_list(request):
    """GET /api/kxdeck/pause-schedule -> pausas programadas para el fichero
    que este imprimiendo ahora mismo (vacio si no hay impresion activa)."""
    if not check_key(request):
        return deny()
    kx = await request.app["kx"].get()
    filename = kx.get("filename")
    entries = request.app["pause_schedule"].list(filename)
    return web.json_response({"entries": entries})


async def h_kxdeck_pause_schedule_add(request):
    """POST /api/kxdeck/pause-schedule {kind: "layer"|"time", value: int}."""
    if not check_key(request):
        return deny()
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    kind = body.get("kind")
    if kind not in ("layer", "time"):
        return web.json_response({"error": "kind must be 'layer' or 'time'"}, status=400)
    try:
        value = int(body.get("value"))
    except (TypeError, ValueError):
        return web.json_response({"error": "value must be a number"}, status=400)
    if value <= 0:
        return web.json_response({"error": "value must be positive"}, status=400)

    kx = await request.app["kx"].get()
    filename = kx.get("filename")
    if not filename:
        return web.json_response({"error": "no hay impresion activa"}, status=400)

    entry = request.app["pause_schedule"].add(filename, kind, value)
    return web.json_response({"entry": entry})


async def h_kxdeck_pause_schedule_delete(request):
    """DELETE /api/kxdeck/pause-schedule/{id}"""
    if not check_key(request):
        return deny()
    try:
        entry_id = int(request.match_info.get("id"))
    except (TypeError, ValueError):
        return web.json_response({"error": "bad id"}, status=400)
    removed = request.app["pause_schedule"].remove(entry_id)
    if not removed:
        return web.json_response({"error": "not found"}, status=404)
    return web.Response(status=204)


async def h_kxdeck_ws(request):
    """Websocket JSON plano (sin el envoltorio SockJS de OctoPrint) para el
    dashboard de KXDeck."""
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)
    kx_cache = request.app["kx"]
    temp_history = request.app["temp_history"]
    session = request.app["session"]
    log.info("kxdeck websocket conectado")

    try:
        while not ws.closed:
            kx = await kx_cache.get()
            text, flags = octo_state(kx)
            job = await job_payload(request)
            # Solo se pide a KX-Bridge la lista de "saltar objeto" mientras
            # hay una impresion activa: evita una llamada extra por tick
            # (cada 1.5s) en reposo, que es donde pasa la mayor parte del tiempo.
            skip = await fetch_skip_state(session) if (flags["printing"] or flags["paused"]) else None
            try:
                ha_settings = request.app["ha_settings"]
                ha_states = request.app["ha_light_states"]
                await ws.send_json({
                    "state": {"text": text, "flags": flags},
                    "kx": {**kx, **temp_history.as_dict()},
                    "job": job["job"],
                    "progress": job["progress"],
                    "skip": skip,
                    "gcode_pause_layers": job.get("kxd_pause_layers", []),
                    "ha_lights": [
                        {"id": light["id"], "label": light["label"], "on": ha_states.get(light["id"])}
                        for light in ha_settings["lights"]
                    ],
                })
            except Exception:
                break
            await asyncio.sleep(1.5)
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        log.info("kxdeck websocket error: %s", exc)
    finally:
        log.info("kxdeck websocket cerrado")

    return ws


def register(router):
    router.add_get("/api/kxdeck/state", h_kxdeck_state)
    router.add_get("/api/kxdeck/ws", h_kxdeck_ws)
    router.add_get("/api/kxdeck/files", h_kxdeck_files)
    router.add_post("/api/kxdeck/files/{id}/print", h_kxdeck_file_print)
    router.add_delete("/api/kxdeck/files/{id}", h_kxdeck_file_delete)
    router.add_get("/api/kxdeck/files/{id}/layers", h_kxdeck_file_layers)
    router.add_get("/api/kxdeck/files/{id}/objects", h_kxdeck_file_objects)
    router.add_get("/api/kxdeck/files/{id}/render", h_kxdeck_file_render)
    router.add_get("/api/kxdeck/files/{id}/render2d", h_kxdeck_file_render_2d)
    router.add_post("/api/kxdeck/skip/query", h_kxdeck_skip_query)
    router.add_post("/api/kxdeck/skip", h_kxdeck_skip)
    router.add_post("/api/kxdeck/files/upload", h_kxdeck_upload)
    router.add_get("/api/kxdeck/filament/slots", h_kxdeck_filament_slots)
    router.add_get("/api/kxdeck/filament/profiles", h_kxdeck_filament_profiles)
    router.add_get("/api/kxdeck/filament/visible_vendors", h_kxdeck_visible_vendors)
    router.add_post("/api/kxdeck/filament/slots/{idx}", h_kxdeck_set_slot)
    router.add_post("/api/kxdeck/filament/slots/{idx}/profile", h_kxdeck_set_slot_profile)
    router.add_post("/api/kxdeck/fan", h_kxdeck_fan)
    router.add_post("/api/kxdeck/light", h_kxdeck_light)
    router.add_post("/api/kxdeck/speed", h_kxdeck_speed)
    router.add_get("/api/kxdeck/pause-schedule", h_kxdeck_pause_schedule_list)
    router.add_post("/api/kxdeck/pause-schedule", h_kxdeck_pause_schedule_add)
    router.add_delete("/api/kxdeck/pause-schedule/{id}", h_kxdeck_pause_schedule_delete)
