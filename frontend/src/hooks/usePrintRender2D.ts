import { useEffect, useState } from "react";
import { apiGet } from "../api/client";

export interface RenderQuad2D {
  d: string;
  color_hex: string;
}

export interface RenderPath2D {
  object_index: number;
  tool: number;
  color_hex: string;
  d: string;
  // Solo presente en la vista "iso": un quad por segmento de pared (ya
  // sombreado en servidor, ver backend/gcode_render.py _lambert_shade) mas
  // la tapa superior por isla. Es lo que se pinta de verdad; "d" (el
  // contorno combinado) ya no se usa para nada visual (el glow con blur se
  // quito, colgaba el navegador en piezas con muchos objetos/colores).
  quads?: RenderQuad2D[];
}

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RenderView2D {
  bounds: Bounds2D;
  bed_d: string;
  paths: RenderPath2D[];
  // Caja delimitadora 2D por objeto (clave = object_index como string) --
  // usada por PrintRenderFlat.tsx para desplazar el viewBox cuando el
  // desplegable "Saltar objetos" tapa la pieza senalada, igual que
  // PrintRenderScene.tsx desplaza la camara 3D.
  object_bounds: Record<string, Bounds2D>;
}

export interface RenderData2D {
  objects: string[];
  views: { top: RenderView2D; iso: RenderView2D };
}

// Mismo patron de cache de proceso que usePrintRender3D.ts: una vez
// descargado el JSON de un fichero, reabrirlo en esta sesion es instantaneo.
const renderCache = new Map<string, RenderData2D>();
const inFlight = new Map<string, Promise<RenderData2D>>();

function fetchRenderCached(fileId: string): Promise<RenderData2D> {
  const cached = renderCache.get(fileId);
  if (cached) return Promise.resolve(cached);
  let promise = inFlight.get(fileId);
  if (!promise) {
    promise = apiGet<RenderData2D>(`/api/kxdeck/files/${fileId}/render2d`)
      .then((d) => {
        renderCache.set(fileId, d);
        inFlight.delete(fileId);
        return d;
      })
      .catch((err) => {
        inFlight.delete(fileId);
        throw err;
      });
    inFlight.set(fileId, promise);
  }
  return promise;
}

/** Trae el render 2D isometrico (ligero, pre-generado en servidor) de una
 * pieza -- usado cuando "Render 3D" esta desactivado, para no tener que
 * descargar el buffer 3D ni levantar WebGL en el navegador (ver
 * FileDetail.tsx). El sombreado ya viene resuelto en el JSON, calculado con
 * la MISMA formula de iluminacion que PrintRenderScene.tsx (ver
 * backend/gcode_render.py _lambert_shade). */
export function usePrintRender2D(fileId: string | null | undefined) {
  const [data, setData] = useState<RenderData2D | null>(() => (fileId ? renderCache.get(fileId) ?? null : null));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fileId) {
      setData(null);
      return;
    }
    const cached = renderCache.get(fileId);
    if (cached) {
      setData(cached);
      return;
    }
    setData(null);
    let cancelled = false;
    setLoading(true);
    fetchRenderCached(fileId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  return { data, loading };
}
