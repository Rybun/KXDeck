import { useEffect, useRef } from "react";
import type { RenderData2D } from "../hooks/usePrintRender2D";
import { BED } from "../lib/gcodeApi";
import { bedOutlinePath, bedProjectedBounds, bedTextureInner, bedTextureTransform } from "../lib/bedTexture";

// Mismas constantes que PrintRenderScene.tsx (ver ese fichero para el porque
// de cada valor): el resaltado debe verse y sentirse igual en las dos
// vistas, solo cambia COMO se aplica (opacidad de <g> SVG en vez de
// material.opacity de Three.js). Sin halo/glow aqui (a diferencia del 3D):
// un filtro de blur SVG por bucket, en un plato con muchos objetos/colores
// (p.ej. una bandeja AMS con decenas de buckets), colgaba el navegador --
// el pulso de opacidad ya es suficiente señal de "esto esta resaltado".
const NORMAL_OPACITY = 1;
const EXCLUDED_OPACITY = 0.12;
const PULSE_LOW = 0.15;
const PULSE_HIGH = 1;
const PULSE_PERIOD_MS = 900;
const SETTLE_RATE = 0.18;
// Mismo margen/ritmo que PrintRenderScene.tsx (ver ese fichero para el
// porque): aqui se desplaza el viewBox en vez de la camara, pero la idea es
// identica -- despejar EXACTAMENTE el borde del desplegable, ni de mas ni
// de menos.
const PAN_SAFETY_PX = 14;
const PAN_SETTLE_RATE = 0.12;

interface OpacityState {
  opacity: number;
}

/** Vista previa ligera (SVG, sin WebGL) de una pieza completa, generada
 * enteramente en el servidor (ver backend/gcode_render.py _build_view). Dos
 * modos (prop viewMode, ver su comentario mas abajo): "iso" (por defecto)
 * sombreado por quad con la MISMA iluminacion que PrintRenderScene.tsx --
 * se ve igual que Render 3D sin descargar el buffer 3D ni levantar WebGL;
 * "top" planta cenital sin sombrear, pensada como alternativa para piezas
 * (sobre todo texto en relieve) donde el sombreado por quad del modo "iso"
 * no consigue mostrar bien el contorno. */
