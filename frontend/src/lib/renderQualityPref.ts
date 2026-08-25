export type RenderQuality = "auto" | "alta" | "rendimiento";

const KEY = "kxdeck.renderQuality";

/** "auto" ajusta sombras/antialiasing/resolucion segun el dispositivo (ver
 * PrintRenderScene.tsx); "alta"/"rendimiento" fuerzan un nivel fijo
 * independientemente del dispositivo, para el usuario que quiera mas
 * fidelidad o mas fluidez de lo que la deteccion automatica elegiria. */
export function getRenderQuality(): RenderQuality {
  const v = localStorage.getItem(KEY);
  return v === "alta" || v === "rendimiento" ? v : "auto";
}

export function setRenderQuality(quality: RenderQuality) {
  localStorage.setItem(KEY, quality);
}
