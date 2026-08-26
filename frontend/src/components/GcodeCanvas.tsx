import { useEffect, useRef } from "react";
import type { Segment } from "../lib/gcodeParser";
import { colorForFeature, colorForTool } from "../lib/gcodeColors";
import { BED_TEXTURE_SIZE, BED_TEXTURE_SQUARE_SIZE, bedTextureUrl } from "../lib/bedTexture";

// Mismo SVG que PrintRenderScene.tsx/PrintRenderFlat.tsx (la serigrafia real
// de la bandeja), pero aqui se rasteriza sobre el <canvas> en vez de
// inlinearse como <g> SVG -- un solo Image compartido por todas las
// instancias (el fichero nunca cambia), decodificado una vez por el
// navegador. Sirve de referencia visual de orientacion (donde esta el borde
// frontal, la solapa de la etiqueta...) igual que en las otras dos vistas.
const bedTextureImg = new Image();
bedTextureImg.src = bedTextureUrl;

// Mismas constantes que PrintRenderScene.tsx/PrintRenderFlat.tsx: el
// resaltado por hover (Mapeo de colores/Saltar objetos) debe verse y
// sentirse igual en las tres vistas, solo cambia COMO se aplica (alpha de
// canvas 2D en vez de opacidad de material/SVG).
const NORMAL_OPACITY = 1;
const EXCLUDED_OPACITY = 0.12;
// Modo "gray" (ver excludedStyle): en vez de casi desaparecer (opacidad muy
// baja sobre su color original, EXCLUDED_OPACITY), la pieza omitida se
// repinta en un gris solido y visible -- se nota de un vistazo cual es,
// en vez de tener que fijarse en un trazo casi invisible.
const EXCLUDED_GRAY = "#8a8f99";
const EXCLUDED_GRAY_OPACITY = 0.55;
const PULSE_LOW = 0.15;
const PULSE_HIGH = 1;
const PULSE_PERIOD_MS = 900;
// Mismo concepto que CAMERA_SETTLE_RATE/OCCLUSION_SAFETY_PX en
// PrintRenderScene.tsx, pero en pixeles de canvas en vez de mundo 3D -- aqui
// no hace falta proyeccion NDC, tx()/ty() ya dan coordenadas de pantalla.
const PAN_SETTLE_RATE = 0.18;
const OCCLUSION_SAFETY_PX = 10;

