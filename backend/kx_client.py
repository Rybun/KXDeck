"""Cliente/cache de KX-Bridge: estado, ficheros, historial y analisis de gcode."""

import asyncio
import base64
import bisect
import datetime
import json
import os
import re
import time
from collections import deque

import aiohttp

from config import (
    BED_HEIGHT,
    BED_WIDTH,
    CACHE_TTL,
    DEBUG_LAYER,
    FILES_TTL,
    KX_URL,
    LAYER_INDEX,
    LAYER_MARKER,
    RE_FIL_CM3,
    RE_FIL_COLOUR,
    RE_FIL_G,
    RE_FIL_MM,
    RE_FIL_MULTI_COLOUR,
    RE_FIL_TYPE,
    RE_LAYER_N,
    RE_MAXZ,
    RE_SVG_COORD,
    RE_TIME,
    RENDER_CACHE_DIR,
    RENDER_NICE,
    TAIL_BYTES,
    log,
)
from gcode_render import build_render_buffers

# Version del formato de cache en disco de los renders (ver _render_both):
# subir este numero invalida TODA la cache existente sin tener que borrarla
# a mano -- las rutas de fichero incluyen la version, asi que un cambio de
# logica en gcode_render.py (como los arreglos de huecos/tapa/sombreado de
# esta misma sesion) no se sirve nunca por accidente desde una cache vieja
# con un formato o resultado distinto.
RENDER_CACHE_VERSION = 10

# Detecta lineas "Tn" (cambio de herramienta/color) durante el mismo barrido
# de bytes que ya localiza los marcadores de capa en layer_offsets, para
# poder decirle al visor de gcode que herramienta esta activa al principio
# de cada capa (ver _layer_tools mas abajo) -- sin esto, el visor arrancaba
# el parseo de CUALQUIER capa asumiendo herramienta 0, y si el "Tn" real se
# fija una sola vez al principio del fichero (antes de la primera capa,
# como en las bandejas de un solo color/canal), el resaltado del mapeo de
# colores nunca encontraba coincidencia salvo en la mismisima capa 0.
_TOOL_RE = re.compile(rb"(?:\A|\n)[ \t]*T(\d{1,3})[ \t]*(?:;[^\r\n]*)?(?=\r?\n|\Z)")

# Pausa insertada por el propio slicer (Anycubic Slicer Next: "Añadir pausa"
# / gcode personalizado en una capa concreta usa M600, documentado
# oficialmente para esta familia de impresoras; M601 aparece como variante
# del mismo comando) -- distinta de las pausas programadas por KXDeck
# (PauseSchedule mas abajo, que nunca tocan el propio fichero). El grupo
# captura solo "M600"/"M601" (no la linea entera, que puede traer
# parametros/comentario) para que start(1) de directamente el offset del
# comando, igual que _TOOL_RE con el numero de herramienta.
_PAUSE_RE = re.compile(rb"(?:\A|\n)[ \t]*(M60[01])\b[^\r\n]*")


def _render_cache_paths(file_id):
    base = os.path.join(RENDER_CACHE_DIR, f"{file_id}.v{RENDER_CACHE_VERSION}")
    return base + ".3d.bin", base + ".2d.json"


def _render_cache_exists(file_id):
    p3d, p2d = _render_cache_paths(file_id)
    return os.path.exists(p3d) and os.path.exists(p2d)


def _read_render_cache(file_id):
    """None si no hay cache (o esta incompleta/corrupta -- se regenera como
    si fuera la primera vez, nunca se lanza una excepcion hacia arriba por
    un fichero de cache roto)."""
    p3d, p2d = _render_cache_paths(file_id)
    try:
        with open(p3d, "rb") as f:
            buf3d = f.read()
        with open(p2d, "rb") as f:
            buf2d = f.read()
    except OSError:
        return None
    return buf3d, buf2d


def _write_render_cache(file_id, buf3d, buf2d):
    """Escritura atomica (escribir a .tmp y renombrar): si el proceso se
    interrumpe a mitad, nunca queda un fichero de cache a medias que
    _read_render_cache pudiera confundir con uno valido."""
    os.makedirs(RENDER_CACHE_DIR, exist_ok=True)
    p3d, p2d = _render_cache_paths(file_id)
    for path, data in ((p3d, buf3d), (p2d, buf2d)):
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)


