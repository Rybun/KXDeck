const FEATURE_RULES: [RegExp, string][] = [
  [/outer/i, "#fbbf24"],
  [/inner/i, "#38bdf8"],
  [/bridge/i, "#f472b6"],
  [/top/i, "#fb923c"],
  [/bottom/i, "#fb923c"],
  [/support/i, "#34d399"],
  [/skirt|brim/i, "#94a3b8"],
  [/infill/i, "#a78bfa"],
];
const DEFAULT_FEATURE_COLOR = "#9ca3af";

export function colorForFeature(type: string): string {
  for (const [re, color] of FEATURE_RULES) {
    if (re.test(type)) return color;
  }
  return DEFAULT_FEATURE_COLOR;
}

const TOOL_PALETTE = ["#fbbf24", "#38bdf8", "#f472b6", "#34d399", "#a78bfa", "#f87171", "#fb923c", "#94a3b8"];

/** colorsByTool: slot_index (=tool) -> color_hex, solo de los paints
 * realmente usados (misma fuente que el dialogo de asignar colores, ver
 * lib/filamentChannels.ts). Antes se usaba la lista cruda de colores del
 * perfil del slicer (hasta 32 entradas aunque el fichero solo use 2-3),
 * lo que hacia que el visor mostrara mas colores de los que luego salian
 * en el selector. */
export function colorForTool(tool: number, colorsByTool: Record<number, string>): string {
  if (colorsByTool[tool]) return colorsByTool[tool];
  return TOOL_PALETTE[tool % TOOL_PALETTE.length];
}