export function GcodeCanvas({
  segments,
  bedWidth,
  bedDepth,
  colorMode,
  colorsByTool,
  showTravel,
  highlightObject = null,
  highlightTool = null,
  excludedObjects,
  excludedStyle = "fade",
  occluderRect = null,
}: {
  segments: Segment[];
  bedWidth: number;
  bedDepth: number;
  colorMode: "type" | "tool";
  colorsByTool: Record<number, string>;
  showTravel: boolean;
  highlightObject?: string | null;
  highlightTool?: number | null;
  excludedObjects?: string[];
  // "fade" (por defecto, usado en Vista previa / Saltar objetos antes de
  // imprimir): el trazo original casi desaparece (EXCLUDED_OPACITY). "gray":
  // se repinta en gris solido y visible -- pensado para el visor incrustado
  // junto a la camara, donde el objeto YA se salto durante una impresion en
  // curso y conviene que se note de un vistazo cual es, no que casi
  // desaparezca.
  excludedStyle?: "fade" | "gray";
  // Rectangulo REAL del desplegable "Saltar objetos" (ver SkipObjectsButton
  // -> onRectChange), si esta abierto. Cuando el objeto senalado queda
  // tapado por el, el dibujo se desplaza para despejarlo (igual que ya hace
  // la camara del render 3D con occluderRect).
  occluderRect?: DOMRect | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRaf = useRef<number | null>(null);
  const panOffsetRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(rect.width, 200);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = 8;
    const scale = (size - pad * 2) / Math.max(bedWidth, bedDepth, 1);
    const tx = (x: number) => pad + x * scale;
    const ty = (y: number) => size - pad - y * scale;

    const hasHighlight = highlightObject != null || highlightTool != null;
    const hasExcluded = Boolean(excludedObjects && excludedObjects.length);

    function isMatch(s: Segment): boolean {
      if (highlightObject != null) return s.objectName === highlightObject;
      if (highlightTool != null) return s.tool === highlightTool;
      return false;
    }
    function isExcluded(s: Segment): boolean {
      return hasExcluded && s.objectName != null && excludedObjects!.includes(s.objectName);
    }

    // Cuanto habria que desplazar el dibujo hacia la izquierda (en pixeles
    // de canvas) para que el objeto senalado quede fuera del rectangulo del
    // desplegable. 0 si no aplica (sin desplegable abierto, sin objeto
    // senalado, o ya visible). Solo objetos (highlightObject), no colores --
    // el mapeo de colores no vive junto al desplegable de Saltar objetos.
    function computeTargetPan(): number {
      if (!occluderRect || highlightObject == null) return 0;
      const canvasRect = canvas!.getBoundingClientRect();
      const occLeft = occluderRect.left - canvasRect.left;
      const occRight = occluderRect.right - canvasRect.left;
      const occTop = occluderRect.top - canvasRect.top;
      const occBottom = occluderRect.bottom - canvasRect.top;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let any = false;
      for (const s of segments) {
        if (s.travel || !isMatch(s)) continue;
        any = true;
        const x1 = tx(s.x1), x2 = tx(s.x2), y1 = ty(s.y1), y2 = ty(s.y2);
        if (x1 < minX) minX = x1;
        if (x2 < minX) minX = x2;
        if (x1 > maxX) maxX = x1;
        if (x2 > maxX) maxX = x2;
        if (y1 < minY) minY = y1;
        if (y2 < minY) minY = y2;
        if (y1 > maxY) maxY = y1;
        if (y2 > maxY) maxY = y2;
      }
      if (!any) return 0;

      const occluded = maxX >= occLeft && minX <= occRight && minY <= occBottom && maxY >= occTop;
      if (!occluded) return 0;
      // Desplaza lo justo para despejar el punto MAS a la derecha del
      // objeto, no solo su centro -- que quede entero fuera del desplegable.
      return Math.max(0, maxX - (occLeft - OCCLUSION_SAFETY_PX));
    }

    const pulseStart = performance.now();

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);
      const off = panOffsetRef.current;
      const px = (x: number) => tx(x) - off;

      // Serigrafia de la bandeja, de fondo (misma logica que
      // bedTextureTransform() en lib/bedTexture.ts, en "top" -- sin
      // rotacion/skew, solo escala+traslacion, asi que aqui basta con un
      // drawImage con el rectangulo destino ya calculado, sin pasar por
      // matrices). El cuadrado util (BED_TEXTURE_SQUARE_SIZE) se encaja
      // contra el ancho/fondo real de la bandeja; la solapa de la etiqueta
      // (el resto de BED_TEXTURE_SIZE.height) cuelga por debajo del borde
      // frontal (y=0), tal cual en la pieza fisica.
      if (bedTextureImg.complete && bedTextureImg.naturalWidth > 0) {
        const bedTexScale = Math.min(bedWidth, bedDepth) / BED_TEXTURE_SQUARE_SIZE;
        ctx.globalAlpha = 1;
        ctx.drawImage(
          bedTextureImg,
          px(0),
          ty(bedDepth),
          BED_TEXTURE_SIZE.width * bedTexScale * scale,
          BED_TEXTURE_SIZE.height * bedTexScale * scale,
        );
      }

      if (showTravel) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(148,163,184,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const s of segments) {
          if (!s.travel) continue;
          ctx.moveTo(px(s.x1), ty(s.y1));
          ctx.lineTo(px(s.x2), ty(s.y2));
        }
        ctx.stroke();
      }

      let pulseAlpha = NORMAL_OPACITY;
      if (hasHighlight) {
        const phase = ((performance.now() - pulseStart) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
        const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        pulseAlpha = PULSE_LOW + (PULSE_HIGH - PULSE_LOW) * wave;
      }

      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      for (const s of segments) {
        if (s.travel) continue;
        const matched = hasHighlight && isMatch(s);
        const excluded = isExcluded(s);
        const grayExcluded = excluded && excludedStyle === "gray";
        ctx.globalAlpha = matched ? pulseAlpha : excluded ? (grayExcluded ? EXCLUDED_GRAY_OPACITY : EXCLUDED_OPACITY) : NORMAL_OPACITY;
        ctx.strokeStyle = grayExcluded
          ? EXCLUDED_GRAY
          : colorMode === "tool" ? colorForTool(s.tool, colorsByTool) : colorForFeature(s.type);
        ctx.beginPath();
        ctx.moveTo(px(s.x1), ty(s.y1));
        ctx.lineTo(px(s.x2), ty(s.y2));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    draw();
    // Si este es el primerisimo GcodeCanvas que se monta en toda la sesion,
    // el Image compartido puede que todavia no haya terminado de decodificar
    // -- ese primer draw() se queda sin bandeja de fondo. Un solo redibujado
    // al terminar de cargar (no hace falta mas: a partir de ahi .complete ya
    // es true para siempre, en este componente y en cualquier otro).
    if (!bedTextureImg.complete) bedTextureImg.addEventListener("load", draw, { once: true });
    if (animRaf.current != null) cancelAnimationFrame(animRaf.current);

    function tick() {
      const target = computeTargetPan();
      panOffsetRef.current += (target - panOffsetRef.current) * PAN_SETTLE_RATE;
      const panSettling = Math.abs(target - panOffsetRef.current) > 0.3;
      if (!panSettling) panOffsetRef.current = target;
      draw();
      if (hasHighlight || panSettling) {
        animRaf.current = requestAnimationFrame(tick);
      } else {
        animRaf.current = null;
      }
    }
    if (hasHighlight || Math.abs(panOffsetRef.current) > 0.05) {
      animRaf.current = requestAnimationFrame(tick);
    }

    return () => {
      if (animRaf.current != null) cancelAnimationFrame(animRaf.current);
      bedTextureImg.removeEventListener("load", draw);
    };
  }, [segments, bedWidth, bedDepth, colorMode, colorsByTool, showTravel, highlightObject, highlightTool, excludedObjects, excludedStyle, occluderRect]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-square w-full rounded-xl bg-neutral-500/5"
    />
  );
}
