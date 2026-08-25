const API_KEY_STORAGE = "kxdeck.apiKey";

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? "";
}

export function setApiKey(key: string) {
  localStorage.setItem(API_KEY_STORAGE, key);
}

/** Descubre la API key configurada en el servidor (variable API_KEY del
 * contenedor) via /api/login, un endpoint sin autenticar pensado justo para
 * este bootstrap. Evita que el usuario tenga que teclearla.
 * Reintenta varias veces: dentro de navegadores embebidos (p.ej. el panel
 * "Device" de OrcaSlicer) un fallo de red puntual en el primer intento no
 * debe acabar pidiendole la clave a mano -- la propia /api/login ya la
 * entrega sin autenticar, asi que no tiene sentido bloquear la UI por eso. */
export async function bootstrapApiKey(attempts = 5): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.apikey === "string" && data.apikey) return data.apikey;
      }
    } catch {
      // red no lista todavia (p.ej. justo tras un reinicio) -- se reintenta
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function headers(): HeadersInit {
  const key = getApiKey();
  return key ? { "X-Api-Key": key, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 403) {
    throw new Error("API key invalida");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  return unwrap<T>(res);
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return unwrap<T>(res);
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE", headers: headers() });
  return unwrap<T>(res);
}

export async function apiUpload(path: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file, file.name);
  const key = getApiKey();
  const res = await fetch(path, {
    method: "POST",
    headers: key ? { "X-Api-Key": key } : undefined,
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const key = getApiKey();
  const qs = key ? `?apikey=${encodeURIComponent(key)}` : "";
  return `${proto}//${window.location.host}${path}${qs}`;
}
