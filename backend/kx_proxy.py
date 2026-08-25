"""Proxy inverso generico hacia KX-Bridge (KX_URL). Es el catch-all final de
la aplicacion (ver register en app.py): cualquier ruta que KXDeck no
reclame explicitamente con un endpoint propio cae aqui y se reenvia tal
cual a KX-Bridge, en streaming y sin traducir nada -- asi un endpoint suyo
nuevo (o uno ya existente que a KXDeck no le interesaba reimplementar)
funciona directamente, incluso tras una actualizacion de KX-Bridge que
KXDeck no conoce todavia.

La home (/) es un caso mas especifico con su propia logica de insercion de
HTML y no pasa por aqui -- ver kx_home.py."""

import asyncio

import aiohttp
from aiohttp import web

from config import KX_URL, log

# Cabeceras que no tiene sentido reenviar tal cual (dependen del transporte
# HTTP en si, no del contenido) en ninguna de las dos direcciones.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "content-length", "content-encoding",
}


async def proxy_http(request):
    """Reenvia la peticion tal cual a KX_URL + la ruta pedida, y retransmite
    la respuesta en streaming (sin bufferizarla entera en memoria)."""
    target = f"{KX_URL}{request.path}"
    if request.query_string:
        target += f"?{request.query_string}"

    session = request.app["session"]
    body = await request.read()
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}

    try:
        upstream = await session.request(
            request.method,
            target,
            headers=fwd_headers,
            data=body or None,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10),
            allow_redirects=False,
        )
    except Exception as exc:
        log.error("kx-bridge proxy %s failed: %s", target, exc)
        return web.Response(status=502, text=f"kx-bridge proxy error: {exc}")

    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP}
    async with upstream:
        resp = web.StreamResponse(status=upstream.status, headers=out_headers)
        await resp.prepare(request)
        try:
            async for chunk in upstream.content.iter_any():
                await resp.write(chunk)
        except (ConnectionResetError, ConnectionAbortedError):
            pass  # el cliente cerro la conexion a medias, nada que hacer
        await resp.write_eof()
        return resp


async def proxy_websocket(request):
    """Relay bidireccional: KX-Bridge ya habla el protocolo que se le pida
    (JSON-RPC de Moonraker incluido) en su propio /websocket, asi que no
    hace falta reimplementar el dialogo -- solo retransmitir mensajes en
    ambos sentidos hasta que un lado cierre la conexion."""
    ws_scheme = "wss" if KX_URL.startswith("https") else "ws"
    target = f"{ws_scheme}://{KX_URL.split('://', 1)[1]}{request.path}"
    if request.query_string:
        target += f"?{request.query_string}"

    client_ws = web.WebSocketResponse(heartbeat=30)
    await client_ws.prepare(request)

    session = request.app["session"]
    try:
        async with session.ws_connect(target, heartbeat=30) as upstream_ws:
            async def client_to_upstream():
                async for msg in client_ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await upstream_ws.send_str(msg.data)
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        await upstream_ws.send_bytes(msg.data)
                    elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                        break

            async def upstream_to_client():
                async for msg in upstream_ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await client_ws.send_str(msg.data)
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        await client_ws.send_bytes(msg.data)
                    elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                        break

            t1 = asyncio.create_task(client_to_upstream())
            t2 = asyncio.create_task(upstream_to_client())
            try:
                await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
            finally:
                t1.cancel()
                t2.cancel()
    except Exception as exc:
        log.warning("kx-bridge ws proxy %s failed: %s", target, exc)
    return client_ws


async def h_catchall(request):
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await proxy_websocket(request)
    return await proxy_http(request)
