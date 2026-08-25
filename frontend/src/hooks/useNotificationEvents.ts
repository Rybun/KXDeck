import { useEffect, useRef } from "react";
import type { KxDeckWsMessage } from "../api/types";
import { getNotificationPrefs } from "./useNotificationPrefs";

// "Primera capa completada": curr_layer pasa de por debajo de este umbral a
// por encima (la capa 1 ya quedo atras). El backend no emite un evento
// dedicado para esto (ver diagnostico en octoprint_api.py/tracker_loop) --
// es una aproximacion sobre el numero de capa ya expuesto, ajustable aqui
// si la numeracion real observada en una impresion en curso no encaja.
const FIRST_LAYER_THRESHOLD = 2;

// TODO: notificaciones desactivadas -- el disparo no era fiable. La UI
// (Settings.tsx / NotificationSettingsCard en entry.tsx) ya se ensena en
// gris; este flag es defensa en profundidad por si alguien tuviera
// "enabled" ya guardado en localStorage de antes. Revisar y volver a poner
// a true cuando se solucione.
const NOTIFICATIONS_ENABLED = false;

function notify(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "/favicon.svg" });
  } catch {
    // Notification puede lanzar en algunos navegadores/contextos -- no es
    // critico, se ignora en vez de romper el resto de la app.
  }
}

/** Detecta transiciones de estado de impresion comparando cada mensaje del
 * websocket con el anterior (el backend solo manda snapshots completos, no
 * eventos discretos -- ver kxdeck_api.py/h_kxdeck_ws) y dispara
 * notificaciones de navegador segun las preferencias guardadas en Ajustes.
 * Se instancia UNA vez, junto a useKxState (ver Layout.tsx). */
export function useNotificationEvents(data: KxDeckWsMessage | null) {
  const prevRef = useRef<KxDeckWsMessage | null>(null);

  useEffect(() => {
    if (!data) return;
    const prev = prevRef.current;
    prevRef.current = data;
    if (!prev) return; // primer mensaje: nada con que comparar todavia
    if (!NOTIFICATIONS_ENABLED) return;

    const prefs = getNotificationPrefs();
    if (!prefs.enabled) return;

    const wasActive = prev.state.flags.printing || prev.state.flags.paused;
    const isActive = data.state.flags.printing || data.state.flags.paused;
    const wasPaused = prev.state.flags.paused;
    const isPaused = data.state.flags.paused;
    const isPrinting = data.state.flags.printing;
    const filename = data.job.file.name ?? "la impresion";

    if (!wasActive && isActive) {
      if (prefs.started) notify("Impresion iniciada", filename);
    } else if (wasActive && !isActive) {
      if (prefs.stopped) notify("Impresion detenida", filename);
    } else if (!wasPaused && isPaused) {
      if (prefs.paused) notify("Impresion pausada", filename);
    } else if (wasPaused && !isPaused && isPrinting) {
      if (prefs.resumed) notify("Impresion reanudada", filename);
    }

    if (prefs.firstLayer && isPrinting) {
      const prevLayer = Number(prev.kx.curr_layer) || 0;
      const currLayer = Number(data.kx.curr_layer) || 0;
      if (prevLayer < FIRST_LAYER_THRESHOLD && currLayer >= FIRST_LAYER_THRESHOLD) {
        notify("Primera capa completada", filename);
      }
    }
  }, [data]);
}