export function PrintRenderFlat({
  data,
  loading,
  highlightObject,
  highlightTool,
  excludedObjects,
  aspectClassName = "aspect-square",
  className = "",
  occluderRect = null,
  viewMode = "iso",
}: {
  data: RenderData2D | null;
  loading?: boolean;
  highlightObject?: string | null;
  highlightTool?: number | null;
  excludedObjects?: string[];
  aspectClassName?: string;
  className?: string;
  // DOMRect real (coordenadas de pagina) del desplegable "Saltar objetos"
  // mientras esta abierto, o null si esta cerrado -- mismo prop y misma
  // idea que PrintRenderScene.tsx: al senalar un objeto tapado, la vista se
  // desplaza para despejarlo (aqui, corriendo el viewBox del SVG en vez de
  // mover una camara 3D real).
  occluderRect?: DOMRect | null;
  // "iso": paredes sombreadas + tapa (ver _lambert_shade) -- se ve igual
  // que el Render 3D, pero para piezas cuya silueta ENTERA es el detalle
  // (texto en relieve, sobre todo escritura conectada) el sombreado por
  // quad puede acabar tapando el propio contorno legible (ver conversacion
  // sobre Teclas_plate: la tecnica de "superponer todas las capas con un
  // tono plano" que SI funciona en planta no es aplicable en isometrico sin
  // crear un efecto muaré, porque la proyeccion iso SI desplaza cada capa
  // en pantalla segun su Z). "top": planta cenital, silueta plana sin
  // sombrear (superpone todas las capas, ver backend _build_view modo
  // "top") -- pierde el relieve 3D pero es la alternativa que SI muestra
  // bien esas piezas, hoy mismo, sin mas ajustes.
  viewMode?: "top" | "iso";
}) {
  const view = data?.views[viewMode] ?? null;
  const bounds = view?.bounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * 0.04;
  const vbX = bounds.minX - margin;
  const vbY = bounds.minY - margin;
  const vbW = bounds.maxX - bounds.minX + margin * 2;
  const vbH = bounds.maxY - bounds.minY + margin * 2;

  const svgRef = useRef<SVGSVGElement>(null);
  const groupRefs = useRef<(SVGGElement | null)[]>([]);
  const opacityState = useRef<OpacityState[]>([]);
  const animRaf = useRef<number | null>(null);
  const pulseStart = useRef(0);
  const panX = useRef(0);
  const panAnimRaf = useRef<number | null>(null);

  // Nueva pieza: estado de opacidad fresco (uno por bucket object+tool, en
  // el mismo orden que view.paths). Los arrays de refs del DOM no hace falta
  // reiniciarlos aparte -- los propios ref callbacks de abajo los mantienen
  // al dia en cada render.
  useEffect(() => {
    opacityState.current = (view?.paths ?? []).map(() => ({ opacity: NORMAL_OPACITY }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, viewMode]);

  useEffect(() => {
    if (!view) return;
    const hasHighlight = highlightObject != null || highlightTool != null;
    pulseStart.current = performance.now();

    function isMatch(idx: number): boolean {
      const p = view!.paths[idx];
      if (highlightObject != null) {
        return (p.object_index >= 0 ? data!.objects[p.object_index] : null) === highlightObject;
      }
      if (highlightTool != null) return p.tool === highlightTool;
      return false;
    }
    function baseOpacity(idx: number): number {
      const p = view!.paths[idx];
      if (excludedObjects && excludedObjects.length && p.object_index >= 0) {
        const name = data!.objects[p.object_index];
        if (excludedObjects.includes(name)) return EXCLUDED_OPACITY;
      }
      return NORMAL_OPACITY;
    }

    if (animRaf.current != null) cancelAnimationFrame(animRaf.current);
    const tick = () => {
      const now = performance.now();
      let animating = false;
      const states = opacityState.current;
      for (let idx = 0; idx < states.length; idx++) {
        const st = states[idx];
        const target = baseOpacity(idx);
        if (hasHighlight && isMatch(idx)) {
          const phase = ((now - pulseStart.current) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
          const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
          const pulseTarget = PULSE_LOW + (PULSE_HIGH - PULSE_LOW) * wave;
          st.opacity += (pulseTarget - st.opacity) * SETTLE_RATE;
          animating = true;
        } else {
          if (Math.abs(st.opacity - target) > 0.003) {
            st.opacity += (target - st.opacity) * SETTLE_RATE;
            animating = true;
          } else {
            st.opacity = target;
          }
        }
        const g = groupRefs.current[idx];
        if (g) g.style.opacity = String(st.opacity);
      }
      if (animating) {
        animRaf.current = requestAnimationFrame(tick);
      } else {
        animRaf.current = null;
      }
    };
    animRaf.current = requestAnimationFrame(tick);
    return () => {
      if (animRaf.current != null) cancelAnimationFrame(animRaf.current);
    };
  }, [data, viewMode, highlightObject, highlightTool, excludedObjects]);

  // Si el desplegable "Saltar objetos" esta abierto y la pieza senalada
  // queda tapada por su rectangulo REAL, el viewBox se desplaza a la
  // derecha (equivalente 2D al desplazamiento de camara de
  // PrintRenderScene.tsx) EXACTAMENTE lo necesario para despejarla --
  // mismo objeto de bordes completo (object_bounds), no solo su centro.
  useEffect(() => {
    const svg = svgRef.current;
    if (!view || !svg) return;

    let targetPanX = 0;
    if (occluderRect && highlightObject != null) {
      const objectIndex = data!.objects.indexOf(highlightObject);
      const ob = objectIndex >= 0 ? view.object_bounds[String(objectIndex)] : undefined;
      if (ob) {
        const svgRect = svg.getBoundingClientRect();
        const scale = Math.min(svgRect.width / vbW, svgRect.height / vbH);
        const offsetX = (svgRect.width - vbW * scale) / 2;
        const offsetY = (svgRect.height - vbH * scale) / 2;
        const curVbX = vbX + panX.current;
        const pxMinX = svgRect.left + offsetX + (ob.minX - curVbX) * scale;
        const pxMaxX = svgRect.left + offsetX + (ob.maxX - curVbX) * scale;
        const pxMinY = svgRect.top + offsetY + (ob.minY - vbY) * scale;
        const pxMaxY = svgRect.top + offsetY + (ob.maxY - vbY) * scale;
        const occluded =
          pxMaxX >= occluderRect.left && pxMinX <= occluderRect.right && pxMinY <= occluderRect.bottom && pxMaxY >= occluderRect.top;
        if (occluded) {
          const targetPxX = occluderRect.left - PAN_SAFETY_PX;
          targetPanX = Math.max(0, ob.maxX - vbX - (targetPxX - svgRect.left - offsetX) / scale);
        }
      }
    }

    if (panAnimRaf.current != null) cancelAnimationFrame(panAnimRaf.current);
    const tick = () => {
      panX.current += (targetPanX - panX.current) * PAN_SETTLE_RATE;
      const svgEl = svgRef.current;
      if (svgEl) svgEl.setAttribute("viewBox", `${vbX + panX.current} ${vbY} ${vbW} ${vbH}`);
      if (Math.abs(targetPanX - panX.current) > 0.01) {
        panAnimRaf.current = requestAnimationFrame(tick);
      } else {
        panX.current = targetPanX;
        panAnimRaf.current = null;
      }
    };
    panAnimRaf.current = requestAnimationFrame(tick);
    return () => {
      if (panAnimRaf.current != null) cancelAnimationFrame(panAnimRaf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, viewMode, highlightObject, occluderRect]);

  if (!view) {
    // Antes de tener datos reales del fichero (aun cargando o sin pieza)
    // ya se conoce el tamano fisico de la bandeja -- se muestra su
    // contorno + serigrafia de una vez, en vez de un hueco vacio, tanto
    // para dar referencia de orientacion desde el primer instante como
    // para que "cargando" no se vea como una caja en blanco.
    const loadingBounds = bedProjectedBounds(viewMode, BED.width, BED.depth);
    const lm = Math.max(loadingBounds.maxX - loadingBounds.minX, loadingBounds.maxY - loadingBounds.minY, 1) * 0.04;
    return (
      <div className={`relative ${aspectClassName} w-full overflow-hidden rounded-xl bg-neutral-500/5 ${className}`}>
        <svg
          viewBox={`${loadingBounds.minX - lm} ${loadingBounds.minY - lm} ${loadingBounds.maxX - loadingBounds.minX + lm * 2} ${loadingBounds.maxY - loadingBounds.minY + lm * 2}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full"
        >
          <g transform={bedTextureTransform(viewMode, BED.width, BED.depth)} dangerouslySetInnerHTML={{ __html: bedTextureInner }} />
          <path
            d={bedOutlinePath(viewMode, BED.width, BED.depth)}
            fill="none"
            stroke="#888888"
            strokeOpacity={0.5}
            strokeWidth={(loadingBounds.maxX - loadingBounds.minX) * 0.002}
          />
        </svg>
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">Generando render...</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`${aspectClassName} w-full overflow-hidden rounded-xl bg-neutral-500/5 ${className}`}>
      <svg
        ref={svgRef}
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
      >
        <g transform={bedTextureTransform(viewMode, BED.width, BED.depth)} dangerouslySetInnerHTML={{ __html: bedTextureInner }} />
        <path d={view.bed_d} fill="none" stroke="#888888" strokeOpacity={0.5} strokeWidth={vbW * 0.002} />
        {view.paths.map((p, idx) => (
          <g
            key={`${p.object_index}-${p.tool}`}
            ref={(el) => {
              groupRefs.current[idx] = el;
            }}
          >
            {viewMode === "iso" ? (
              (p.quads ?? []).map((q, qi) => (
                <path key={qi} d={q.d} fill={`#${q.color_hex}`} stroke={`#${q.color_hex}`} strokeWidth={vbW * 0.0006} />
              ))
            ) : (
              // "top": un unico contorno por bucket, superponiendo todas
              // las capas con el mismo color plano (ver backend
              // _build_view modo "top") -- sin sombreado, pero por eso
              // mismo sin el efecto muaré ni el problema de tapas que
              // afecta al modo "iso" en piezas cuya silueta ENTERA es el
              // detalle (texto en relieve).
              <path d={p.d} fill={`#${p.color_hex}`} fillRule="evenodd" />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