def _build_render_buffers_niced(data, tool_colors, bed_w, bed_h, layer_height):
    """Envoltorio de build_render_buffers que rebaja la prioridad de CPU del
    hilo (nice, ver RENDER_NICE) antes de parsear. En Linux nice() es POR
    HILO (cada hilo tiene su propio valor de scheduling en el kernel), asi
    que esto no toca el hilo principal del event loop: el resto de la app
    (UI, estado de la impresora) sigue respondiendo con normalidad mientras
    se genera un render pesado (hasta ~200MB de gcode) en segundo plano. Sin
    esto, precalentar la biblioteca entera competia por CPU a la misma
    prioridad que todo lo demas y podia dejar el sistema entero sin
    respuesta durante minutos."""
    try:
        os.nice(RENDER_NICE)
    except OSError:
        pass
    return build_render_buffers(data, tool_colors, bed_w, bed_h, layer_height)


def iso_to_epoch(value):
    if not value:
        return int(time.time())
    try:
        return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except Exception:
        return int(time.time())


def parse_duration(text):
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([hms])", text or ""):
        total += int(value) * {"h": 3600, "m": 60, "s": 1}[unit]
    return total


def parse_gcode_tail(text):
    out = {}
    m = RE_FIL_MM.search(text)
    if m:
        try:
            out["filament_mm"] = sum(float(x) for x in m.group(1).split(","))
        except ValueError:
            pass
    m = RE_FIL_CM3.search(text)
    if m:
        try:
            out["filament_cm3"] = sum(float(x) for x in m.group(1).split(","))
        except ValueError:
            pass
    m = RE_FIL_G.search(text)
    if m:
        try:
            out["filament_g"] = float(m.group(1))
        except ValueError:
            pass
    m = RE_TIME.search(text)
    if m:
        out["print_time"] = parse_duration(m.group(1))
    # Colores/materiales del perfil de filamento (Orca/Prusa). No se filtran a
    # los realmente usados (eso requeriria escanear el cuerpo completo del
    # gcode); el visor de capas ya determina el color activo por capa leyendo
    # los T<n> reales de cada trozo que descarga.
    m = RE_FIL_COLOUR.search(text) or RE_FIL_MULTI_COLOUR.search(text)
    if m:
        colors = [c.strip().lstrip("#") for c in m.group(1).split(";") if c.strip()]
        if colors:
            out["filament_colors"] = colors
    m = RE_FIL_TYPE.search(text)
    if m:
        materials = [t.strip() for t in re.split(r"[;,]", m.group(1)) if t.strip()]
        if materials:
            out["filament_materials"] = materials
    return out


def parse_gcode_head(text):
    out = {}
    m = RE_MAXZ.search(text)
    if m:
        try:
            out["height"] = float(m.group(1))
        except ValueError:
            pass
    m = RE_LAYER_N.search(text)
    if m:
        out["layers"] = int(m.group(1))
    return out


def dims_from_svg(b64):
    if not b64:
        return None
    try:
        svg = base64.b64decode(b64).decode("utf-8", "ignore")
    except Exception:
        return None
    coords = RE_SVG_COORD.findall(svg)
    if not coords:
        return None
    xs = [float(x) for x, _ in coords]
    ys = [float(y) for _, y in coords]
    return {
        "width": round(max(xs) - min(xs), 2),
        "depth": round(max(ys) - min(ys), 2),
    }


