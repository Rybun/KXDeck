import bedTextureRaw from "../assets/bed_texture.svg?raw";
import bedTextureUrl from "../assets/bed_texture.svg?url";

export { bedTextureUrl };

/** Tamano nativo (px) del SVG de la serigrafia de la bandeja -- viewBox
 * propio del fichero, no relacionado con el tamano real de la bandeja
 * (260x260mm). Se ajusta a la bandeja por "contain" (ver bedTextureFit),
 * sin deformar el dibujo. */
export const BED_TEXTURE_SIZE = { width: 749, height: 783 };

/** El area imprimible real es CUADRADA (749x749): el sobrante de altura
 * (783-749=34 unidades) es la solapa de la etiqueta (PLA/ABS/PETG +
 * ANYCUBIC), que en la bandeja fisica cuelga por FUERA del cuadrado
 * util, doblada hacia abajo -- no debe encajarse dentro de la bandeja
 * como si fuera parte de la superficie de impresion, solo asomar por el
 * borde tal cual pasa en la pieza real. Se usa este tamano (no
 * BED_TEXTURE_SIZE.height) como referencia de escala. */
export const BED_TEXTURE_SQUARE_SIZE = 749;

/** Contenido interior del SVG (solo los <path>, sin la etiqueta <svg> que
 * los envuelve) -- para inlinear directamente dentro del <svg> propio de
 * PrintRenderFlat.tsx via un <g transform=...>. */
export const bedTextureInner = bedTextureRaw.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Mismos angulos que _ISO_AZIMUTH/_ISO_ELEVATION en backend/gcode_render.py
// (y que la camara de PrintRenderScene.tsx): con z=0 (la textura es plana,
// pegada a la bandeja), su proyeccion isometrica se reduce a una
// transformacion LINEAL fija -- se deriva aqui con la misma formula, para
// que el "iso" 2D coincida exactamente con como se veria en el 3D real.
const ISO_AZIMUTH = -Math.PI / 4;
const ISO_ELEVATION = (37 * Math.PI) / 180;

function cross3(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(v: number[]): number[] {
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

const camDir = [
  Math.cos(ISO_ELEVATION) * Math.sin(ISO_AZIMUTH),
  -Math.cos(ISO_ELEVATION) * Math.cos(ISO_AZIMUTH),
  Math.sin(ISO_ELEVATION),
];
const isoForward = [-camDir[0], -camDir[1], -camDir[2]];
const isoRight = normalize3(cross3(isoForward, [0, 0, 1]));
const isoUp = normalize3(cross3(isoRight, isoForward));

/** (x,y) bandeja (z=0) -> (sx,sy) pantalla, misma formula que _project()
 * en backend/gcode_render.py. */
function projectBed(mode: "top" | "iso", x: number, y: number): [number, number] {
  if (mode === "top") return [x, -y];
  const sx = x * isoRight[0] + y * isoRight[1];
  const sy = -(x * isoUp[0] + y * isoUp[1]);
  return [sx, sy];
}

/** Caja delimitadora (ya proyectada) del contorno de la bandeja -- para
 * calcular el viewBox del estado "aun cargando" de PrintRenderFlat. */
export function bedProjectedBounds(mode: "top" | "iso", bedW: number, bedH: number) {
  const corners: [number, number][] = [
    [0, 0],
    [bedW, 0],
    [bedW, bedH],
    [0, bedH],
  ];
  const pts = corners.map(([x, y]) => projectBed(mode, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Contorno de la bandeja ya proyectado (mismo "d" que bed_d en el backend,
 * ver gcode_render.py) -- para el estado "aun cargando" de PrintRenderFlat,
 * donde todavia no hay datos reales del fichero pero la bandeja en si (su
 * tamano fisico) ya se conoce de antemano. */
export function bedOutlinePath(mode: "top" | "iso", bedW: number, bedH: number): string {
  const corners: [number, number][] = [
    [0, 0],
    [bedW, 0],
    [bedW, bedH],
    [0, bedH],
  ];
  const pts = corners.map(([x, y]) => projectBed(mode, x, y));
  return "M " + pts.map(([sx, sy]) => `${sx.toFixed(3)},${sy.toFixed(3)}`).join(" L ") + " Z";
}

/** Matriz SVG (para <g transform="matrix(...)">) que lleva el SVG de la
 * serigrafia (en su propio espacio de pixeles) directamente a coordenadas
 * de pantalla ya proyectadas -- combina en un solo paso: encajar el
 * CUADRADO util (BED_TEXTURE_SQUARE_SIZE, ver su comentario) contra la
 * esquina fondo-izquierda de la bandeja real (bedW x bedH, mismas unidades
 * que view.bed_d, SIN centrar -- centrar repartiria el sobrante de la
 * solapa mitad arriba/mitad abajo, cuando en realidad cuelga entera por un
 * solo lado) y despues proyectar segun el modo (top/iso), evaluando
 * projectBed() en 3 puntos de referencia en vez de derivar los coeficientes
 * a mano (mas robusto si el angulo isometrico cambiara alguna vez). */
export function bedTextureTransform(mode: "top" | "iso", bedW: number, bedH: number): string {
  const scale = Math.min(bedW / BED_TEXTURE_SQUARE_SIZE, bedH / BED_TEXTURE_SQUARE_SIZE);
  // El SVG crece hacia abajo (convencion imagen); la bandeja crece "hacia
  // atras" (convencion gcode) -- se invierte aqui para que el dibujo no
  // salga espejado en el eje Y. Sin offset: el cuadrado util (svgY en
  // [0, BED_TEXTURE_SQUARE_SIZE]) queda pegado exacto a bedY en [0, bedH];
  // la solapa (svgY > BED_TEXTURE_SQUARE_SIZE) cae en bedY < 0, fuera de la
  // bandeja, tal cual cuelga en la pieza fisica.
  const bedY = (svgY: number) => bedH - svgY * scale;
  const bedX = (svgX: number) => svgX * scale;

  const p0 = projectBed(mode, bedX(0), bedY(0));
  const pX = projectBed(mode, bedX(1), bedY(0));
  const pY = projectBed(mode, bedX(0), bedY(1));
  const a = pX[0] - p0[0];
  const b = pX[1] - p0[1];
  const c = pY[0] - p0[0];
  const d = pY[1] - p0[1];
  return `matrix(${a} ${b} ${c} ${d} ${p0[0]} ${p0[1]})`;
}
