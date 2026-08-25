export interface AccentPreset {
  name: string;
  label: string;
  400: string;
  500: string;
  600: string;
  700: string;
}

// Mismos tonos que la paleta de Tailwind, para que el resto del diseño
// (grises, espaciados...) siga encajando elijas el que elijas.
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "teal", label: "Teal", 400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 700: "#0f766e" },
  { name: "blue", label: "Azul", 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8" },
  { name: "violet", label: "Violeta", 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9" },
  { name: "pink", label: "Rosa", 400: "#f472b6", 500: "#ec4899", 600: "#db2777", 700: "#be185d" },
  { name: "orange", label: "Naranja", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 700: "#c2410c" },
  { name: "emerald", label: "Esmeralda", 400: "#34d399", 500: "#10b981", 600: "#059669", 700: "#047857" },
  { name: "rose", label: "Rojo", 400: "#fb7185", 500: "#f43f5e", 600: "#e11d48", 700: "#be123c" },
  { name: "amber", label: "Ambar", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 700: "#b45309" },
];

export const DEFAULT_ACCENT = "teal";

export function applyAccent(name: string) {
  const preset = ACCENT_PRESETS.find((p) => p.name === name) ?? ACCENT_PRESETS[0];
  const root = document.documentElement.style;
  root.setProperty("--accent-400", preset[400]);
  root.setProperty("--accent-500", preset[500]);
  root.setProperty("--accent-600", preset[600]);
  root.setProperty("--accent-700", preset[700]);
  // "--accent" (sin sufijo) es la variable nativa de KX-Bridge (botones,
  // bordes activos, logo del header...): tenerla en el mismo :root hace que
  // elegir acento recoloree tambien el propio panel de KX-Bridge, no solo
  // las tarjetas inyectadas de KXDeck.
  root.setProperty("--accent", preset[500]);
}