class KxState:
    def __init__(self, session):
        self.session = session
        self._data = {}
        self._ts = 0.0
        self._lock = asyncio.Lock()

    async def get(self, force=False):
        async with self._lock:
            now = time.monotonic()
            if not force and (now - self._ts) < CACHE_TTL and self._data:
                return self._data
            try:
                async with self.session.get(
                    f"{KX_URL}/api/state",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        self._data = await resp.json()
                        self._ts = now
                    else:
                        log.warning("KX /api/state HTTP %s", resp.status)
            except Exception as exc:
                log.warning("KX /api/state error: %s", exc)
            return self._data


class KxFiles:
    def __init__(self, session):
        self.session = session
        self._data = []
        self._ts = 0.0
        self._lock = asyncio.Lock()
        self._analysis = {}
        self._layers = {}
        self._layer_tools = {}
        self._layer_pauses = {}
        self._layer_locks = {}
        # Los renders 3D/2D en si NO se guardan en RAM (ver
        # _render_cache_paths/_render_both) -- solo los locks, para que dos
        # peticiones simultaneas del mismo fichero no lo descarguen/parseen
        # dos veces en paralelo.
        self._render_locks = {}

    async def get(self, force=False):
        async with self._lock:
            now = time.monotonic()
            if not force and (now - self._ts) < FILES_TTL and self._data:
                return self._data
            try:
                async with self.session.get(
                    f"{KX_URL}/kx/files",
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        result = payload.get("result")
                        if isinstance(result, list):
                            self._data = result
                            self._ts = now
                    else:
                        log.warning("KX /kx/files HTTP %s", resp.status)
            except Exception as exc:
                log.warning("KX /kx/files error: %s", exc)
            return self._data

    async def upload(self, filename, file_bytes):
        """Sube un gcode a KX-Bridge (mismo endpoint que usa su propia UI,
        /server/files/upload) y refresca el listado para que el fichero
        aparezca de inmediato. Compartido por el upload propio de KXDeck
        (/api/kxdeck/files/upload) y por el endpoint compatible OctoPrint
        (/api/files/local) que usan los plugins "print host upload" de los
        slicers (OrcaSlicer/PrusaSlicer)."""
        form = aiohttp.FormData()
        form.add_field("file", file_bytes, filename=filename, content_type="application/octet-stream")
        async with self.session.post(
            f"{KX_URL}/server/files/upload",
            data=form,
            timeout=aiohttp.ClientTimeout(total=180),
        ) as resp:
            txt = await resp.text()
            log.info("upload %s -> HTTP %s %s", filename, resp.status, txt[:200])
            if resp.status >= 400:
                raise RuntimeError(txt[:200])
        await self.get(force=True)

    async def find_by_name(self, filename):
        for entry in await self.get():
            if entry.get("filename") == filename:
                return entry
        for entry in await self.get(force=True):
            if entry.get("filename") == filename:
                return entry
        return None

    async def find_by_id(self, file_id):
        for entry in await self.get():
            if entry.get("id") == file_id:
                return entry
        return None

    def cached_analysis(self, file_id):
        return self._analysis.get(file_id, {})

    async def analyze(self, entry):
        """Lee cabecera y pie del gcode via Range. Cachea por id."""
        file_id = entry.get("id")
        if not file_id:
            return {}
        if file_id in self._analysis:
            return self._analysis[file_id]

        size = entry.get("size_bytes") or 0
        url = f"{KX_URL}/kx/files/{file_id}/download"
        result = {}

        try:
            async with self.session.get(
                url,
                headers={"Range": "bytes=0-8191"},
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                if resp.status in (200, 206):
                    raw = await resp.content.read(8192)
                    result.update(parse_gcode_head(raw.decode("utf-8", "ignore")))
        except Exception as exc:
            log.debug("head analysis %s: %s", file_id, exc)

        try:
            start = max(0, size - TAIL_BYTES)
            async with self.session.get(
                url,
                headers={"Range": f"bytes={start}-"},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 206:
                    raw = await resp.read()
                    result.update(parse_gcode_tail(raw.decode("utf-8", "ignore")))
                elif resp.status == 200:
                    buf = b""
                    async for chunk in resp.content.iter_chunked(65536):
                        buf = (buf + chunk)[-TAIL_BYTES:]
                    result.update(parse_gcode_tail(buf.decode("utf-8", "ignore")))
        except Exception as exc:
            log.debug("tail analysis %s: %s", file_id, exc)

        self._analysis[file_id] = result
        return result

    def cached_layer_offsets(self, file_id):
        """Solo cache, no dispara indexado ni bloquea. None = aun no indexado
        (o fallo previo)."""
        return self._layers.get(file_id)

    def ensure_layer_offsets(self, entry):
        """Dispara la indexacion en segundo plano si hace falta, sin esperar
        el resultado. Usar en rutas 'calientes' (websocket, /api/job) para
        que nunca se queden colgadas esperando a indexar un fichero grande;
        el visor de gcode (accion explicita del usuario) sigue usando
        layer_offsets() normal, que si espera."""
        file_id = entry.get("id")
        if not file_id or not LAYER_INDEX or file_id in self._layers:
            return
        lock = self._layer_locks.get(file_id)
        if lock is not None and lock.locked():
            return
        asyncio.create_task(self.layer_offsets(entry))

    async def layer_offsets(self, entry):
        """Indice capa -> offset de byte. Requiere leer el fichero entero,
        asi que solo se hace bajo demanda (fichero en impresion o visor de
        capas) y se cachea."""
        file_id = entry.get("id")
        if not file_id or not LAYER_INDEX:
            return None
        if file_id in self._layers:
            return self._layers[file_id]

        lock = self._layer_locks.setdefault(file_id, asyncio.Lock())
        async with lock:
            if file_id in self._layers:
                return self._layers[file_id]

            log.info("indexando capas de %s", entry.get("filename"))
            started = time.monotonic()
            offsets = []
            pos = 0
            carry = b""
            # Barrido independiente (propio carry, propia guarda anti-
            # duplicados) para los cambios de herramienta "Tn", en la MISMA
            # pasada de red que ya localiza los marcadores de capa -- ver
            # comentario de _TOOL_RE. last_tool_pos evita contar dos veces un
            # mismo cambio si cae dentro de la zona de solape entre chunks.
            tool_events = []
            carry_tool = b""
            last_tool_pos = -1
            # Mismo patron que el barrido de herramientas, pero para pausas
            # embebidas por el slicer (_PAUSE_RE) -- offsets de bytes, no
            # capa todavia (se resuelve mas abajo, cuando ya se conocen
            # TODOS los limites de capa, via bisect).
            pause_events = []
            carry_pause = b""
            last_pause_pos = -1
            try:
                async with self.session.get(
                    f"{KX_URL}/kx/files/{file_id}/download",
                    timeout=aiohttp.ClientTimeout(total=180, sock_read=60),
                ) as resp:
                    if resp.status != 200:
                        log.warning("indexado %s HTTP %s", file_id, resp.status)
                        self._layers[file_id] = None
                        return None
                    async for chunk in resp.content.iter_chunked(262144):
                        buf = carry + chunk
                        base = pos - len(carry)
                        idx = 0
                        while True:
                            found = buf.find(LAYER_MARKER, idx)
                            if found == -1:
                                break
                            offsets.append(base + found)
                            idx = found + 1
                        keep = len(LAYER_MARKER) - 1
                        carry = buf[-keep:] if keep else b""

                        buf_tool = carry_tool + chunk
                        base_tool = pos - len(carry_tool)
                        for m in _TOOL_RE.finditer(buf_tool):
                            abs_pos = base_tool + m.start(1) - 1
                            if abs_pos <= last_tool_pos:
                                continue
                            last_tool_pos = abs_pos
                            tool_events.append((abs_pos, int(m.group(1))))
                        carry_tool = buf_tool[-32:]

                        buf_pause = carry_pause + chunk
                        base_pause = pos - len(carry_pause)
                        for m in _PAUSE_RE.finditer(buf_pause):
                            abs_pos = base_pause + m.start(1)
                            if abs_pos <= last_pause_pos:
                                continue
                            last_pause_pos = abs_pos
                            pause_events.append(abs_pos)
                        carry_pause = buf_pause[-32:]

                        pos += len(chunk)
            except Exception as exc:
                log.warning("indexado %s error: %s", file_id, exc)
                self._layers[file_id] = None
                return None

            tool_at_offset = []
            ti = 0
            cur_tool = 0
            for off in offsets:
                while ti < len(tool_events) and tool_events[ti][0] <= off:
                    cur_tool = tool_events[ti][1]
                    ti += 1
                tool_at_offset.append(cur_tool)

            # Offset de bytes -> indice de capa (0-based, mismo indice que
            # "offsets"): la capa a la que pertenece un offset es la ULTIMA
            # cuyo propio offset de inicio no lo supera -- bisect_right da
            # exactamente esa posicion de insercion. set() por si dos M600
            # seguidos (p.ej. M600 + M601) cayeran en la misma capa.
            pause_layers = sorted({max(0, bisect.bisect_right(offsets, off) - 1) for off in pause_events}) if offsets else []

            self._layers[file_id] = offsets
            self._layer_tools[file_id] = tool_at_offset
            self._layer_pauses[file_id] = pause_layers
            log.info(
                "indexado %s: %s capas en %.1fs%s",
                entry.get("filename"), len(offsets), time.monotonic() - started,
                f", {len(pause_layers)} pausa(s) de gcode" if pause_layers else "",
            )
            return offsets

    def layer_start_tools(self, file_id):
        """Herramienta activa al inicio de cada capa (mismo indice que
        layer_offsets), o [] si aun no se ha indexado. Solo cache -- se
        rellena como efecto secundario de layer_offsets(), llamar despues de
        esperar a esa funcion."""
        return self._layer_tools.get(file_id) or []

    def layer_pause_points(self, file_id):
        """Capas (0-based) donde el propio gcode trae una pausa embebida
        (M600/M601, ver _PAUSE_RE) -- distintas de las pausas programadas
        por KXDeck. Solo cache, igual que layer_start_tools; [] tanto si
        el fichero aun no se ha indexado como si no tiene ninguna."""
        return self._layer_pauses.get(file_id) or []

    def _tool_colors_for(self, entry):
        """slot_index -> color_hex de los paints REALMENTE usados. Misma
        fuente y mismo filtro que parseUsedFilamentChannels en
        frontend/src/lib/filamentChannels.ts (duplicacion intencional
        Python/TS: si se cambia el filtro alli, replicar aqui)."""
        raw = entry.get("gcode_filaments")
        if not raw:
            return {}
        try:
            channels = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return {
            c["slot_index"]: c["color_hex"]
            for c in channels
            if isinstance(c, dict) and c.get("is_used") is not False and "slot_index" in c and c.get("color_hex")
        }

    async def _render_both(self, entry):
        """Genera (o lee de CACHE EN DISCO, ver _render_cache_paths) el
        render 3D interactivo de la pieza entera (todas las capas, sin
        soportes) y su version 2D -- ambas salen del mismo parseo, asi que
        no hace falta descargar el fichero dos veces. Devuelve (buf3d,
        buf2d), cualquiera de los dos None si algo fallo.

        A diferencia de antes, el resultado NO se queda en RAM despues de
        esta llamada -- se escribe a disco (o ya estaba) y se devuelve tal
        cual; en cuanto termina de servirse la peticion que lo pidio, Python
        libera esa memoria. Con ~80 ficheros en la biblioteca (algunos de
        hasta ~350MB de render), guardarlos TODOS en RAM indefinidamente
        sumaba ~2GB permanentes en un Pi que comparte memoria con otros ~20
        contenedores -- ver tambien prewarm_renders."""
        file_id = entry.get("id")
        if not file_id:
            return None, None

        lock = self._render_locks.setdefault(file_id, asyncio.Lock())
        async with lock:
            loop = asyncio.get_event_loop()
            # Lectura de disco tambien fuera del event loop: un fichero de
            # ~350MB tarda lo suyo incluso solo para leerlo.
            cached = await loop.run_in_executor(None, _read_render_cache, file_id)
            if cached is not None:
                return cached

            log.info("renderizando %s", entry.get("filename"))
            started = time.monotonic()
            buf = bytearray()
            try:
                async with self.session.get(
                    f"{KX_URL}/kx/files/{file_id}/download",
                    timeout=aiohttp.ClientTimeout(total=300, sock_read=120),
                ) as resp:
                    if resp.status != 200:
                        log.warning("render %s HTTP %s", file_id, resp.status)
                        return None, None
                    async for chunk in resp.content.iter_chunked(1 << 20):
                        buf.extend(chunk)
            except Exception as exc:
                log.warning("render %s descarga error: %s", file_id, exc)
                return None, None

            tool_colors = self._tool_colors_for(entry)
            layer_height = entry.get("layer_height")
            try:
                # CPU-bound (parseo linea a linea de un fichero potencialmente
                # enorme): fuera del event loop para no bloquear el resto de
                # peticiones mientras se genera.
                result3d, result2d = await loop.run_in_executor(
                    None, _build_render_buffers_niced, bytes(buf), tool_colors, BED_WIDTH, BED_HEIGHT, layer_height
                )
            except Exception as exc:
                log.error("render %s parseo error: %s", file_id, exc)
                return None, None

            await loop.run_in_executor(None, _write_render_cache, file_id, result3d, result2d)
            log.info(
                "render %s: %.1f MB (3D) + %.1f MB (2D) en %.1fs",
                entry.get("filename"), len(result3d) / 1e6, len(result2d) / 1e6, time.monotonic() - started,
            )
            return result3d, result2d

    async def render_preview(self, entry):
        """Render 3D interactivo de la pieza entera -- ver _render_both."""
        result3d, _ = await self._render_both(entry)
        return result3d

    async def render_preview_2d(self, entry):
        """Version 2D (vista cenital/isometrica, ver gcode_render.py) del
        render de arriba -- ver _render_both."""
        _, result2d = await self._render_both(entry)
        return result2d

    async def prewarm(self):
        """Analiza todos los ficheros para que el listado tenga datos."""
        entries = await self.get(force=True)
        pending = [e for e in entries if e.get("id") not in self._analysis]
        if not pending:
            return
        log.info("precalentando analisis de %s ficheros", len(pending))
        started = time.monotonic()
        sem = asyncio.Semaphore(4)

        async def one(entry):
            async with sem:
                try:
                    await self.analyze(entry)
                except Exception as exc:
                    log.debug("prewarm %s: %s", entry.get("id"), exc)

        await asyncio.gather(*(one(e) for e in pending))
        log.info(
            "analisis completo: %s ficheros en %.1fs",
            len(pending), time.monotonic() - started,
        )

    async def prewarm_renders(self):
        """Genera el render de todos los ficheros por adelantado y lo deja
        en CACHE DE DISCO (ver _render_cache_paths): el usuario no debe
        tener que esperar a que se genere al abrir una pieza. Secuencial (no
        concurrente, a diferencia de prewarm()): un fichero grande ya puede
        necesitar >1GB de RAM TRANSITORIA durante el parseo (ver
        _render_both), y solapar varios a la vez en un Pi con RAM limitada
        no es buena idea. Ficheros que ya estan en la cache de disco de una
        pasada anterior (o de antes de un reinicio del contenedor, mientras
        el volumen persista) se saltan sin ni siquiera abrir un lock."""
        entries = await self.get()
        pending = [e for e in entries if e.get("id") and not _render_cache_exists(e["id"])]
        if not pending:
            return
        log.info("precalentando render de %s ficheros (cache en disco)", len(pending))
        started = time.monotonic()
        for entry in pending:
            try:
                await self._render_both(entry)
            except Exception as exc:
                log.warning("prewarm render %s: %s", entry.get("id"), exc)
        log.info(
            "render precalentado: %s ficheros en %.1fs",
            len(pending), time.monotonic() - started,
        )


class KxHistory:
    def __init__(self, session):
        self.session = session
        self._jobs = []
        self._ts = 0.0
        self._lock = asyncio.Lock()

    async def get(self, force=False):
        async with self._lock:
            now = time.monotonic()
            if not force and (now - self._ts) < FILES_TTL and self._jobs:
                return self._jobs
            try:
                async with self.session.get(
                    f"{KX_URL}/server/history/list",
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        jobs = (payload.get("result") or {}).get("jobs")
                        if isinstance(jobs, list):
                            self._jobs = jobs
                            self._ts = now
            except Exception as exc:
                log.warning("KX history error: %s", exc)
            return self._jobs

    async def stats_for(self, filename):
        done = failed = 0
        last = None
        for job in await self.get():
            if job.get("filename") != filename:
                continue
            status = (job.get("status") or "").lower()
            if status == "completed":
                done += 1
            elif status in ("cancelled", "error", "failed"):
                failed += 1
            if last is None:
                last = job
        return {"success": done, "failure": failed, "last": last}


class TempHistory:
    """Historial de temperaturas en el servidor (no en el cliente): asi el
    grafico no se pierde/aplana cada vez que se recarga la pagina o se abre
    en otro dispositivo. Se alimenta desde tracker_loop (una muestra/seg)."""

    def __init__(self, maxlen=180):
        self._nozzle = deque(maxlen=maxlen)
        self._bed = deque(maxlen=maxlen)

    def record(self, nozzle_temp, bed_temp):
        self._nozzle.append(nozzle_temp)
        self._bed.append(bed_temp)

    def as_dict(self):
        return {
            "nozzle_history": list(self._nozzle),
            "bed_history": list(self._bed),
        }


class LayerTracker:
    """Estima en que fraccion de la capa actual vamos, por tiempo.

    Usa el reloj local (time.monotonic) porque print_duration del bridge
    solo tiene resolucion de minutos y no sirve para interpolar.

    La medicion de duraciones se hace en observe(), que debe llamarse desde
    un unico sitio (tracker_loop). fraction() es solo consulta y puede
    llamarse tantas veces como haga falta sin alterar el estado.

    Aproximacion deliberada: asume velocidad constante dentro de la capa.
    El punto mostrado es plausible, no exacto.
    """

    def __init__(self):
        self._file = None
        self._layer = None
        self._layer_start = None
        self._durations = []
        self._first = True

    def observe(self, filename, layer):
        """Registra el cambio de capa. Llamar solo desde el refresco."""
        if not filename or not layer:
            return
        now = time.monotonic()
        if filename != self._file:
            self._file = filename
            self._layer = layer
            self._layer_start = now
            self._durations = []
            self._first = True
            return

        if layer != self._layer:
            if self._layer is not None and self._layer_start is not None and layer > self._layer:
                dur = now - self._layer_start
                if self._first:
                    # La primera medida arranca a mitad de capa: no vale.
                    self._first = False
                    dur = 0
                if 1.0 < dur < 3600:
                    self._durations.append(dur)
                    if len(self._durations) > 10:
                        self._durations.pop(0)
                    if DEBUG_LAYER:
                        log.info(
                            "tracker: capa %s -> %s en %.1fs (media %.1fs de %s muestras)",
                            self._layer, layer, dur,
                            sum(self._durations) / len(self._durations),
                            len(self._durations),
                        )
            self._layer = layer
            self._layer_start = now

    def reset(self):
        self._file = None
        self._layer = None
        self._layer_start = None
        self._durations = []
        self._first = True

    def fraction(self, filename, layer):
        """Fraccion estimada de la capa actual. Solo lectura."""
        if filename != self._file or layer != self._layer:
            return 0.0
        if not self._durations or self._layer_start is None:
            return 0.0
        avg = sum(self._durations) / len(self._durations)
        if avg <= 0:
            return 0.0
        return max(0.0, min((time.monotonic() - self._layer_start) / avg, 0.99))


_PAUSE_SCHEDULE_DATA_DIR = os.environ.get("KXDECK_DATA_DIR", "/app/data")
_PAUSE_SCHEDULE_PATH = os.path.join(_PAUSE_SCHEDULE_DATA_DIR, "pause_schedule.json")


class PauseSchedule:
    """Pausas programadas (por capa o por tiempo transcurrido) para la
    impresion activa. Ligada al fichero en curso -- se vacia sola en cuanto
    cambia el fichero que esta imprimiendo (igual que LayerTracker), y con
    reset() explicito al cancelar.

    Persistida en disco (pause_schedule.json, mismo patron que
    general_settings.py/ha_settings.py -- volumen ./data ya montado en
    docker-compose.yml) porque, a diferencia de LayerTracker, esto SI son
    datos que el usuario ha introducido a mano: perderlos en cualquier
    reinicio del contenedor (un redeploy, un crash) seria tirar trabajo
    suyo, no solo un cache que se puede recalcular solo.

    check() es la unica que muta el estado "disparado" y debe llamarse solo
    desde tracker_loop (mismo patron que LayerTracker.observe()); list()/
    add()/remove() son para los endpoints REST."""

    def __init__(self):
        self._file = None
        self._entries = []
        self._next_id = 1
        self._load()

    def _load(self):
        try:
            with open(_PAUSE_SCHEDULE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return
        self._file = data.get("file")
        self._entries = data.get("entries") or []
        self._next_id = data.get("next_id") or (max((e["id"] for e in self._entries), default=0) + 1)

    def _save(self):
        os.makedirs(_PAUSE_SCHEDULE_DATA_DIR, exist_ok=True)
        tmp_path = _PAUSE_SCHEDULE_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(
                {"file": self._file, "entries": self._entries, "next_id": self._next_id},
                f, indent=2, ensure_ascii=False,
            )
        os.replace(tmp_path, _PAUSE_SCHEDULE_PATH)

    def _ensure_file(self, filename):
        if filename != self._file:
            self._file = filename
            self._entries = []
            self._save()

    def list(self, filename):
        self._ensure_file(filename)
        return [dict(e) for e in self._entries]

    def add(self, filename, kind, value):
        self._ensure_file(filename)
        entry = {"id": self._next_id, "kind": kind, "value": value, "triggered": False}
        self._next_id += 1
        self._entries.append(entry)
        self._save()
        return dict(entry)

    def remove(self, entry_id):
        before = len(self._entries)
        self._entries = [e for e in self._entries if e["id"] != entry_id]
        changed = len(self._entries) != before
        if changed:
            self._save()
        return changed

    def reset(self):
        self._file = None
        self._entries = []
        self._save()

    def check(self, filename, curr_layer, elapsed_seconds):
        """Si alguna entrada pendiente ya toca, la marca disparada y la
        devuelve (una por llamada, para no lanzar mas de una pausa a la
        vez). None si no toca ninguna."""
        self._ensure_file(filename)
        for entry in self._entries:
            if entry["triggered"]:
                continue
            if entry["kind"] == "layer" and curr_layer >= entry["value"]:
                entry["triggered"] = True
                self._save()
                return entry
            if entry["kind"] == "time" and elapsed_seconds >= entry["value"]:
                entry["triggered"] = True
                self._save()
                return entry
        return None


_GCODE_PAUSE_SKIPS_PATH = os.path.join(_PAUSE_SCHEDULE_DATA_DIR, "gcode_pause_skips.json")


class GcodePauseSkips:
    """Que capas con una pausa EMBEBIDA en el propio gcode (M600/M601, ver
    KxFiles.layer_pause_points) ha decidido saltarse el usuario -- ligado al
    fichero en curso, igual que PauseSchedule (y persistido con el mismo
    criterio: es una decision suya, no un cache que se pueda recalcular).

    No hay forma de "quitar" un M600 ya horneado en el fichero -- en vez de
    eso, cuando esa pausa de verdad se dispare, tracker_loop la reconoce
    aqui (is_skipped) y manda reanudar de inmediato, lo antes posible en
    vez de esperar a que alguien pulse Reanudar a mano (ver tracker_loop en
    printer_control.py). already_resumed/mark_resumed evitan reintentar el
    resume en cada sondeo de 1s mientras dure esa misma pausa -- no hace
    falta persistirlo (si el contenedor se reiniciase justo en ese
    instante, el peor caso es un segundo intento de resume, inofensivo)."""

    def __init__(self):
        self._file = None
        self._layers = set()
        self._resumed = set()
        self._load()

    def _load(self):
        try:
            with open(_GCODE_PAUSE_SKIPS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return
        self._file = data.get("file")
        self._layers = set(data.get("layers") or [])

    def _save(self):
        os.makedirs(_PAUSE_SCHEDULE_DATA_DIR, exist_ok=True)
        tmp_path = _GCODE_PAUSE_SKIPS_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"file": self._file, "layers": sorted(self._layers)}, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, _GCODE_PAUSE_SKIPS_PATH)

    def _ensure_file(self, filename):
        if filename != self._file:
            self._file = filename
            self._layers = set()
            self._resumed = set()
            self._save()

    def skip(self, filename, layer):
        self._ensure_file(filename)
        self._layers.add(layer)
        self._save()

    def is_skipped(self, filename, layer):
        self._ensure_file(filename)
        return layer in self._layers

    def mark_resumed(self, layer):
        self._resumed.add(layer)

    def already_resumed(self, layer):
        return layer in self._resumed
