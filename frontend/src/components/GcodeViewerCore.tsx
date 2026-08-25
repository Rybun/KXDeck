import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCw } from "lucide-react";
import { apiGet } from "../api/client";
import type { KxFileEntry, LayerIndex } from "../api/types";
import { GcodeCanvas } from "./GcodeCanvas";
import { parseLayerGcode, type ParseState, type Segment } from "../lib/gcodeParser";
import { colorForFeature, colorForTool } from "../lib/gcodeColors";
import { BED, fetchLayerText } from "../lib/gcodeApi";
import { filamentChannelsToColorMap, parseUsedFilamentChannels } from "../lib/filamentChannels";

/** Nucleo del visor de gcode: indice de capas, canvas coloreado, controles.
 * Se usa tanto en la pagina de detalle de fichero como incrustado (modo
 * compacto) en el panel de Estado para seguir la impresion en curso. */
export function GcodeViewerCore({
  fileId,
  compact = false,
  live = false,
  liveLayer,
  highlightObject = null,
  highlightTool = null,
  excludedObjects,
  excludedStyle = "fade",
  occluderRect = null,
}: {
  fileId: string;
  compact?: boolean;
  live?: boolean;
  liveLayer?: number;
  // Mismo resaltado/exclusion que en Vista previa (Mapeo de colores/Saltar
  // objetos, ver FileDetail.tsx): al pasar el raton por un color o un
  // objeto, o al marcarlo para saltar, tambien se ve reflejado aqui.
  highlightObject?: string | null;
  highlightTool?: number | null;
  excludedObjects?: string[];
  // Ver GcodeCanvas.tsx -- "gray" en el visor incrustado junto a la camara
  // (objetos ya saltados de una impresion EN CURSO, conviene que se noten),
  // "fade" (por defecto) en el resto (Vista previa antes de imprimir).
  excludedStyle?: "fade" | "gray";
  // Rectangulo real del desplegable "Saltar objetos" mientras esta abierto
  // (ver SkipObjectsButton -> onRectChange): permite desplazar el dibujo
  // para despejar el objeto senalado, igual que ya hace la camara del
  // render 3D (ver GcodeCanvas).
  occluderRect?: DOMRect | null;
}) {
  const [index, setIndex] = useState<LayerIndex | null>(null);
  const [entry, setEntry] = useState<KxFileEntry | null>(null);
  const [layer, setLayer] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [colorMode, setColorMode] = useState<"type" | "tool">("type");
  const [showTravel, setShowTravel] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Solo tiene sentido en modo "live" (visor incrustado junto a la camara):
  // arrancar en true replica el comportamiento de antes (siempre pegado a
  // la capa real). Moverse a mano por el slider/flechas lo desactiva (ver
  // handlers mas abajo); el boton de play lo vuelve a activar Y salta de
  // inmediato a la capa que se esta imprimiendo ahora mismo.
  const [followLive, setFollowLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Solo tiene sentido en modo "live" (junto a la camara): opcion para
  // encajar la orientacion del dibujo con la de la camara fisica (que no
  // siempre esta montada "hacia arriba" respecto al plano XY). Recordado
  // entre sesiones -- es una preferencia de montaje de ESTA impresora, no
  // algo que cambie de una impresion a otra.
  const [rotated, setRotated] = useState(() => live && localStorage.getItem("kxdeck.gcodeCamRotated") === "1");

  const requestId = useRef(0);
  const parseState = useRef<ParseState>({ type: "", tool: 0, objectName: null });
  // Cache de capas ya vistas (por indice de capa): volver a una capa ya
  // visitada no vuelve a pedir red ni a reparsear -- instantaneo. Se vacia
  // al cambiar de fichero.
  const layerCache = useRef<Map<number, Segment[]>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setError("");
    setIndex(null);
    setFollowLive(true);
    layerCache.current = new Map();
    apiGet<LayerIndex>(`/api/kxdeck/files/${fileId}/layers`)
      .then((d) => {
        setIndex(d);
        if (live && liveLayer !== undefined) {
          setLayer(Math.min(Math.max(liveLayer - 1, 0), Math.max(d.count - 1, 0)));
        } else {
          setLayer(0);
        }
      })
      .catch((e) => setError(String(e)));
    apiGet<{ files: KxFileEntry[] }>("/api/kxdeck/files").then((d) => {
      setEntry(d.files.find((f) => f.id === fileId) ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Modo en vivo: seguir la capa real de la impresion segun avanza -- pero
  // solo mientras followLive este activo. followLive en las deps es
  // deliberado (no solo el guard): al pulsar el boton de play, hace que
  // este efecto se vuelva a ejecutar de inmediato y salte a la capa actual,
  // en vez de esperar al siguiente cambio de liveLayer.
  useEffect(() => {
    if (!live || !followLive || liveLayer === undefined || !index) return;
    setLayer(Math.min(Math.max(liveLayer - 1, 0), Math.max(index.count - 1, 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveLayer, live, followLive]);

  useEffect(() => {
    if (!index || index.count === 0) return;

    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const cached = layerCache.current.get(layer);
    if (cached) {
      // Ya vista: instantaneo, sin red ni reparseo ni parpadeo de "cargando".
      setSegments(cached);
      setError("");
      return;
    }

    const myRequest = ++requestId.current;
    // Debounce corto: mientras se arrastra el slider solo se pide la capa en
    // la que el usuario se detiene, no cada valor intermedio del arrastre.
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // El texto "cargando" solo aparece si de verdad tarda -- evita el
      // parpadeo en peticiones que resuelven casi al instante.
      if (loadingTimerRef.current != null) window.clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = window.setTimeout(() => {
        if (myRequest === requestId.current) setLoading(true);
      }, 150);

      // La herramienta se arrastra desde el indice de capas (ver
      // start_tools, backend/kx_client.py layer_offsets): cada capa se
      // parsea de forma independiente para poder saltar al instante a
      // cualquier capa, asi que sin esto se asumia siempre herramienta 0 --
      // si el "Tn" real se fija una unica vez al principio del fichero
      // (habitual en bandejas de un solo canal/color), el resaltado del
      // mapeo de colores nunca encajaba salvo en la propia capa 0.
      parseState.current = { type: "", tool: index.start_tools[layer] ?? 0, objectName: null };
      const start = index.offsets[layer];
      const end = layer + 1 < index.count ? index.offsets[layer + 1] : index.size;
      fetchLayerText(index.filename, start, end, controller.signal)
        .then((text) => {
          if (myRequest !== requestId.current) return;
          const result = parseLayerGcode(text, parseState.current);
          layerCache.current.set(layer, result.segments);
          setSegments(result.segments);
          setError("");
        })
        .catch((e) => {
          if (e?.name === "AbortError") return;
          if (myRequest === requestId.current) setError(String(e));
        })
        .finally(() => {
          if (loadingTimerRef.current != null) {
            window.clearTimeout(loadingTimerRef.current);
            loadingTimerRef.current = null;
          }
          if (myRequest === requestId.current) setLoading(false);
        });
    }, 70);

    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [index, layer]);

  // Precarga en segundo plano: sin esto, arrastrar el slider RAPIDO por
  // capas nunca visitadas se nota a golpes (red+parseo capa a capa, cada
  // una con su propio retraso) -- solo se sentia fluido si uno se movia
  // despacio (dando tiempo a que cada capa realmente cargase antes de
  // pasar a la siguiente). Un unico barrido de fondo, en radios crecientes
  // alrededor de la capa ACTUAL (releida en cada paso via layerRef, asi
  // que se recentra sola si el usuario se mueve mientras tanto), va
  // rellenando layerCache por delante -- una peticion cada vez (nunca en
  // paralelo, para no saturar el servidor de ficheros de la propia
  // impresora) con una pequeña pausa solo tras una peticion real (nunca
  // tras saltarse una ya cacheada). Al ser este visor el que suele quedarse
  // abierto horas durante una impresion (incrustado junto a la camara),
  // con tiempo de sobra el fichero entero acaba en cache.
  const layerRef = useRef(layer);
  useEffect(() => {
    layerRef.current = layer;
  }, [layer]);

  useEffect(() => {
    if (!index || index.count === 0) return;
    let cancelled = false;
    const controller = new AbortController();

    async function prefetchLoop() {
      for (let radius = 1; radius <= index!.count && !cancelled; radius++) {
        const center = layerRef.current;
        const targets = [center + radius, center - radius].filter(
          (l) => l >= 0 && l < index!.count && !layerCache.current.has(l),
        );
        for (const l of targets) {
          if (cancelled) return;
          try {
            const start = index!.offsets[l];
            const end = l + 1 < index!.count ? index!.offsets[l + 1] : index!.size;
            const text = await fetchLayerText(index!.filename, start, end, controller.signal);
            if (cancelled) return;
            const state: ParseState = { type: "", tool: index!.start_tools[l] ?? 0, objectName: null };
            const result = parseLayerGcode(text, state);
            layerCache.current.set(l, result.segments);
          } catch {
            // Silencioso -- es solo precarga, un fallo aqui (abort al
            // desmontar, 429, lo que sea) no debe interrumpir nada visible.
          }
          // 700ms: cada peticion de precarga viaja hasta el propio servidor
          // embebido de la impresora (backend/printer_control.py::h_download
          // hace de proxy real, no sirve nada de cache local) -- un fichero
          // de 1000+ capas tardaria ~13 min en completarse a este ritmo,
          // pero es un fondo pasivo pensado para durar la impresion entera
          // (horas), no una carga que la impresora deba absorber de golpe.
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    }

    prefetchLoop();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (!playing || !index) return;
    const id = setInterval(() => {
      setLayer((l) => (l + 1 >= index.count ? 0 : l + 1));
    }, 500);
    return () => clearInterval(id);
  }, [playing, index]);

  // Misma fuente que el dialogo de asignar colores (gcode_filaments filtrado
  // a is_used): antes se usaba la lista cruda de colores del perfil del
  // slicer, que podia tener muchas mas entradas que las realmente usadas.
  const colorsByTool = useMemo(
    () => filamentChannelsToColorMap(parseUsedFilamentChannels(entry?.gcode_filaments)),
    [entry],
  );

  const legendItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of segments) {
      if (s.travel) continue;
      if (colorMode === "type") {
        if (!seen.has(s.type || "?")) seen.set(s.type || "?", colorForFeature(s.type));
      } else {
        const key = `T${s.tool}`;
        if (!seen.has(key)) seen.set(key, colorForTool(s.tool, colorsByTool));
      }
    }
    return Array.from(seen.entries());
  }, [segments, colorMode, colorsByTool]);

  if (error) {
    return <div className="p-2 text-sm text-red-500">{error}</div>;
  }
  if (!index) {
    return <div className="p-2 text-sm text-neutral-500">Cargando indice de capas...</div>;
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="relative">
        {/* La rotacion es puramente visual (CSS), no toca la logica de
         * dibujo de GcodeCanvas -- al ser siempre cuadrado (aspect-square),
         * girar 90° no cambia su caja, asi que no hace falta ningun ajuste
         * de tamaño alrededor. */}
        <div style={live && rotated ? { transform: "rotate(90deg)" } : undefined}>
          <GcodeCanvas
            segments={segments}
            bedWidth={BED.width}
            bedDepth={BED.depth}
            colorMode={colorMode}
            colorsByTool={colorsByTool}
            showTravel={showTravel}
            highlightObject={highlightObject}
            highlightTool={highlightTool}
            excludedObjects={excludedObjects}
            excludedStyle={excludedStyle}
            occluderRect={occluderRect}
          />
        </div>
        {live && (
          <button
            onClick={() => {
              const next = !rotated;
              setRotated(next);
              localStorage.setItem("kxdeck.gcodeCamRotated", next ? "1" : "0");
            }}
            title={rotated ? "Volver a la orientación original" : "Girar 90° para encajar con la cámara"}
            className="absolute right-1.5 top-1.5 rounded-full bg-neutral-900/60 p-1.5 text-white backdrop-blur-sm"
          >
            <RotateCw size={14} />
          </button>
        )}
      </div>

      {!compact && (
        <div className="flex flex-wrap gap-2 text-xs">
          {legendItems.map(([label, color]) => (
            <span key={label} className="flex items-center gap-1 rounded-full bg-neutral-500/10 px-2 py-0.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {/* En vivo: este boton sustituye al de autoplay -- alterna entre
         * seguir la capa real de la impresion (pausa = "click para dejar de
         * seguir") y quedarse quieto en la capa que se este viendo a mano
         * (play = "click para volver a la capa en curso"). Mover el
         * slider/flechas de al lado ya lo desactiva solo (ver handlers). Al
         * principio de la fila, no al final -- es el control mas usado. */}
        {live ? (
          <button
            onClick={() => setFollowLive((f) => !f)}
            title={followLive ? "Siguiendo la impresión en vivo" : "Volver a la capa en curso"}
            className="rounded-full bg-[var(--accent-500)]/15 p-1.5 text-[var(--accent-600)] dark:text-[var(--accent-400)]"
          >
            {followLive ? <Pause size={compact ? 14 : 18} /> : <Play size={compact ? 14 : 18} />}
          </button>
        ) : (
          !compact && (
            <button onClick={() => setPlaying((p) => !p)} className="rounded-full bg-[var(--accent-500)]/15 p-1.5 text-[var(--accent-600)] dark:text-[var(--accent-400)]">
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
          )
        )}
        <button
          onClick={() => { setFollowLive(false); setPlaying(false); setLayer((l) => Math.max(0, l - 1)); }}
          className="shrink-0 rounded-full border border-neutral-500/20 bg-neutral-500/15 p-1.5"
        >
          <ChevronLeft size={compact ? 14 : 18} />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(index.count - 1, 0)}
          value={layer}
          onChange={(e) => {
            setFollowLive(false);
            setPlaying(false);
            setLayer(Number(e.target.value));
          }}
          className="flex-1"
        />
        <button
          onClick={() => { setFollowLive(false); setPlaying(false); setLayer((l) => Math.min(index.count - 1, l + 1)); }}
          className="shrink-0 rounded-full border border-neutral-500/20 bg-neutral-500/15 p-1.5"
        >
          <ChevronRight size={compact ? 14 : 18} />
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          Capa {layer + 1} / {index.count} {loading && "· cargando..."}
        </span>
        {!compact && (
          <div className="flex gap-3">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={showTravel} onChange={(e) => setShowTravel(e.target.checked)} />
              Desplazamientos
            </label>
            <div className="flex overflow-hidden rounded-full bg-neutral-500/10 text-[11px]">
              <button
                onClick={() => setColorMode("type")}
                className={`px-2 py-0.5 font-medium ${colorMode === "type" ? "bg-[var(--accent-500)] text-white" : ""}`}
              >
                Tipo
              </button>
              <button
                onClick={() => setColorMode("tool")}
                className={`px-2 py-0.5 font-medium ${colorMode === "tool" ? "bg-[var(--accent-500)] text-white" : ""}`}
              >
                Filamento
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
