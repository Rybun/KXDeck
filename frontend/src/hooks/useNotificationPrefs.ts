import { useState } from "react";

export interface NotificationPrefs {
  enabled: boolean;
  firstLayer: boolean;
  started: boolean;
  stopped: boolean;
  paused: boolean;
  resumed: boolean;
}

const STORAGE_KEY = "kxdeck.notifications";

// Desactivadas por defecto: pedir permiso al navegador solo debe pasar por
// una accion explicita del usuario en Ajustes (ver checkbox maestro), no
// disparar sola al cargar la app.
const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  firstLayer: true,
  started: true,
  stopped: true,
  paused: true,
  resumed: true,
};

function load(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function save(prefs: NotificationPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// Lectura directa (sin hook): usada por useNotificationEvents, que no
// necesita re-renderizarse cuando cambian las preferencias, solo leerlas en
// cada mensaje del websocket.
export function getNotificationPrefs(): NotificationPrefs {
  return load();
}

export function useNotificationPrefs() {
  const [prefs, setPrefsState] = useState<NotificationPrefs>(load);

  function setPrefs(next: NotificationPrefs) {
    save(next);
    setPrefsState(next);
  }

  return { prefs, setPrefs };
}
