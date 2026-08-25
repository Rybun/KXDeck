import { useEffect, useRef } from "react";
import type { Segment } from "../lib/gcodeParser";
import { colorForFeature, colorForTool } from "../lib/gcodeColors";

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
    };
  }, [segments, bedWidth, bedDepth, colorMode, colorsByTool, showTravel, highlightObject, highlightTool, excludedObjects, excludedStyle, occluderRect]);

  return (
    <canvas
      ref={canvasRef}
      className="aspect-square w-full rounded-xl bg-neutral-500/5"
    />
  );
}
