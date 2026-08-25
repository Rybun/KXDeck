import { useEffect, useState } from "react";
import { wsUrl } from "../api/client";
import type { KxDeckWsMessage } from "../api/types";

// El backend manda un mensaje cada 1.5s. Si no llega nada en este margen,
// asumimos que el socket esta "zombi" (Cloudflare u otro proxy lo corto sin
// mandar un frame de cierre limpio, algo habitual con moviles en segundo
// plano) y forzamos la reconexion en vez de esperar a un onclose que puede
// no llegar nunca.
const STALE_MS = 8000;
const WATCHDOG_INTERVAL_MS = 3000;

export function useKxState() {
  const [data, setData] = useState<KxDeckWsMessage | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByEffect = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    let retryCount = 0;
    let lastMessageAt = Date.now();
    // Cada conexion tiene su generacion: al reemplazarla (watchdog/foreground)
    // el socket viejo queda invalidado y su onclose asincrono ya no dispara
    // una reconexion duplicada por encima de la nueva conexion buena.
    let generation = 0;

    function scheduleReconnect() {
      if (closedByEffect) return;
      clearTimeout(retryTimer);
      const delay = Math.min(1000 * 2 ** retryCount, 15000);
      retryCount += 1;
      retryTimer = setTimeout(connect, delay);
    }

    function connect() {
      clearTimeout(retryTimer);
      const myGen = ++generation;
      ws?.close();
      lastMessageAt = Date.now();

      const socket = new WebSocket(wsUrl("/api/kxdeck/ws"));
      ws = socket;

      socket.onopen = () => {
        if (myGen !== generation) return;
        retryCount = 0;
        lastMessageAt = Date.now();
        setConnected(true);
      };
      socket.onmessage = (ev) => {
        if (myGen !== generation) return;
        lastMessageAt = Date.now();
        try {
          setData(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frame */
        }
      };
      socket.onclose = () => {
        if (myGen !== generation) return;
        setConnected(false);
        scheduleReconnect();
      };
      socket.onerror = () => {
        socket.close();
      };
    }

    function checkHealth() {
      if (closedByEffect) return;
      const isStale = ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_MS;
      if (isStale || ws?.readyState === WebSocket.CLOSED) {
        setConnected(false);
        connect();
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") checkHealth();
    }

    connect();
    watchdogTimer = setInterval(checkHealth, WATCHDOG_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      closedByEffect = true;
      generation += 1;
      clearTimeout(retryTimer);
      clearInterval(watchdogTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      ws?.close();
    };
  }, []);

  return { data, connected };
}
