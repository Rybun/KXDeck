import { useEffect, useState } from "react";
import { getApiKey } from "../api/client";

/** Un bucket de vertices (objeto+color) ya calculado en el servidor: cada
 * vertice ocupa `stride` floats intercalados (posicion + normal, ver
 * backend/gcode_render.py), cada 6 vertices son los 2 triangulos de una
 * pared vertical (un segmento de extrusion real). */
export interface RenderBucket {
  object_index: number;
  tool: number;
  color_hex: string;
  vertexData: Float32Array;
  count: number;
}

export interface RenderData3D {
  bed: { width: number; height: number };
  objects: string[];
  stride: number;
  buckets: RenderBucket[];
}

interface BucketHeader {
  object_index: number;
  tool: number;
  color_hex: string;
  count: number;
  offset: number;
}

/** Parsea el contenedor binario de GET /api/kxdeck/files/{id}/render (ver
 * backend/gcode_render.py: 4 bytes de longitud de header + header JSON +
 * floats crudos). Los Float32Array resultantes son VISTAS sobre el mismo
 * ArrayBuffer descargado, sin copiar memoria. */
async function fetchRender(fileId: string): Promise<RenderData3D> {
  const key = getApiKey();
  const res = await fetch(`/api/kxdeck/files/${fileId}/render`, {
    headers: key ? { "X-Api-Key": key } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const headerLen = new DataView(buf, 0, 4).getUint32(0, true);
  const headerText = new TextDecoder().decode(new Uint8Array(buf, 4, headerLen));
  const header = JSON.parse(headerText) as {
    bed: { width: number; height: number };
    objects: string[];
    stride: number;
    buckets: BucketHeader[];
  };

  const dataStart = 4 + headerLen;
  const buckets: RenderBucket[] = header.buckets.map((b) => ({
    object_index: b.object_index,
    tool: b.tool,
    color_hex: b.color_hex,
    vertexData: new Float32Array(buf, dataStart + b.offset, b.count * header.stride),
    count: b.count,
  }));

  return { bed: header.bed, objects: header.objects, stride: header.stride, buckets };
}

// Cache de proceso (no solo del componente): compartida entre CUALQUIER
// sitio que use este hook (dialogo de mapear colores, vista previa normal,
// panel en vivo de saltar objetos). Una vez descargado y parseado el
// binario de un fichero, reabrir su render en cualquiera de esos sitios es
// instantaneo -- ni una peticion de red ni un parseo de mas, nunca "se
// recarga". `inFlight` evita ademas lanzar dos descargas en paralelo si dos
// componentes piden el mismo fichero casi a la vez.
const renderCache = new Map<string, RenderData3D>();
const inFlight = new Map<string, Promise<RenderData3D>>();

function fetchRenderCached(fileId: string): Promise<RenderData3D> {
  const cached = renderCache.get(fileId);
  if (cached) return Promise.resolve(cached);
  let promise = inFlight.get(fileId);
  if (!promise) {
    promise = fetchRender(fileId)
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

/** Trae el render 3D de una pieza. Todo el parseo pesado del gcode ya esta
 * hecho y cacheado en el servidor; aqui ademas se cachea en el propio
 * proceso del navegador (ver renderCache arriba), asi que ni siquiera hace
 * falta la peticion HTTP de mas si ya se habia visto ese fichero antes en
 * esta sesion. */
export function usePrintRender3D(fileId: string | null | undefined) {
  const [data, setData] = useState<RenderData3D | null>(() => (fileId ? renderCache.get(fileId) ?? null : null));
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
