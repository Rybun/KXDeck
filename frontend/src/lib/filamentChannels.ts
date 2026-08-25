import type { FilamentChannel } from "../api/types";

/** Parsea gcode_filaments (JSON string) y se queda solo con los paints
 * realmente usados. Fuente de verdad unica: la usa tanto el dialogo de
 * asignar colores como el visor de gcode, para que ambos coincidan. */
export function parseUsedFilamentChannels(raw: string | null | undefined): FilamentChannel[] {
  if (!raw) return [];
  try {
    const parsed: FilamentChannel[] = JSON.parse(raw);
    return parsed.filter((c) => c.is_used !== false);
  } catch {
    return [];
  }
}

/** slot_index (=numero de tool/paint en el gcode) -> color_hex, solo para
 * los paints usados. */
export function filamentChannelsToColorMap(channels: FilamentChannel[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (const ch of channels) map[ch.slot_index] = ch.color_hex;
  return map;
}
