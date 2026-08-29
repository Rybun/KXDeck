import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, bootstrapApiKey, getApiKey, setApiKey } from "../api/client";
import type { KxFileEntry, PauseScheduleEntry } from "../api/types";
import { useKxState } from "../hooks/useKxState";
import { useNotificationEvents } from "../hooks/useNotificationEvents";
import { GcodeViewerCore } from "../components/GcodeViewerCore";
import { PrintRenderScene } from "../components/PrintRenderScene";
import { PrintRenderFlat } from "../components/PrintRenderFlat";
import { usePrintRender3D } from "../hooks/usePrintRender3D";
import { usePrintRender2D } from "../hooks/usePrintRender2D";
import { Spool } from "../components/Spool";
import { parseUsedFilamentChannels } from "../lib/filamentChannels";
import { ACCENT_PRESETS, DEFAULT_ACCENT, applyAccent } from "../lib/accent";
import { useAccent } from "../hooks/useAccent";
import { Check, Copy, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import widgetCss from "../index.css?inline";

declare global {
  interface Window {
    _storeFileId?: string | null;
    _printObjects?: { name: string; skip: boolean }[];
    _toggleObjectSkip?: (idx: number, val: boolean) => void;
    renderObjectChecklist?: () => void;
  }
}

// Todos los wrappers ".dark" creados por mountShadowRoot(), para poder
// recolorearlos en vivo cuando el usuario cambia de acento (ver
// reapplyAccentEverywhere(), llamado desde AccentSettingsCard).
const shadowAccentWrappers: HTMLElement[] = [];

function applyAccentToWrapper(wrapper: HTMLElement) {
  const accentName = localStorage.getItem("kxdeck.accent") ?? DEFAULT_ACCENT;
  const preset = ACCENT_PRESETS.find((p) => p.name === accentName) ?? ACCENT_PRESETS[0];
  wrapper.style.setProperty("--accent-400", preset[400]);
  wrapper.style.setProperty("--accent-500", preset[500]);
  wrapper.style.setProperty("--accent-600", preset[600]);
  wrapper.style.setProperty("--accent-700", preset[700]);
}

/** Reaplica el acento guardado a document.documentElement (recolorea el
 * propio KX-Bridge nativo, via --accent) Y a todos los wrappers de shadow
 * DOM ya montados. Hace falta lo segundo porque el CSS compilado de
 * KXDeck ya trae su propio ":host{--accent-500:...}" (Tailwind lo emite
 * con el valor POR DEFECTO de index.css) -- ese ":host" reinicia la
 * herencia en cada limite de shadow DOM, asi que cambiar solo
 * document.documentElement no le llega a nada dentro de un shadow root
 * salvo que se fije tambien ahi, localmente. */
function reapplyAccentEverywhere() {
  applyAccent(localStorage.getItem("kxdeck.accent") ?? DEFAULT_ACCENT);
  shadowAccentWrappers.forEach(applyAccentToWrapper);
}

/** Monta un React root aislado en shadow DOM dentro de `container` (mismo
 * patron para cualquier punto de inyeccion: aplica el CSS compilado de
 * KXDeck con :root->:host, y el acento de color guardado por el usuario).
 * Devuelve el elemento que hay que pasarle a createRoot(). */
function mountShadowRoot(container: HTMLElement): HTMLElement {
  const shadow = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = widgetCss.replaceAll(":root", ":host");
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "dark";
  applyAccentToWrapper(root);
  shadowAccentWrappers.push(root);
  shadow.appendChild(root);
  return root;
}

// Se asigna dentro de patchCameraGcodeToggle() -- puente hacia el
// controlador vanilla (fuera de React) que decide si la tarjeta de camara
// muestra el visor de gcode compartiendo hueco o detras de un toggle (ver
// mas abajo). El componente React solo sabe SI hay algo que enseñar; el
// COMO se enseña (lado a lado o con pestañas) es puro DOM/CSS, ya que
// implica mover y medir el propio <div id="cam-wrap"> nativo de
// KX-Bridge, que vive fuera de este arbol de React.
let setCamGcodeAvailable: ((v: boolean) => void) | null = null;

// Puente identico en espiritu a fdPreviewSetHighlightTool (ver
// FilamentDialogPreview mas abajo): quien dispara el resaltado es codigo
// fuera de este arbol (hover sobre las bobinas de patchCameraFilamentStrip,
// puro DOM), no este componente -- asi que se escribe/lee via una variable
// de modulo en vez de una prop.
let camGcodeSetHighlightTool: ((tool: number | null) => void) | null = null;

// Misma idea que setCamGcodeAvailable, pero en la direccion inversa
// (informa, no ordena): que canales de filamento pide DE VERDAD el gcode de
// esta impresion (parseUsedFilamentChannels, la misma fuente que ya usa
// GcodeViewerCore para su leyenda "Filamento"), no simplemente que ranuras
// tiene cargadas el AMS ahora mismo. Lo consume patchCameraFilamentStrip
// para atenuar en gris las bobinas que esta impresion no va a tocar. null
// significa "no se sabe todavia" (sin impresion activa, o sin resolver
// aun) -- nunca "ninguna se usa", para no apagar de golpe toda la tira
// mientras carga.
let setCamGcodeUsedTools: ((tools: Set<number> | null) => void) | null = null;

/** Igual que la resolucion de fileId de CameraGcodePanel.tsx, sin la parte
 * de pestana de camara (aqui sobra: comparte tarjeta con la camara NATIVA
 * de KX-Bridge, ver patchCameraGcodeToggle()). */
function CameraGcodeViewer() {
  const { data } = useKxState();
  const hasActivePrint = Boolean(data?.job.file.name) && Boolean(data?.state.flags.printing);
  const [fileId, setFileId] = useState<string | null>(null);
  const [usedTools, setUsedTools] = useState<Set<number> | null>(null);
  const [highlightTool, setHighlightTool] = useState<number | null>(null);

  useEffect(() => {
    camGcodeSetHighlightTool = setHighlightTool;
    return () => {
      camGcodeSetHighlightTool = null;
    };
  }, []);

  useEffect(() => {
    if (!hasActivePrint || !data) {
      setFileId(null);
      setUsedTools(null);
      return;
    }
    apiGet<{ files: KxFileEntry[] }>("/api/kxdeck/files").then((d) => {
      const entry = d.files.find((f) => f.filename === data.job.file.name);
      setFileId(entry?.id ?? null);
      setUsedTools(
        entry ? new Set(parseUsedFilamentChannels(entry.gcode_filaments).map((c) => c.slot_index)) : null,
      );
    });
  }, [hasActivePrint, data?.job.file.name]);

  useEffect(() => {
    setCamGcodeUsedTools?.(usedTools);
  }, [usedTools]);

  const available = hasActivePrint && Boolean(fileId);
  useEffect(() => {
    setCamGcodeAvailable?.(available);
  }, [available]);

  if (!available || !data) return null;
  return (
    <GcodeViewerCore
      fileId={fileId!}
      compact
      live
      liveLayer={data.kx.curr_layer as number}
      highlightTool={highlightTool}
      // Piezas ya saltadas de ESTA impresion (ver SkipObjectsPanel.tsx,
      // mismo campo) -- "gray" en vez del "fade" (casi invisible) que usa
      // Vista previa: aqui el salto ya es un hecho consumado, no una
      // decision pendiente, asi que conviene que se note de un vistazo cual
      // pieza fue la saltada.
      excludedObjects={data.skip?.skipped}
      excludedStyle="gray"
    />
  );
}

/** Envuelve el <div id="cam-wrap"> nativo (moviendolo, no clonandolo --
 * conserva sus ids/onclick tal cual) en una fila junto a un hueco propio
 * para el visor de gcode, con una barra de pestañas nativa (sin React,
 * puro DOM) que solo aparece cuando la fila no tiene sitio para las dos a
 * la vez. Ver backend/kx_home.py (marcador #kxd-cam-gcode-root, insertado
 * justo antes de #cam-wrap).
 *
 * Reparto deliberadamente DESEQUILIBRADO (no 50/50): la camara se queda solo
 * con el ancho que de verdad necesita (segun su propia proporcion de
 * imagen), y el resto se lo lleva el cuadrado de gcode -- no al reves.
 * "cam-wrap img" usa object-fit:contain dentro de una caja mas ancha que la
 * imagen real (flex:1 le daba de mas), asi que sobraban bandas negras a los
 * lados de la camara; eso mismo es lo que ahora reclama el gcode (ver
 * sizeCameraRow). Como el gcode gana mas ancho, tambien puede ser mas alto
 * (sigue siendo cuadrado) -- por eso la tarjeta entera SI crece ahora (via
 * GridStack), a diferencia de la version anterior que la dejaba siempre en
 * su alto nativo. El calculo de cuanto crecer parte de datos ESTABLES (ancho
 * de la fila, relacion de aspecto real de la imagen de camara, alto de los
 * controles bajo el canvas) que no dependen de su propio resultado, asi que
 * no hay riesgo de oscilar; y se ignora mientras la camara esta en pantalla
 * completa (real o "pseudo", ver patchNativeCamera), recalculando justo al
 * salir -- si no, el calculo se disparaba a mitad de esa transicion con la
 * camara midiendo temporalmente el viewport entero y nada volvia a
 * corregirlo despues (asi se rompian las dimensiones tras salir). */
const MIN_CAM_WIDTH_FOR_SPLIT = 200;
const CAM_ROW_GAP = 10;
const FALLBACK_CAM_ASPECT = 16 / 9;

function patchCameraGcodeToggle() {
  const marker = document.getElementById("kxd-cam-gcode-root");
  const camWrapEl = document.getElementById("cam-wrap");
  if (!marker || !camWrapEl || !camWrapEl.parentElement) return;
  const camWrap = camWrapEl;
  const camImg = document.getElementById("cam-img") as HTMLImageElement | null;

  const row = document.createElement("div");
  row.id = "kxd-cam-gcode-row";
  // flex:1 (con min-height:0, mismo truco que ".cam-wrap" nativo) para que
  // la fila SI ocupe el alto que #card-camera (columna) le da -- sin esto
  // la fila se queda con su alto minimo/natural y camWrap no tiene contra
  // que estirarse: la imagen de camara salia encogida verticalmente en vez
  // de llenar la tarjeta.
  // align-items por defecto es "stretch" -- deliberado, no lo pises: es lo
  // que hace que camWrap llene el alto de la fila entero.
  row.style.cssText = "display:flex;gap:10px;flex:1 1 0;min-height:0";
  marker.replaceWith(row);
  row.appendChild(camWrap);
  // min-width:0 (los flex items por defecto tienen min-width:auto, que
  // impide encoger por debajo del ancho intrinseco del <img> de la camara).
  camWrap.style.minWidth = "0";

  const gcodePane = document.createElement("div");
  gcodePane.id = "kxd-cam-gcode-pane";
  // flex:0 0 auto (no crece ni encoge por reparto, solo por el ancho
  // explicito que le da sizeCameraRow) + align-self:flex-start (no
  // hereda el stretch de la fila): su tamaño lo decide sizeCameraRow, no
  // el reparto de flexbox.
  gcodePane.style.cssText = "flex:0 0 auto;min-width:0;align-self:flex-start;display:none";
  row.appendChild(gcodePane);

  const cameraCard = row.closest<HTMLElement>(".card");
  const gridEl = document.getElementById("dash-grid") as (HTMLElement & { gridstack?: GridStackLike }) | null;
  const grid = gridEl?.gridstack;
  const item = cameraCard?.closest(".grid-stack-item") as
    | (HTMLElement & { gridstackNode?: { h?: number } })
    | null
    | undefined;
  const cellHeight = grid?.getCellHeight() || 60;
  // Alto nativo de la tarjeta ANTES de tocar nada -- suelo por debajo del
  // cual nunca se encoge (camara sola, o modo pestañas).
  const baselineRows = item ? item.gridstackNode?.h ?? Math.round(item.getBoundingClientRect().height / cellHeight) : null;

  function isCamFullscreen() {
    return document.fullscreenElement === camWrap || camWrap.classList.contains("kxd-pseudo-fullscreen");
  }

  function camAspect() {
    if (camImg && camImg.naturalWidth > 0 && camImg.naturalHeight > 0) {
      return camImg.naturalWidth / camImg.naturalHeight;
    }
    return FALLBACK_CAM_ASPECT;
  }

  /** Cuanto ocupa gcodePane fuera del propio canvas cuadrado (controles de
   * capa/slider) -- no depende del ancho que se le acabe dando al cuadrado
   * (los controles no cambian de alto con el ancho), asi que medirlo antes
   * de decidir nada es seguro. El canvas vive en el shadow root que monta
   * CameraGcodeViewer (ver mount() mas abajo) -- querySelector normal NUNCA
   * lo encuentra (no cruza el limite de shadow DOM), lo que antes hacia
   * creer que "extra" era el scrollHeight ENTERO. */
  function measureGcodeExtra(): number {
    const canvas = gcodePane.shadowRoot?.querySelector("canvas") ?? null;
    const currentSquare = canvas ? canvas.getBoundingClientRect().width : 0;
    return Math.max(0, gcodePane.scrollHeight - currentSquare);
  }

  /** Reparte y ajusta la fila entera, con TRES casos posibles segun que se
   * este viendo:
   *
   * 1. Solo camara (sin gcode que enseñar, o pestaña "camara" activa en
   *    modo estrecho): alto nativo de siempre, camara a pantalla completa
   *    de la fila (flex:1, estirada via el align-items:stretch de la fila),
   *    sin tocar GridStack.
   *
   * 2. Compartido (camara + gcode a la vez, escritorio ancho): la camara se
   *    queda solo con el ancho que necesita segun su proporcion real (sin
   *    bandas negras de object-fit:contain), y el resto se lo lleva el
   *    cuadrado de gcode. H (alto objetivo) se resuelve de:
   *      camara(H) + gap + cuadrado(H) == ancho de fila
   *      camara(H) = H * proporcion_camara   (object-fit:contain, altura=H)
   *      cuadrado(H) = H - extra             (controles bajo el canvas)
   *    => H = (ancho_fila - gap + extra) / (proporcion + 1)
   *    Ninguna de esas entradas depende de H ni de una escritura previa
   *    nuestra, asi que no hay circularidad.
   *
   *    OJO: GridStack redondea el alto de fila resultante AL ALZA al
   *    siguiente multiplo de su celda (60px tipico) -- el alto REAL de la
   *    fila tras grid.update() acaba siendo un poco mayor que este H exacto.
   *    Por eso camara y cuadrado se calculan los dos a partir del MISMO H
   *    (no releyendo el alto real de la fila despues del cambio, que ya
   *    seria distinto para cada uno segun cuando se mida) -- si no, ancho
   *    camara + hueco + ancho cuadrado deja de sumar el ancho de fila y algo
   *    se sale por el lado derecho (recortado por el overflow-x:hidden de
   *    la propia tarjeta). Cualquier sobra de alto (la diferencia entre H y
   *    el alto real redondeado) se queda como hueco vacio debajo de camara
   *    y cuadrado -- alineados ambos arriba (align-self:flex-start), nunca
   *    estirados a ese sobrante -- en vez de reintroducir bandas.
   *
   * 3. Pestañas con "gcode" activo (movil/estrecho, camara oculta): aqui NO
   *    se limita a un cuadrado -- el gcode ocupa toda la fila (como cuando
   *    se ve solo) y la tarjeta CRECE o ENCOGE lo que haga falta para que
   *    quepa entero, midiendo el elemento real (cameraCard.scrollHeight, no
   *    un clon: el canvas vive en un shadow root y cloneNode no lo copia,
   *    ver growGridCardToFitContent) -- por eso es bidireccional sin mas
   *    (nunca se queda pegado a una altura de una capa anterior). */
  function sizeCameraRow() {
    if (!grid || !item || !cameraCard || baselineRows == null || isCamFullscreen()) return;
    const currentRows = item.gridstackNode?.h ?? baselineRows;
    const gcodeVisible = gcodePane.style.display !== "none";
    const camVisible = camWrap.style.display !== "none";

    if (!gcodeVisible) {
      camWrap.style.flex = "1 1 0";
      camWrap.style.width = "";
      camWrap.style.height = "";
      camWrap.style.alignSelf = "";
      if (currentRows !== baselineRows) grid.update(item, { h: baselineRows });
      return;
    }

    if (camVisible) {
      const rowWidth = row.getBoundingClientRect().width;
      if (rowWidth <= 0) return;
      const extra = measureGcodeExtra();
      // "chrome" = todo lo que hay en la tarjeta fuera de esta fila (titulo,
      // barra de pestañas) -- se resta del alto TOTAL actual de la tarjeta,
      // y como esos elementos tienen tamaño fijo (no dependen de H),
      // tampoco introduce circularidad.
      const chrome = Math.max(0, cameraCard.scrollHeight - row.getBoundingClientRect().height);
      const aspect = camAspect();
      const H = (rowWidth - CAM_ROW_GAP + extra) / (aspect + 1);

      const neededRows = Math.max(baselineRows, Math.ceil((H + chrome) / cellHeight));
      if (neededRows !== currentRows) grid.update(item, { h: neededRows });

      const square = Math.max(80, Math.round(Math.min(rowWidth, H - extra)));
      gcodePane.style.flex = "0 0 auto";
      if (gcodePane.style.width !== `${square}px`) gcodePane.style.width = `${square}px`;

      // alignSelf:flex-start + alto explicito (no el "stretch" por defecto
      // de la fila): con H sin cuantizar en vez del alto real ya mas alto,
      // que camWrap se estirase iria mas alla de H y volveria a aparecer
      // letterbox (esta vez arriba/abajo) dentro de una caja mas alta de lo
      // que su ancho fijo necesita.
      camWrap.style.flex = "0 0 auto";
      camWrap.style.alignSelf = "flex-start";
      camWrap.style.width = `${Math.round(H * aspect)}px`;
      camWrap.style.height = `${Math.round(H)}px`;
      return;
    }

    // Pestaña "gcode" activa, camara oculta.
    gcodePane.style.flex = "1 1 0";
    gcodePane.style.width = "";
    const neededRows = Math.max(baselineRows, Math.ceil((cameraCard.scrollHeight + 12) / cellHeight));
    if (neededRows !== currentRows) grid.update(item, { h: neededRows });
  }

  // El contenido de gcodePane vive en un shadow root propio (mountShadowRoot
  // mas abajo, en mount()): el visor puede tardar en resolver su fileId
  // (async) y solo entonces ocupar su alto real -- un ResizeObserver sobre
  // el propio host SI reacciona a eso, cruce o no limite de shadow DOM,
  // porque mide la caja renderizada del host. Tambien sobre "row": si su
  // ancho cambia (redimension de ventana...) hay que recalcular igual.
  new ResizeObserver(sizeCameraRow).observe(gcodePane);
  new ResizeObserver(sizeCameraRow).observe(row);
  // La proporcion real de la camara no se conoce hasta que el stream carga
  // su primer frame (antes se usa un valor de respaldo 16:9) -- al cargar,
  // recalcular con la proporcion definitiva.
  camImg?.addEventListener("load", sizeCameraRow);
  // Salir de pantalla completa (real o pseudo) es la unica transicion que
  // isCamFullscreen() ignora activamente mientras dura -- hay que forzar un
  // recalculo justo al terminar, o la tarjeta se queda con lo ultimo que
  // isCamFullscreen() SI dejo pasar (potencialmente nada, dejando valores
  // obsoletos).
  let wasFullscreen = false;
  function checkFullscreenExit() {
    const now = isCamFullscreen();
    if (wasFullscreen && !now) sizeCameraRow();
    wasFullscreen = now;
  }
  document.addEventListener("fullscreenchange", checkFullscreenExit);
  new MutationObserver(checkFullscreenExit).observe(camWrap, { attributes: true, attributeFilter: ["class"] });

  const toggleBar = document.createElement("div");
  toggleBar.id = "kxd-cam-toggle-bar";
  toggleBar.style.cssText = "display:none;gap:6px;margin-bottom:8px";
  toggleBar.innerHTML =
    '<button id="kxd-cam-tab-cam" style="padding:5px 12px;font-size:12px;border-radius:8px;border:1px solid var(--border);cursor:pointer">📷 Cámara</button>' +
    '<button id="kxd-cam-tab-gcode" style="padding:5px 12px;font-size:12px;border-radius:8px;border:1px solid var(--border);cursor:pointer">🧩 GCode</button>';
  row.parentElement!.insertBefore(toggleBar, row);

  const camBtn = toggleBar.querySelector<HTMLButtonElement>("#kxd-cam-tab-cam")!;
  const gcodeBtn = toggleBar.querySelector<HTMLButtonElement>("#kxd-cam-tab-gcode")!;

  let split = true;
  let activeTab: "cam" | "gcode" = "cam";
  let hasGcode = false;

  function paintTabs() {
    camBtn.style.background = activeTab === "cam" ? "var(--accent)" : "var(--raised)";
    camBtn.style.color = activeTab === "cam" ? "#fff" : "var(--txt)";
    gcodeBtn.style.background = activeTab === "gcode" ? "var(--accent)" : "var(--raised)";
    gcodeBtn.style.color = activeTab === "gcode" ? "#fff" : "var(--txt)";
  }

  function layout() {
    if (!hasGcode) {
      // Sin impresion activa/gcode que enseñar: la camara ocupa toda la
      // fila, exactamente como el diseño nativo original.
      toggleBar.style.display = "none";
      gcodePane.style.display = "none";
      camWrap.style.display = "";
    } else if (split) {
      toggleBar.style.display = "none";
      camWrap.style.display = "";
      gcodePane.style.display = "";
    } else {
      toggleBar.style.display = "flex";
      camWrap.style.display = activeTab === "cam" ? "" : "none";
      gcodePane.style.display = activeTab === "gcode" ? "" : "none";
      paintTabs();
    }
    sizeCameraRow();
    // gcodePane acaba de pasar de display:none a visible: si su contenido
    // (canvas con aspect-ratio, control de capa...) todavia no habia
    // podido calcular layout mientras estaba oculto, la primera medida
    // sincrona puede quedarse corta -- un segundo intento tras el primer
    // pintado normalmente ya ve el tamaño definitivo. El ResizeObserver de
    // gcodePane sigue de respaldo para cualquier cambio posterior.
    requestAnimationFrame(sizeCameraRow);
  }

  camBtn.onclick = () => {
    activeTab = "cam";
    layout();
  };
  gcodeBtn.onclick = () => {
    activeTab = "gcode";
    layout();
  };

  // Umbral adaptativo, no un ancho fijo: hay sitio para partir la fila en
  // dos si, tras reservar un cuadrado tan grande como el alto NATIVO (no el
  // ya agrandado por sizeCameraRow -- eso crearia un vaiven: partir en dos
  // agranda la fila, una fila mas alta hace fallar este mismo umbral,
  // vuelve a modo pestañas, la fila encoge a su alto nativo, el umbral
  // vuelve a cumplirse, y de nuevo a partir en dos... este umbral se mide
  // siempre contra el alto de reposo, no el que la propia decision acaba de
  // producir) de la fila para el gcode, a la camara le queda al menos un
  // ancho minimo usable.
  new ResizeObserver(() => {
    const rowRect = row.getBoundingClientRect();
    const baselineHeight = (baselineRows ?? 0) * cellHeight;
    const wide = rowRect.width - baselineHeight - CAM_ROW_GAP >= MIN_CAM_WIDTH_FOR_SPLIT;
    if (wide !== split) {
      split = wide;
      layout();
    }
  }).observe(row);

  setCamGcodeAvailable = (v) => {
    hasGcode = v;
    layout();
  };
  layout();
}

function Widgets() {
  const { data } = useKxState();
  // Antes vivia solo en Layout.tsx (la SPA de /kxdeck) -- desde que la home
  // es el panel de KX-Bridge (ver kx_home.py), tener esa SPA cerrada ya no
  // significa "no hay ninguna pestana de KXDeck abierta": esta es la
  // pestana que de verdad esta abierta la mayor parte del tiempo, asi que
  // tiene que comparar transiciones de estado igual que alli para que las
  // notificaciones no dependan de visitar /kxdeck a proposito. Ya no
  // renderiza nada visible propio -- el visor de gcode ahora comparte
  // tarjeta con la camara (ver CameraGcodeViewer) y el aviso de saltar
  // objetos duplicaba el dialogo nativo "✂ Objekte überspringen".
  useNotificationEvents(data);
  return null;
}

/** El componente Spool usa "shrink-0 overflow-visible" (clases Tailwind);
 * en la pagina nativa de KX-Bridge no hay hoja de Tailwind cargada, asi que
 * se replica ese unico efecto (overflow visible -- el hilo/aro se sale del
 * viewBox al animarse) directamente por estilo, sin depender de esas
 * clases. Las animaciones spool-spin/spool-sway si hacen falta como
 * @keyframes reales (ver injectSpoolKeyframes) porque Spool las referencia
 * por nombre via CSS, no inline. */
function injectSpoolKeyframes() {
  if (document.getElementById("kxd-spool-keyframes")) return;
  const style = document.createElement("style");
  style.id = "kxd-spool-keyframes";
  style.textContent = "@keyframes spool-spin{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}";
  document.head.appendChild(style);
}

/** Safari/iOS no implementa requestFullscreen() para elementos normales
 * (solo para <video>, y la camara aqui es un <img> de MJPEG) -- ahi la
 * llamada nativa no existe o falla en silencio, que es justo lo que hacia
 * que el boton "no hiciera nada" en movil. Como respaldo universal (sirve
 * en cualquier navegador, no solo donde falta la API real), se ofrece un
 * modo pantalla completa por CSS: el propio #cam-wrap pasa a position:fixed
 * cubriendo todo el viewport. Se intenta primero la API nativa (mejor,
 * oculta tambien la barra del navegador donde SI esta soportada) y se cae
 * a este modo si no esta disponible o si la promesa falla. */
function injectPseudoFullscreenStyle() {
  if (document.getElementById("kxd-fullscreen-style")) return;
  const style = document.createElement("style");
  style.id = "kxd-fullscreen-style";
  style.textContent =
    "#cam-wrap.kxd-pseudo-fullscreen{position:fixed!important;inset:0!important;" +
    "width:100vw!important;height:100vh!important;max-height:100vh!important;" +
    "z-index:99999!important;border-radius:0!important;background:#000}" +
    "#cam-wrap.kxd-pseudo-fullscreen img,#cam-wrap.kxd-pseudo-fullscreen video{" +
    "max-height:100vh!important;height:100%!important}";
  document.head.appendChild(style);
}

// SVG en vez de los glifos Unicode "⛶"/"⤡": esos dos caracteres no estan
// cubiertos por la fuente por defecto en bastantes sistemas de escritorio
// (Windows sin fuente de emoji instalada, algunas distros Linux...), y sin
// glifo el navegador los sustituye por el cuadrado vacio de "caracter no
// disponible" (tofu) -- que es justo lo que se veia en vez de un icono.
const FULLSCREEN_ICON = renderToStaticMarkup(<Maximize2 size={16} />);
const EXIT_FULLSCREEN_ICON = renderToStaticMarkup(<Minimize2 size={16} />);

function togglePseudoFullscreen(wrap: HTMLElement, btn: HTMLButtonElement) {
  const active = wrap.classList.toggle("kxd-pseudo-fullscreen");
  btn.innerHTML = active ? EXIT_FULLSCREEN_ICON : FULLSCREEN_ICON;
}

/** Añade un boton de pantalla completa a la tarjeta de camara NATIVA de
 * KX-Bridge (no la tocamos mas: sigue siendo su propio stream/lógica). Esa
 * tarjeta es markup estatico (a diferencia de los slots de filamento, no se
 * reescribe por sondeo), asi que basta con insertarlo una vez. */
function patchNativeCamera() {
  const anchor = document.getElementById("cam-reset-btn");
  const wrap = document.getElementById("cam-wrap");
  if (!anchor || !wrap || document.getElementById("cam-fullscreen-btn")) return;
  injectPseudoFullscreenStyle();

  const btn = document.createElement("button");
  btn.className = "cam-toggle";
  btn.id = "cam-fullscreen-btn";
  btn.title = "Pantalla completa";
  // .cam-toggle es position:absolute;top:10px;right:10px -- ahi es donde ya
  // vive el boton "Camara" (y a veces tambien el de reset tras un 429), asi
  // que se ancla a la esquina opuesta en vez de reusar right, para no
  // superponerse pase lo que pase con el resto de botones.
  btn.style.right = "auto";
  btn.style.left = "10px";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.innerHTML = FULLSCREEN_ICON;
  btn.onclick = () => {
    const supportsNative = document.fullscreenEnabled && typeof wrap.requestFullscreen === "function";
    if (wrap.classList.contains("kxd-pseudo-fullscreen")) {
      togglePseudoFullscreen(wrap, btn);
      return;
    }
    if (!supportsNative) {
      togglePseudoFullscreen(wrap, btn);
      return;
    }
    if (!document.fullscreenElement) {
      wrap.requestFullscreen().catch(() => togglePseudoFullscreen(wrap, btn));
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };
  document.addEventListener("fullscreenchange", () => {
    btn.innerHTML = document.fullscreenElement === wrap ? EXIT_FULLSCREEN_ICON : FULLSCREEN_ICON;
  });
  anchor.insertAdjacentElement("afterend", btn);
}

/** Un interruptor por cada luz de Home Assistant configurada, junto al de
 * la luz de la camara nativo (#d-light-toggle). El estado DE VERDAD llega
 * en vivo del websocket (data.ha_lights, ver
 * backend/kxdeck_api.py::h_kxdeck_ws) -- solo cambia cuando la
 * automatizacion de HA avisa a KXDeck (ver backend/ha_settings.py), lo
 * que da un par de saltos de red completos (KXDeck->HA->enciende la luz
 * de verdad->HA->KXDeck) mas el propio sondeo del websocket (hasta 1.5s) --
 * varios segundos en total antes de que el interruptor reflejase el
 * cambio si se esperase solo a eso, aunque la orden ya hubiera llegado
 * bien a HA casi al instante.
 *
 * Por eso el interruptor se mueve YA al pulsarlo (optimista, como
 * cualquier interruptor de luz de verdad), en cuanto KXDeck confirma que
 * la llamada a HA salio bien -- no hace falta esperar la vuelta completa
 * para verlo. Ese valor optimista se descarta en cuanto el estado REAL
 * (el que viene del webhook de HA) lo alcanza -- confirmandolo, nunca
 * corrigiendolo silenciosamente antes de tiempo -- o, como red de
 * seguridad, a los 8s si ese eco no llega nunca (mejor volver a "lo que
 * diga el ultimo dato real" que fiarse de una prediccion para siempre).
 *
 * Sin shadow DOM a proposito (a diferencia del resto de tarjetas de
 * KXDeck): usa las clases nativas ".toggle/.toggle-track/.toggle-thumb"
 * de KX-Bridge para verse identico al interruptor de al lado, y esas
 * clases no cruzan un limite de shadow root -- createRoot() no necesita
 * uno, monta sobre cualquier nodo. */
function HaLightToggles() {
  const { data } = useKxState();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [optimistic, setOptimistic] = useState<Map<string, boolean>>(new Map());
  const lights = data?.ha_lights ?? [];

  // Cada tick del websocket manda el estado ENTERO (cambie algo o no, ver
  // h_kxdeck_ws) -- por eso esto no puede limpiarse sin mas en cuanto
  // "llega dato nuevo": borraria el optimista en el siguiente tick (~1.5s
  // despues de pulsar), bastante antes de que el eco real de HA hubiera
  // podido llegar, y se veria el interruptor "rebotar" de vuelta al
  // estado viejo un instante. Solo se borra cuando el valor real YA
  // COINCIDE con lo que se predijo -- eso es la confirmacion de verdad.
  useEffect(() => {
    if (!data || optimistic.size === 0) return;
    setOptimistic((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const light of lights) {
        if (next.has(light.id) && light.on === next.get(light.id)) {
          next.delete(light.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function toggle(id: string, currentlyShown: boolean) {
    const predicted = !currentlyShown;
    setOptimistic((prev) => new Map(prev).set(id, predicted));
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await apiPost(`/api/kxdeck/ha/lights/${id}/toggle`);
    } catch {
      // Ni siquiera ha llegado a HA -- deshace el optimista, no hay nada
      // real que esperar.
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      window.setTimeout(() => {
        setOptimistic((prev) => {
          if (!prev.has(id)) return prev; // ya lo confirmo el eco real, nada que hacer
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, 8000);
    }
  }

  if (lights.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
      {lights.map((light) => {
        const shown = optimistic.has(light.id) ? optimistic.get(light.id)! : light.on === true;
        return (
          <div key={light.id} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", color: "var(--txt2)" }}>💡 {light.label}</span>
            <label className="toggle">
              <input
                type="checkbox"
                checked={shown}
                disabled={pendingIds.has(light.id)}
                onChange={() => {}}
                // onClick + preventDefault, no onChange: un checkbox
                // controlado deja que el navegador cambie el DOM el
                // mismo al pulsar (antes de que React llegue a re-
                // renderizar) -- si CUALQUIER otra cosa (el propio
                // sondeo del websocket, tipicamente) fuerza un
                // re-render de por medio antes de que el estado
                // optimista se aplique, React "corrige" el DOM de
                // vuelta al valor viejo un instante, y se ve el
                // interruptor volver atras y luego saltar al bueno.
                // Bloqueando el cambio nativo del navegador y
                // decidiendo el valor SIEMPRE nosotros (via "shown")
                // no hay ningun momento en el que React y el DOM
                // puedan discrepar.
                onClick={(e) => {
                  e.preventDefault();
                  toggle(light.id, shown);
                }}
              />
              <span className="toggle-track" />
              <span className="toggle-thumb" />
            </label>
          </div>
        );
      })}
    </div>
  );
}

/** Inserta el hueco (#kxd-ha-light-root) donde mount() monta HaLightToggles,
 * DENTRO del grupo nativo de la luz de la camara (#d-light-toggle envuelto
 * en "display:flex;align-items:center;gap:10px"), no como hermano suyo.
 *
 * El PADRE de ese grupo es "display:flex;justify-content:space-between"
 * con solo dos hijos (el titulo "CÁMARA" y este grupo de la luz) -- meter
 * el hueco como un TERCER hermano ahi hacia que space-between lo repartiera
 * como tres bloques (titulo a la izquierda, luz nativa en MEDIO, luz de HA
 * a la derecha), separando el interruptor nativo del de HA en vez de
 * dejarlos juntos. Metiendolo dentro del grupo de la luz (que ya es
 * flex con su propio gap), space-between lo sigue viendo como un unico
 * bloque de dos hijos -- ambos interruptores quedan juntos y pegados a la
 * derecha, como el nativo ya estaba.
 *
 * El propio componente se auto-oculta (return null) si no hay ninguna luz
 * configurada, asi que insertar el hueco siempre es seguro. */
function patchNativeCameraLight() {
  const lightInput = document.getElementById("d-light-toggle");
  const lightRow = lightInput?.closest<HTMLElement>("div");
  if (!lightRow || document.getElementById("kxd-ha-light-root")) return;

  const root = document.createElement("span");
  root.id = "kxd-ha-light-root";
  // display:contents: sus hijos (el div de HaLightToggles) participan del
  // flex de "lightRow" como si fueran hijos directos suyos -- el propio
  // <span> no aporta ninguna caja que descuadre el gap:10px del padre.
  root.style.display = "contents";
  lightRow.appendChild(root);
}

/** El propio KX-Bridge YA tiene un modo de sidebar solo-iconos (ver su CSS
 * nativo: "@media(min-width:769px) and (max-width:1100px){nav.sidebar{
 * width:52px}.nav-btn .nav-text{display:none}...}"), pero solo se activa
 * automaticamente en ese rango de anchos de tablet -- no hay forma de
 * elegirlo a mano en escritorio ancho. Aqui se repite esa misma regla bajo
 * una clase propia (".kxd-sidebar-collapsed") para poder activarla a
 * cualquier ancho, mas un boton al final del menu para alternarla, con la
 * eleccion recordada en localStorage. */
const SIDEBAR_COLLAPSE_KEY = "kxdeck.sidebarCollapsed";

function injectSidebarCollapseStyle() {
  if (document.getElementById("kxd-sidebar-collapse-style")) return;
  const style = document.createElement("style");
  style.id = "kxd-sidebar-collapse-style";
  style.textContent =
    "nav.sidebar.kxd-sidebar-collapsed{width:52px!important;padding:12px 4px!important}" +
    "nav.sidebar.kxd-sidebar-collapsed .nav-btn .nav-text{display:none!important}" +
    "nav.sidebar.kxd-sidebar-collapsed .nav-btn{justify-content:center!important;padding:10px!important}" +
    "nav.sidebar.kxd-sidebar-collapsed .nav-icon{width:auto!important}";
  document.head.appendChild(style);
}

/** El <footer> nativo ("© ViewIT ...") vive fuera de <main>, como ultimo
 * hijo de <body> -- con el body fijado a 100vh/overflow:hidden (ver
 * _HEAD_EXTRA en kx_home.py, necesario para que la barra lateral nunca
 * scrollee) eso lo deja SIEMPRE a la vista, pegado abajo del viewport, en
 * vez de comportarse como un pie de pagina normal (solo visible al bajar
 * del todo). Se MUEVE (no se clona) dentro de <main>, la unica zona con
 * scroll propio -- vuelve a aparecer solo al final del contenido. */
function patchFooterIntoMain() {
  const footer = document.querySelector("footer");
  const main = document.querySelector("main");
  if (!footer || !main || footer.parentElement === main) return;
  main.appendChild(footer);
}

/** Reenvia la rueda del raton sobre nav.sidebar hacia <main> -- son
 * HERMANOS (ambos hijos de .layout, ni ancestro ni descendiente el uno del
 * otro), asi que el "scroll chaining" nativo del navegador (al pasar la
 * rueda sobre un elemento sin nada que scrollear el mismo, sube por sus
 * ANCESTROS buscando el primero que si pueda) nunca llega a main: desde
 * nav.sidebar sube a .layout (sin overflow propio) y a body
 * (overflow:hidden A PROPOSITO, ver _HEAD_EXTRA en kx_home.py, para que el
 * sidebar no se arrastre fuera de la pantalla si la pagina scrollea) -- y
 * ahi se corta, sin llegar nunca a main (que si tiene overflow-y:auto,
 * pero es un hermano, no un ancestro). Antes de este fix, pasar el raton
 * por el sidebar (su caso normal: 5 botones, nunca llega a desbordar la
 * ventana) no scrolleaba nada en absoluto.
 *
 * Solo actua cuando el sidebar NO tiene nada que scrollear el mismo
 * (scrollHeight<=clientHeight) -- si alguna vez si lo tiene (ver el propio
 * "overflow-y:auto" nativo anadido en _HEAD_EXTRA, para una lista de
 * impresoras/botones mas larga que la ventana), se le deja su
 * comportamiento nativo intacto, sin interceptarlo. */
function patchSidebarWheelForwarding() {
  const sidebar = document.querySelector<HTMLElement>("nav.sidebar");
  const main = document.querySelector<HTMLElement>("main");
  if (!sidebar || !main) return;
  sidebar.addEventListener(
    "wheel",
    (e) => {
      if (sidebar.scrollHeight > sidebar.clientHeight) return;
      // WheelEvent.deltaY no siempre viene en pixeles: deltaMode distingue
      // pixel (0, lo habitual con trackpad/raton moderno -- sumar tal cual
      // ya coincide con lo que hace un scroll nativo), linea (1, tipico de
      // un raton de rueda clasico en Firefox/Windows: cada evento trae un
      // numero pequeño, 3 lineas, no 3px) y pagina (2, raro). Sumar deltaY
      // tal cual sin mirar el modo (como se hacia antes) solo es correcto
      // en modo pixel -- en modo linea el sidebar se movia una fraccion
      // diminuta de lo que se moveria la pagina con el mismo gesto, y de
      // ahi el ritmo distinto que notaste. 16px/linea es la misma
      // aproximacion que usan la mayoria de navegadores para su propia
      // conversion nativa.
      const LINE_HEIGHT_PX = 16;
      const delta =
        e.deltaMode === 1 ? e.deltaY * LINE_HEIGHT_PX : e.deltaMode === 2 ? e.deltaY * main.clientHeight : e.deltaY;
      main.scrollTop += delta;
      e.preventDefault();
    },
    { passive: false },
  );
}

function patchSidebarCollapse() {
  const sidebar = document.querySelector<HTMLElement>("nav.sidebar");
  if (!sidebar || document.getElementById("kxd-sidebar-toggle")) return;
  injectSidebarCollapseStyle();

  if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1") {
    sidebar.classList.add("kxd-sidebar-collapsed");
  }

  const btn = document.createElement("button");
  btn.className = "nav-btn";
  btn.id = "kxd-sidebar-toggle";
  // margin-top:auto (la sidebar ya es "display:flex;flex-direction:column"
  // nativamente) para que quede pegado abajo del todo, separado del resto
  // de botones de navegacion -- es un control del propio menu, no un enlace
  // a un panel mas.
  btn.style.marginTop = "auto";

  function paint() {
    const collapsed = sidebar!.classList.contains("kxd-sidebar-collapsed");
    btn.innerHTML = `<span class="nav-icon">${collapsed ? "»" : "«"}</span>`;
    btn.title = collapsed ? "Expandir menú" : "Comprimir menú";
  }

  btn.onclick = () => {
    const collapsed = sidebar.classList.toggle("kxd-sidebar-collapsed");
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0");
    paint();
  };

  sidebar.appendChild(btn);
  paint();
}

/** Mueve la version de KX-Bridge de la cabecera al pie de pagina. Es el
 * mismo elemento (#h-version), no una copia: su contenido lo sigue
 * escribiendo el propio KX-Bridge por ID en cada sondeo, asi que basta con
 * reubicarlo una vez -- no hace falta duplicar esa logica ni vigilarlo. */
/** Sustituye el simple circulo de color de cada slot de la tarjeta NATIVA
 * de filamento/AMS por la bobina de KXDeck (mismo color, mismo estado
 * activo/vacio) -- todo lo demas de esa tarjeta (clic para editar, badges,
 * dropdown de Spoolman, datos) sigue siendo el de KX-Bridge tal cual.
 *
 * #ams-slots se reescribe ENTERO (innerHTML) en cada sondeo de estado de
 * KX-Bridge (cada ~1-2s) -- por eso esto va por MutationObserver en vez de
 * una pasada unica: cada circulo nuevo hay que volver a parchearlo. Se
 * guarda una firma (color+estado) en un data-attribute para no
 * re-renderizar cuando no ha cambiado nada real, solo el DOM se ha
 * regenerado con los mismos valores. */
interface GridStackLike {
  update(el: Element, opts: { h?: number }): void;
  getCellHeight(): number;
}

/** GridStack le da a cada tarjeta una altura fija en su propio sistema de
 * filas (pensada para el circulo de color pequeno de antes) -- al agrandar
 * las bobinas, el contenido dejaba de caber y aparecia scroll dentro de la
 * tarjeta.
 *
 * Primer intento: forzar la altura por CSS directamente. No sirve --
 * GridStack recalcula la altura del contenedor #dash-grid a partir de sus
 * propios datos internos (fila/alto por tarjeta) en algun momento tras la
 * carga, y como esos datos seguian diciendo "4 filas" para esta tarjeta,
 * lo que yo hubiera puesto por CSS se acababa deshaciendo.
 *
 * Version buena: usar su propia API publica (grid.update), que SI
 * actualiza ese dato interno -- asi el propio GridStack recalcula el
 * contenedor y la posicion de cualquier tarjeta siguiente correctamente,
 * sin pelearse con el.
 *
 * Solo crecia, nunca encogia: card.scrollHeight delata que FALTA sitio,
 * pero si el contenido se queda mas corto que el alto ya asignado,
 * scrollHeight se queda igualado a ese alto (no baja al alto real del
 * contenido) -- una fila que aparecio una vez y luego se oculta dejaba la
 * tarjeta con un hueco enorme para siempre. Para medir el alto NATURAL de
 * verdad (crezca o encoja) se mide en un clon fuera de pantalla con altura
 * libre, no en la tarjeta real -- asi no hay parpadeo visible por ir
 * probando alturas en la tarjeta que se ve. Ojo: cloneNode no copia el
 * contenido de ningun shadow root de dentro (por diseño del propio DOM),
 * asi que esto solo vale para tarjetas sin nada inyectado en shadow DOM
 * (Progreso, Temperaturas) -- la de Camara tiene su propia medida en
 * patchCameraGcodeToggle/sizeCameraRow por eso mismo.
 *
 * Se clona el PADRE (".grid-stack-item-content"), no la tarjeta suelta: el
 * propio CSS nativo de KX-Bridge tiene reglas que dependen de ese padre
 * exacto por combinador directo, p.ej.
 * ".grid-stack-item-content>#card-progress{display:flex;flex-direction:
 * column;min-height:0}" -- clonar solo la tarjeta y colgarla directamente
 * de <body> hace que esa regla deje de aplicar (dejar de ser hijo directo
 * de ".grid-stack-item-content"), la tarjeta clonada vuelve a su layout de
 * bloque por defecto, y con eso el margen entre alguno de sus hijos SI
 * colapsa (en flex nunca colapsa) -- una tarjeta clonada asi media
 * sistematicamente unos px de menos que la real (confirmado: 527 clonando
 * solo la tarjeta, 533 la tarjeta real, en escritorio con Progreso). */
function growGridCardToFitContent(card: HTMLElement) {
  const gridEl = document.getElementById("dash-grid") as (HTMLElement & { gridstack?: GridStackLike }) | null;
  const grid = gridEl?.gridstack;
  const item = card.closest(".grid-stack-item") as (HTMLElement & { gridstackNode?: { h?: number } }) | null;
  const parent = card.parentElement;
  if (!grid || !item || !parent) return;

  const cellHeight = grid.getCellHeight() || 60;
  const currentRows = item.gridstackNode?.h ?? Math.round(item.getBoundingClientRect().height / cellHeight);

  const cardIndex = Array.prototype.indexOf.call(parent.children, card);
  const wrapper = parent.cloneNode(true) as HTMLElement;
  wrapper.style.cssText =
    "position:fixed;top:-9999px;left:0;visibility:hidden;height:auto;max-height:none;overflow:visible;" +
    `width:${parent.getBoundingClientRect().width}px`;
  document.body.appendChild(wrapper);
  const clonedCard = wrapper.children[cardIndex] as HTMLElement;
  clonedCard.style.height = "auto";
  clonedCard.style.maxHeight = "none";
  const naturalHeight = clonedCard.scrollHeight;
  wrapper.remove();

  const neededRows = Math.max(1, Math.ceil((naturalHeight + 12) / cellHeight));
  if (neededRows !== currentRows) grid.update(item, { h: neededRows });
}

// Duraciones de las animaciones de Spool.tsx, repetidas aqui (no hay forma
// de leerlas desde el CSS inyectado) para poder calcular el desfase de
// animation-delay que evita el "tironeo" al reconstruir los circulos (ver
// patchOne mas abajo).
const SPOOL_SPIN_MS = 32000;
const THREAD_BELLY_PERIOD_MS = 9000;

/** Anima la "barriga" del hilo (path.spool-thread) de izquierda a derecha y
 * vuelta -- recalculando el propio atributo "d" en cada frame, no por CSS:
 * la forma exacta depende de tx/ty/w/h de ESTA instancia (Spool.tsx las deja
 * en data-*), asi que un @keyframes fijo no serviria para tamaños distintos
 * a la vez. Usar Date.now() en cada frame (en vez de una duracion+desfase
 * fijados una vez, como con la rueda) da continuidad gratis aunque
 * KX-Bridge reconstruya el circulo entero en cada sondeo: no hay "instante
 * de arranque" que recordar, la fase de HOY siempre sale del reloj real.
 * slotIndex desfasa cada ranura para que no oscilen todas a una. Se
 * autodetiene sola en cuanto el propio <path> deja de estar en el DOM (el
 * sondeo siguiente lo sustituye por uno nuevo, con su propio bucle). */
function animateThreadBelly(path: SVGPathElement, slotIndex: number) {
  const tx = Number(path.dataset.tx);
  const ty = Number(path.dataset.ty);
  const ex = Number(path.dataset.ex);
  const ey = Number(path.dataset.ey);
  const w = Number(path.dataset.w);
  const h = Number(path.dataset.h);
  if ([tx, ty, ex, ey, w, h].some((n) => Number.isNaN(n))) return;

  // Asimetrico: x positivo es hacia la derecha en el propio viewBox (SVG
  // estandar, sin ningun flip) -- misma amplitud hacia la izquierda
  // (leftAmplitude) y algo menos hacia la derecha (rightAmplitude).
  const leftAmplitude = w * 0.03;
  const rightAmplitude = w * 0.03 * 0.55;
  const phaseOffset = (slotIndex * THREAD_BELLY_PERIOD_MS) / 6;

  function frame() {
    if (!path.isConnected) return;
    const t = ((Date.now() + phaseOffset) % THREAD_BELLY_PERIOD_MS) / THREAD_BELLY_PERIOD_MS;
    const s = Math.sin(t * Math.PI * 2);
    const bx = s * (s >= 0 ? rightAmplitude : leftAmplitude);
    path.setAttribute(
      "d",
      `M ${tx},${ty} C ${tx + bx},${ty + h * 0.06} ${tx + bx},${ty + h * 0.11} ${ex},${ey}`,
    );
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function patchNativeFilamentIcons() {
  const el = document.getElementById("ams-slots");
  if (!el) return;
  const container = el;

  function patchOne(circle: HTMLElement, slotIndex: number) {
    // Guardia puesta ANTES de tocar el DOM: escribir innerHTML/background
    // mas abajo dispara este mismo MutationObserver (subtree:true) otra
    // vez -- sin esta guardia, ese segundo pase se disparaba sobre el
    // circulo ya modificado y volvia a leer su color (ya puesto a
    // "transparent" por el primer pase) en vez del real, pintando todo en
    // negro. Al ser siempre elementos nuevos (KX-Bridge reescribe
    // #ams-slots entero en cada sondeo), un simple "ya tocado" basta -- no
    // hace falta comparar contenido.
    if (circle.dataset.kxdPatched) return;
    circle.dataset.kxdPatched = "1";

    const slot = circle.closest(".ams-slot") as HTMLElement | null;
    if (!slot) return;
    const empty = slot.classList.contains("empty");
    const active = slot.classList.contains("loaded");
    // Del padre (su --slot-color), no del propio circulo: este ultimo se
    // deja sin fondo mas abajo, asi que una relectura futura ya no lo
    // tendria disponible.
    const raw = slot.style.getPropertyValue("--slot-color") || getComputedStyle(circle).backgroundColor;
    const rgb = raw.match(/\d+/g);
    const hex = rgb
      ? "#" + rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")
      : "#888888";
    // .slot-circle trae ademas width/height:36px fijos y un borde propio
    // (border:2px solid rgba(255,255,255,.15)) pensados para el antiguo
    // circulo de color solido -- sin limpiarlos tambien, quedaba ese
    // borde como un aro vacio detras de la bobina, y el tamano real de la
    // bobina (mayor que 36px, como en el widget original) se recortaba.
    circle.style.background = "transparent";
    circle.style.border = "none";
    circle.style.width = "auto";
    circle.style.height = "auto";
    circle.style.display = "flex";
    circle.style.alignItems = "center";
    circle.style.justifyContent = "center";
    circle.innerHTML = renderToStaticMarkup(<Spool color={hex} size={56} active={active} empty={empty} />);
    const svg = circle.querySelector("svg");
    if (svg) svg.style.overflow = "visible";

    // KX-Bridge reescribe "#ams-slots" ENTERO en cada sondeo de estado
    // (~1-2s, ver el propio JS nativo: "ams-slots').innerHTML=html"), asi
    // que esta bobina es un elemento nuevo cada vez -- sin esto, su
    // animacion CSS arrancaba de cero en cada sondeo (tironeo constante en
    // vez de un giro continuo). Con un animation-delay NEGATIVO calculado a
    // partir del reloj real, el elemento recien creado "entra" ya en el
    // punto del ciclo en el que estaria si llevara girando sin parar desde
    // siempre -- no hay salto visible. slotIndex desfasa cada ranura una
    // cantidad fija (estable entre sondeos, el orden de las ranuras no
    // cambia) para que las bobinas activas no giren todas perfectamente a
    // la vez.
    if (active) {
      const wheel = circle.querySelector<HTMLElement>(".spool-wheel");
      if (wheel) {
        const now = Date.now();
        const offset = (slotIndex * SPOOL_SPIN_MS) / 6;
        const phase = (((now - offset) % SPOOL_SPIN_MS) + SPOOL_SPIN_MS) % SPOOL_SPIN_MS;
        wheel.style.animationDelay = `-${phase / 1000}s`;
      }
      const thread = circle.querySelector<SVGPathElement>(".spool-thread");
      if (thread) animateThreadBelly(thread, slotIndex);
    }
  }

  function patchAll() {
    container.querySelectorAll<HTMLElement>(".slot-circle").forEach((circle, idx) => patchOne(circle, idx));
    const card = document.getElementById("d-ams-card");
    if (card) growGridCardToFitContent(card);
  }

  patchAll();
  new MutationObserver(patchAll).observe(container, { childList: true, subtree: true });
}

/** Tira de bobinas pequeñas entre el titulo y el video de la tarjeta de
 * Camara (#kxd-cam-filament-root, marcador insertado en kx_home.py justo
 * antes de #kxd-cam-gcode-root/#cam-wrap) -- mismo dato que la tarjeta de
 * Filamento (#ams-slots) y el mismo componente <Spool> que
 * patchNativeFilamentIcons, para ver de un vistazo que carrete esta
 * alimentando la impresion sin cambiar de tarjeta.
 *
 * Fuera de React, igual que patchNativeFilamentIcons (a diferencia de
 * HaLightToggles): reutiliza animateThreadBelly/SPOOL_SPIN_MS tal cual, que
 * leen/escriben el DOM real directamente, no estado de React. Tambien sin
 * shadow DOM por lo mismo -- la animacion de la rueda depende del
 * @keyframes global que injectSpoolKeyframes() pone en <head>, y un shadow
 * root no lo veria sin repetirlo ahi dentro tambien.
 *
 * #ams-slots se reescribe entero en cada sondeo de KX-Bridge (igual que en
 * patchNativeFilamentIcons) -- por eso esto tambien observa por
 * MutationObserver en vez de pintar una vez. Ignora la ranura-puente
 * (.ams-slot-bridge, el hueco "ACE" sin color/estado propios) y, si no hay
 * ningun slot todavia (impresora sin AMS o sin datos), deja el hueco vacio
 * en vez de mostrar una tira sin nada dentro.
 *
 * Al pasar el raton por una bobina, si el visor de gcode de al lado esta
 * visible, resalta ahi el trazado de ese canal (ver camGcodeSetHighlightTool,
 * junto a CameraGcodeViewer).
 *
 * Los canales que la impresion EN CURSO no va a usar (ver setCamGcodeUsedTools,
 * junto a CameraGcodeViewer -- que gcode_filaments diga is_used, no si el
 * AMS tiene o no filamento fisico ahi) se quedan en gris/"no disponible":
 * grayscale + opacidad reducida, sin halo ni hover -- una ranura con
 * filamento cargado pero que este trabajo no toca no debe verse igual de
 * "en juego" que las que si. usedTools empieza en null (no se sabe todavia,
 * o sin impresion) -- en ese caso ninguna bobina se atenua, nunca se apaga
 * la tira entera solo por no haber cargado el dato aun. */
function patchCameraFilamentStrip() {
  const root = document.getElementById("kxd-cam-filament-root");
  const amsEl = document.getElementById("ams-slots");
  if (!root || !amsEl) return;

  let usedTools: Set<number> | null = null;
  setCamGcodeUsedTools = (tools) => {
    usedTools = tools;
    paint();
  };

  function paint() {
    const slots = Array.from(amsEl!.querySelectorAll<HTMLElement>(".ams-slot:not(.ams-slot-bridge)"));
    if (slots.length === 0) {
      root!.replaceChildren();
      return;
    }

    root!.style.display = "flex";
    root!.style.alignItems = "center";
    root!.style.gap = "8px";
    root!.style.marginBottom = "10px";
    root!.innerHTML = slots
      .map((slot) => {
        const empty = slot.classList.contains("empty");
        const active = slot.classList.contains("loaded");
        const raw = slot.style.getPropertyValue("--slot-color") || "";
        const rgb = raw.match(/\d+/g);
        const hex = rgb
          ? "#" + rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")
          : "#888888";
        return renderToStaticMarkup(<Spool color={hex} size={26} active={active} empty={empty} />);
      })
      .join("");

    slots.forEach((slot, i) => {
      const svg = root!.children[i] as SVGElement | undefined;
      if (!svg) return;

      const unavailable = usedTools != null && !usedTools.has(i);
      svg.style.filter = unavailable ? "grayscale(1)" : "";
      svg.style.opacity = unavailable ? "0.4" : "1";
      if (unavailable) return;

      // Al pasar el raton por una bobina, si el visor de gcode esta VISIBLE
      // ahora mismo (compartiendo hueco con la camara, ver
      // patchCameraGcodeToggle -- gcodePane pasa a display:none en el resto
      // de casos: sin impresion activa, o pestaña "camara" seleccionada en
      // movil), se resalta ahi el trazado de ese mismo canal -- mismo
      // indice de slot que ya usa KX-Bridge para el color de la ranura (ver
      // fd-slots/dataset.paint, mismo convenio que patchFilamentDialogPreview
      // usa para su propia vista previa). El puente es camGcodeSetHighlightTool
      // (variable de modulo, ver CameraGcodeViewer): sigue null si el visor
      // ni siquiera esta montado (funcion cameraGcode desactivada, o sin
      // impresion en curso), asi que la llamada es un no-op seguro.
      svg.style.cursor = "pointer";
      svg.addEventListener("mouseenter", () => {
        const pane = document.getElementById("kxd-cam-gcode-pane");
        if (pane && pane.style.display !== "none") camGcodeSetHighlightTool?.(i);
      });
      svg.addEventListener("mouseleave", () => camGcodeSetHighlightTool?.(null));

      if (!slot.classList.contains("loaded")) return;
      // Halo con el color de acento (var(--accent), ya en document.documentElement
      // via applyAccent -- este strip vive en DOM normal, sin shadow root de
      // por medio) para que la bobina EN USO se distinga de un vistazo del
      // resto, sin depender solo del giro/hilo animado.
      svg.style.filter = "drop-shadow(0 0 4px var(--accent))";
      const wheel = svg.querySelector<HTMLElement>(".spool-wheel");
      if (wheel) {
        const now = Date.now();
        const offset = (i * SPOOL_SPIN_MS) / 6;
        const phase = (((now - offset) % SPOOL_SPIN_MS) + SPOOL_SPIN_MS) % SPOOL_SPIN_MS;
        wheel.style.animationDelay = `-${phase / 1000}s`;
      }
      const thread = svg.querySelector<SVGPathElement>(".spool-thread");
      if (thread) animateThreadBelly(thread, i);
    });
  }

  paint();
  new MutationObserver(paint).observe(amsEl, { childList: true, subtree: true });
}

/** La tarjeta PROGRESO tiene, ademas, filas que KX-Bridge oculta con
 * display:none mientras no hay impresion activa (p.ej. #d-slicer-row, el
 * tiempo estimado del slicer -- ver applyState() en su propio JS) y
 * revela solo durante una impresion real. Al no existir esas filas
 * mientras se prueba en reposo, el mismo problema de altura fija de
 * GridStack que ya afectaba a la tarjeta de Filamento (ver
 * growGridCardToFitContent) pasaba desapercibido -- aqui es igual de
 * reactivo: cualquier cambio de estilo/contenido dentro de la tarjeta
 * (fila que aparece/desaparece) vuelve a comprobar si ya no cabe. */
/** Igual que growGridCardToFitContent, pero reactivo: vuelve a comprobar
 * ante CUALQUIER cambio dentro de la tarjeta, no solo una vez al montar.
 * Usado para "Progreso", "Temperaturen" y "Cámara" (ver mount()) -- las
 * tres son tarjetas de GridStack con una fila de filas fija (gs-h) que no
 * se ajusta sola a contenido dinamico (texto que aparece/desaparece,
 * pestaña camara/gcode que cambia...), asi que por defecto GridStack les
 * mete scroll interno en vez de crecer. */
function patchGrowingCard(cardId: string) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const check = () => growGridCardToFitContent(card);
  check();
  // applyState() (el propio JS de KX-Bridge) actualiza casi todo por
  // textContent -- eso son mutaciones childList/characterData en el nodo
  // de texto, no "style": con el observer vigilando solo estilo, el primer
  // ajuste de altura se quedaba corto (89px de sobra ya en reposo) y no se
  // volvia a comprobar hasta el siguiente cambio de estilo real, que podia
  // tardar o no llegar nunca.
  new MutationObserver(check).observe(card, {
    attributes: true,
    attributeFilter: ["style"],
    childList: true,
    characterData: true,
    subtree: true,
  });
  // "Progreso" trae una miniatura (#d-thumbnail) como data-URI: applyState()
  // le cambia src y display juntos en cada sondeo (mutacion de "style", ya
  // cubierta arriba), pero el ALTO real de la imagen no se conoce hasta que
  // decodifica -- eso dispara un "load" (no una mutacion de DOM) despues de
  // que check() ya habia medido con la imagen todavia sin alto, dejando la
  // tarjeta corta un instante hasta el siguiente cambio real de estilo.
  // "load" no burbujea, pero SI se puede capturar en fase de captura desde
  // cualquier ancestro -- así no hace falta enganchar el listener imagen a
  // imagen (el propio KX-Bridge tampoco las recrea, pero por si acaso).
  card.addEventListener("load", check, true);
}

/** Vista previa (3D / 2D / GCode) inyectada arriba del todo en el dialogo
 * NATIVO de KX-Bridge que asigna canal GCode -> ranura AMS antes de
 * imprimir (#filament-dialog, abierto por su propia startReadyFileWithSlots
 * / openFilamentDialog -- no se toca esa logica, solo se le anade contenido
 * encima). Debajo, una segunda fila de pestanas alterna entre la seccion
 * nativa de canal/color y la lista de "Saltar objetos" (ver
 * useNativeSkipObjects mas abajo): interactua con #fd-objects* solo a
 * traves de sus propias variables/funcion globales (window._printObjects /
 * window._toggleObjectSkip), nunca tocando el DOM de esa seccion
 * directamente -- es una interfaz alternativa sobre el mismo estado, no una
 * reimplementacion.
 *
 * fileId y highlightTool no son props: los escribe directamente
 * patchFilamentDialogPreview() (fuera de React, ver mas abajo) via las
 * variables de modulo fdPreviewSetFileId/fdPreviewSetHighlightTool, porque
 * quien dispara esos cambios es codigo nativo de KX-Bridge (apertura del
 * dialogo, hover sobre sus propias filas de canal), no este arbol de React. */
let fdPreviewSetFileId: ((id: string | null) => void) | null = null;
let fdPreviewSetHighlightTool: ((tool: number | null) => void) | null = null;

type FdMode = "3d" | "2d" | "gcode";
const FD_MODES: { key: FdMode; label: string }[] = [
  { key: "3d", label: "3D" },
  { key: "2d", label: "2D" },
  { key: "gcode", label: "GCode" },
];

/** "Saltar objetos" con la interfaz de KXDeck (previsualizacion 3D que se
 * ilumina, lista con boton Saltar/Restaurar por pieza) para ESTE dialogo de
 * KX-Bridge -- pero sin duplicar su logica de saltar objetos: lee y ESCRIBE
 * directamente en window._printObjects / window._toggleObjectSkip (las
 * mismas variables/funcion globales que ya usa su propio checklist nativo,
 * #fd-objects), asi que ambas vistas quedan siempre sincronizadas y lo que
 * de verdad se envia al imprimir (confirmFilamentPrint(), sin tocar) es
 * identico pase lo que pase por aqui. */
function useNativeSkipObjects(fileId: string | null) {
  const [objects, setObjects] = useState<{ name: string; skip: boolean }[]>([]);

  useEffect(() => {
    setObjects([]);
    if (!fileId) return;
    const section = document.getElementById("fd-objects-section");
    const list = document.getElementById("fd-objects");
    if (!section || !list) return;

    const sync = () => {
      // El card nativo (#fd-objects-section, "Omitir objetos") es
      // redundante ahora que la pestana de tijeras de arriba cubre lo
      // mismo con mejor interaccion -- se oculta aqui en vez de una sola
      // vez porque KX-Bridge vuelve a ponerlo en display:block cada vez
      // que abre el dialogo (openFilamentDialog), y esta misma funcion ya
      // se reejecuta con cada uno de esos cambios (moSection, mas abajo).
      if (section.style.display !== "none") section.style.display = "none";
      setObjects((window._printObjects || []).map((o) => ({ name: o.name, skip: !!o.skip })));
    };
    sync();
    const moSection = new MutationObserver(sync);
    moSection.observe(section, { attributes: true, attributeFilter: ["style"] });
    const moList = new MutationObserver(sync);
    moList.observe(list, { childList: true, subtree: true, attributes: true });
    return () => {
      moSection.disconnect();
      moList.disconnect();
    };
  }, [fileId]);

  const toggle = (idx: number, current: boolean) => {
    window._toggleObjectSkip?.(idx, !current);
    // _toggleObjectSkip solo redibuja su propia miniatura SVG, no el
    // checklist -- sin esto, su lista nativa (si alguien la despliega)
    // se veria desincronizada aunque lo que de verdad se envie al
    // imprimir (confirmFilamentPrint, que lee de _printObjects
    // directamente) ya sea correcto igualmente.
    window.renderObjectChecklist?.();
  };
  return { objects, toggle };
}

type SecondaryTab = "color" | "skip";

function FilamentDialogPreview() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [highlightTool, setHighlightTool] = useState<number | null>(null);
  const [hoveredObject, setHoveredObject] = useState<string | null>(null);
  const [mode, setMode] = useState<FdMode>("3d");
  const [secondaryTab, setSecondaryTab] = useState<SecondaryTab>("color");

  useEffect(() => {
    fdPreviewSetFileId = setFileId;
    fdPreviewSetHighlightTool = setHighlightTool;
    return () => {
      fdPreviewSetFileId = null;
      fdPreviewSetHighlightTool = null;
    };
  }, []);

  // Al cambiar de fichero se vuelve siempre a la pestana 3D / color -- evita
  // quedarse, p.ej., en GCode (que exige elegir capa) al abrir el dialogo
  // para una pieza distinta.
  useEffect(() => {
    setMode("3d");
    setSecondaryTab("color");
  }, [fileId]);

  // "Asignar canal GCode a la ranura AMS:" (#fd-slots-hint + #fd-slots) es
  // markup NATIVO de KX-Bridge, no algo que este arbol renderice -- para
  // que la pestana "paleta" / "tijeras" de aqui abajo puedan alternar entre
  // esa seccion y la lista de objetos, se oculta/muestra directamente por
  // estilo segun cual este activa. Nunca se toca su contenido, solo su
  // visibilidad.
  useEffect(() => {
    const hint = document.getElementById("fd-slots-hint");
    const slots = document.getElementById("fd-slots");
    if (!hint || !slots) return;
    const showColor = secondaryTab === "color";
    hint.style.display = showColor ? "" : "none";
    slots.style.display = showColor ? "" : "none";
  }, [secondaryTab]);

  const { objects, toggle } = useNativeSkipObjects(fileId);
  const excluded = new Set(objects.filter((o) => o.skip).map((o) => o.name));

  const render3d = usePrintRender3D(mode === "3d" ? fileId : null);
  const render2d = usePrintRender2D(mode === "2d" ? fileId : null);

  if (!fileId) return null;

  return (
    <div className="mb-3 space-y-2">
      <div className="flex overflow-hidden rounded-full bg-neutral-500/10 text-xs">
        {FD_MODES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`flex-1 py-1.5 font-medium ${mode === key ? "bg-[var(--accent-500)] text-white" : ""}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "3d" && (
        <PrintRenderScene
          data={render3d.data}
          loading={render3d.loading}
          highlightTool={highlightTool}
          highlightObject={hoveredObject}
          excludedObjects={Array.from(excluded)}
          aspectClassName="aspect-square"
        />
      )}
      {mode === "2d" && (
        <PrintRenderFlat
          data={render2d.data}
          loading={render2d.loading}
          highlightTool={highlightTool}
          highlightObject={hoveredObject}
          excludedObjects={Array.from(excluded)}
          aspectClassName="aspect-square"
        />
      )}
      {mode === "gcode" && (
        <GcodeViewerCore
          fileId={fileId}
          compact
          highlightTool={highlightTool}
          highlightObject={hoveredObject}
          excludedObjects={Array.from(excluded)}
        />
      )}
      {/* Segunda fila de pestanas, debajo de la preview: alterna entre la
       * seccion nativa de canal/color y la lista de saltar objetos (ver
       * useEffect de arriba). Con una sola pieza no hay nada que saltar, y
       * por tanto nada entre lo que alternar -- la fila entera (incluida
       * la de paleta) se omite, la seccion de color se queda simplemente
       * visible tal cual (secondaryTab nunca deja de ser "color"). */}
      {objects.length > 0 && (
        <div className="flex overflow-hidden rounded-full bg-neutral-500/10 text-xs">
          <button
            type="button"
            onClick={() => setSecondaryTab("color")}
            className={`flex-1 py-1.5 font-medium ${secondaryTab === "color" ? "bg-[var(--accent-500)] text-white" : ""}`}
          >
            🎨
          </button>
          <button
            type="button"
            onClick={() => setSecondaryTab("skip")}
            className={`flex-1 py-1.5 font-medium ${secondaryTab === "skip" ? "bg-[var(--accent-500)] text-white" : ""}`}
          >
            ✂
          </button>
        </div>
      )}
      {secondaryTab === "skip" && (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {objects.map((o, idx) => (
            <div
              key={o.name}
              onMouseEnter={() => setHoveredObject(o.name)}
              onMouseLeave={() => setHoveredObject(null)}
              className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800/10 p-2 text-sm dark:border-neutral-100/10"
            >
              <span className={`truncate ${o.skip ? "text-neutral-400 line-through" : ""}`}>{o.name}</span>
              {o.skip ? (
                <span className="shrink-0 text-xs text-neutral-400">Saltado</span>
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(idx, o.skip)}
                  className="shrink-0 rounded-lg bg-red-500/10 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400"
                >
                  Saltar
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** El dialogo nativo "Asignar canal a ranura AMS" (#filament-dialog) trae su
 * .modal-box fijado a max-width:380px -- pensado para una simple lista de
 * <select>, no para la vista previa 3D/2D/GCode que le añade KXDeck encima.
 * En desktop eso dejaba la preview diminuta en medio de una pantalla enorme
 * sin usar; en movil, ese mismo ancho tan ajustado es lo bastante estrecho
 * como para que algo dentro (el propio dialogo, no esta preview) se
 * desborde y la pagina entera gane scroll horizontal. Se ensancha SOLO este
 * dialogo (selector con id, no toca el resto de .modal-box nativos) y se le
 * pone overflow-x:hidden de resguardo -- por debajo de 900px se queda igual
 * que el original, en escritorio gana espacio real sin llegar a ir de borde
 * a borde (el propio .modal-overlay ya lo centra). */
function injectFilamentDialogStyle() {
  if (document.getElementById("kxd-fd-dialog-style")) return;
  const style = document.createElement("style");
  style.id = "kxd-fd-dialog-style";
  style.textContent =
    "#filament-dialog .modal-box{overflow-x:hidden}" +
    "@media(min-width:900px){#filament-dialog .modal-box{max-width:820px}}";
  document.head.appendChild(style);
}

function patchFilamentDialogPreview() {
  const hint = document.getElementById("fd-slots-hint");
  const dialog = document.getElementById("filament-dialog");
  if (!hint || !dialog || !hint.parentElement || document.getElementById("kxd-fd-preview-root")) return;
  injectFilamentDialogStyle();

  const container = document.createElement("div");
  container.id = "kxd-fd-preview-root";
  hint.parentElement.insertBefore(container, hint);
  createRoot(mountShadowRoot(container)).render(<FilamentDialogPreview />);

  // El dialogo es markup estatico que KX-Bridge solo muestra/oculta con la
  // clase "open" (nunca lo recrea) -- se vigila esa clase para saber que
  // fichero enseñar. window._storeFileId es la MISMA id que ya usa la API
  // de KXDeck (KxFiles envuelve el listado nativo de KX-Bridge sin tocar
  // los ids), asi que no hace falta traducir nada.
  new MutationObserver(() => {
    const isOpen = dialog.classList.contains("open");
    fdPreviewSetFileId?.(isOpen ? window._storeFileId ?? null : null);
    if (!isOpen) fdPreviewSetHighlightTool?.(null);
  }).observe(dialog, { attributes: true, attributeFilter: ["class"] });

  // Resaltado al pasar el raton por una fila de canal: reutiliza el propio
  // marcado nativo de #fd-slots (cada fila trae un <select data-paint="i">
  // ya puesto por KX-Bridge), sin duplicar esa lista aparte. Hay que
  // reenganchar los listeners en cada apertura porque KX-Bridge reconstruye
  // #fd-slots entero (innerHTML) cada vez que se abre el dialogo.
  const slotsBody = document.getElementById("fd-slots");
  if (slotsBody) {
    new MutationObserver(() => {
      slotsBody.querySelectorAll<HTMLElement>(":scope > div").forEach((row) => {
        if (row.dataset.kxdHoverBound) return;
        const select = row.querySelector<HTMLSelectElement>("select[data-paint]");
        if (!select) return;
        row.dataset.kxdHoverBound = "1";
        const tool = Number(select.dataset.paint);
        row.addEventListener("mouseenter", () => fdPreviewSetHighlightTool?.(tool));
        row.addEventListener("mouseleave", () => fdPreviewSetHighlightTool?.(null));
      });
    }).observe(slotsBody, { childList: true });
  }
}

/** Tarjeta "Color de acento" inyectada dentro de Ajustes -> Darstellung
 * (ver backend/kx_home.py, marcador #kxd-appearance-root): mismo contenido
 * que la seccion equivalente de la SPA vieja (pages/Settings.tsx), pero
 * aqui es la UNICA forma de cambiarlo ahora que el enlace a /kxdeck se ha
 * quitado del menu. useAccent() ya aplica el cambio de forma global (ver
 * lib/accent.ts), asi que tambien recolorea el propio KX-Bridge nativo
 * (su variable --accent) al instante, sin recargar. */
function AccentSettingsCard() {
  const { accent, setAccent } = useAccent();
  function pick(name: string) {
    setAccent(name);
    // useAccent() ya recolorea document.documentElement (native --accent
    // de KX-Bridge incluido), pero cada shadow root inyectado por KXDeck
    // (dashboard, dialogo de impresion...) necesita su propio empujon --
    // ver reapplyAccentEverywhere().
    reapplyAccentEverywhere();
  }
  return (
    <div className="rounded-xl border border-neutral-100/10 bg-neutral-900 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span>🎨</span> Color de acento
      </div>
      <div className="grid grid-cols-4 gap-2 pt-1">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => pick(p.name)}
            className="flex flex-col items-center gap-1.5 rounded-lg p-2"
            title={p.label}
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10"
              style={{ backgroundColor: p[500] }}
            >
              {accent === p.name && <Check size={16} className="text-white" />}
            </span>
            <span className="text-[11px] text-neutral-400">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Tarjeta "Notificaciones" inyectada dentro de Ajustes -> Integrationen
 * (ver backend/kx_home.py, marcador #kxd-integrations-root). Mismo
 * contenido/logica que pages/Settings.tsx -- lee y guarda en el mismo
 * localStorage ("kxdeck.notifications"), asi que sigue alimentando a
 * useNotificationEvents() (ver Widgets(), montado en el dashboard) tal
 * cual, cambie el usuario las preferencias desde donde las cambie. */
// TODO: notificaciones desactivadas -- el disparo por eventos de websocket
// (ver useNotificationEvents.ts) no es fiable todavia. Revisar y reactivar
// mas adelante; de momento la tarjeta se ensena en gris/no interactiva.
function NotificationSettingsCard() {
  return (
    <div className="rounded-xl border border-neutral-100/10 bg-neutral-900 p-3 pointer-events-none opacity-40 grayscale">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span>🔔</span> Notificaciones
      </div>
      <p className="mb-2 text-xs text-neutral-400">No disponible por ahora.</p>
      <div className="space-y-2 pt-1">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Activar notificaciones</span>
          <input type="checkbox" checked={false} disabled className="accent-[var(--accent-500)]" />
        </label>
      </div>
    </div>
  );
}

interface HaLight {
  id: string;
  label: string;
  webhook_id: string;
  incoming_secret: string;
  state: boolean | null;
}

interface HaSettings {
  base_url: string;
  lights: HaLight[];
}

/** Fila local del formulario -- una por luz, guardada o todavia no. Las ya
 * guardadas traen "id" (asignado por el backend, ver ha_settings.py) y
 * "secret" reales; una fila recien añadida con "+ Añadir luz" no tiene
 * ninguno de los dos todavia (se generan al guardar) -- "draftKey" es
 * solo la key de React mientras tanto, nunca se manda al backend. */
interface LightRow {
  id: string | null;
  draftKey: string;
  label: string;
  webhookId: string;
  secret: string | null;
  state: boolean | null;
}

function rowsFromSettings(lights: HaLight[]): LightRow[] {
  return lights.map((l) => ({
    id: l.id,
    draftKey: l.id,
    label: l.label,
    webhookId: l.webhook_id,
    secret: l.incoming_secret,
    state: l.state,
  }));
}

function newDraftKey(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random()}`;
}

/** Tarjeta "Home Assistant" inyectada dentro de Ajustes -> Integrationen
 * (mismo hueco que NotificationSettingsCard, ver patchSettingsCards() mas
 * abajo). Configura la integracion que enciende los interruptores de
 * HaLightToggles (ver mas arriba) -- por webhooks en los dos sentidos,
 * nunca con un token de HA guardado aqui (ver backend/ha_settings.py).
 * Admite VARIAS luces (misma URL de HA, un webhook/secreto propio cada
 * una) -- cada fila ensena, plegado, el YAML exacto a pegar en HA para
 * ESA luz, con los valores ya escritos interpolados (incluido
 * window.location.origin para la URL de KXDeck -- el navegador ya sabe
 * con que direccion habla, no hace falta que el usuario la escriba a
 * mano). */
function HaLightSettingsCard() {
  const [baseUrl, setBaseUrl] = useState("");
  const [rows, setRows] = useState<LightRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean } | null>(null);
  // Antes save()/loadSettings() no atrapaban el error: si la peticion
  // fallaba (un corte de red, lo que sea), no pasaba NADA visible -- el
  // boton volvia a "Guardar" sin avisar de que en realidad no se habia
  // guardado nada, y el formulario se quedaba con los valores tecleados
  // (que parecian "puestos" aunque nunca llegaran a persistir). Con este
  // aviso, un fallo real ahora SE VE.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  function loadSettings() {
    setLoadError(false);
    apiGet<HaSettings>("/api/kxdeck/ha/settings")
      .then((s) => {
        setBaseUrl(s.base_url);
        setRows(rowsFromSettings(s.lights));
      })
      .catch(() => setLoadError(true));
  }

  useEffect(loadSettings, []);

  async function persist(nextRows: LightRow[]) {
    setSaving(true);
    setError(null);
    try {
      const s = await apiPost<HaSettings>("/api/kxdeck/ha/settings", {
        base_url: baseUrl,
        lights: nextRows.map((r) => ({ id: r.id, label: r.label, webhook_id: r.webhookId })),
      });
      setBaseUrl(s.base_url);
      setRows(rowsFromSettings(s.lights));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido guardar");
    } finally {
      setSaving(false);
    }
  }

  function addLight() {
    setRows((prev) => [
      ...prev,
      { id: null, draftKey: newDraftKey(), label: "Luz nueva", webhookId: "", secret: null, state: null },
    ]);
  }

  function removeLight(row: LightRow) {
    const next = rows.filter((r) => r.draftKey !== row.draftKey);
    if (row.id) {
      persist(next); // ya estaba guardada -- se borra de verdad al instante
    } else {
      setRows(next); // solo local, nunca llego a guardarse
    }
  }

  function updateRow(draftKey: string, patch: Partial<LightRow>) {
    setRows((prev) => prev.map((r) => (r.draftKey === draftKey ? { ...r, ...patch } : r)));
  }

  async function regenerateSecret(id: string) {
    try {
      const s = await apiPost<HaSettings>(`/api/kxdeck/ha/settings/lights/${id}/regenerate-secret`);
      setBaseUrl(s.base_url);
      setRows(rowsFromSettings(s.lights));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido regenerar el secreto");
    }
  }

  async function testLight(id: string) {
    setTesting(id);
    setTestResult(null);
    try {
      await apiPost(`/api/kxdeck/ha/lights/${id}/toggle`);
      setTestResult({ id, ok: true });
    } catch {
      setTestResult({ id, ok: false });
    } finally {
      setTesting(null);
      window.setTimeout(() => setTestResult(null), 4000);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-neutral-100/10 bg-neutral-900 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <span>🏠</span> Home Assistant
        </div>
        <p className="mb-2 text-xs text-red-400">No se ha podido cargar la configuración.</p>
        <button
          onClick={loadSettings}
          className="rounded-lg border border-neutral-100/10 bg-neutral-800 px-3 py-1.5 text-xs font-medium"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const inputClass = "w-full rounded-lg border border-neutral-100/10 bg-neutral-800 px-2 py-1.5 text-sm text-white";
  const origin = window.location.origin;

  return (
    <div className="rounded-xl border border-neutral-100/10 bg-neutral-900 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span>🏠</span> Home Assistant
      </div>
      <p className="mb-2 text-xs text-neutral-400">
        Añade un interruptor por cada luz junto a la luz de la cámara. Todas comparten la misma URL de Home
        Assistant, cada una con su propio webhook.
      </p>

      <label className="mb-1 block text-xs">
        <span className="mb-1 block text-neutral-400">URL de Home Assistant</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://192.168.x.x:8123"
          className={inputClass}
        />
      </label>
      <p className="mb-3 text-[11px] text-neutral-500">
        Mejor la IP local (p. ej. http://192.168.x.x:8123) que un dominio público -- si pasa por Cloudflare Access
        (u otro login delante), Home Assistant puede rechazar la llamada aunque responda como si hubiera ido bien.
      </p>

      <div className="space-y-3">
        {rows.map((row) => {
          // Sin "local_only:true": aunque parezca lo prudente por defecto,
          // HA lo evalua contra el origen real de la peticion -- si KXDeck
          // le llega a HA a traves de un dominio publico/proxy (no
          // directamente en la misma LAN que ve HA), lo bloquea en
          // silencio: HA responde 200 igualmente (no delata si el
          // webhook_id existe), pero la accion nunca se ejecuta. Confirmado
          // con un caso real: sin este cambio, el interruptor no hacia
          // nada aunque la llamada "funcionase" a ojos de KXDeck.
          const automationAction = `alias: KXDeck - alternar ${row.label || "luz"}
triggers:
  - trigger: webhook
    webhook_id: "${row.webhookId || "TU_WEBHOOK_ID"}"
    allowed_methods: [POST]
actions:
  - action: light.toggle
    target:
      entity_id: light.TU_LUZ_AQUI   # cambia esto por tu luz real`;

          const restCommandName = `kxdeck_${(row.label || "luz").toLowerCase().replace(/[^a-z0-9]+/g, "_")}_estado`;
          // "| lower": {{ state == "on" }} solo, sin el filtro, renderiza
          // el booleano de Jinja2 en mayuscula ("True"/"False", al estilo
          // Python) -- JSON valido exige minuscula, asi que sin esto el
          // payload llega MAL FORMADO y KXDeck lo rechaza con 400 (nunca
          // se ve la luz reflejada, aunque la automatizacion "se ejecute"
          // sin ningun error visible en HA salvo revisando su log).
          const restCommand = row.secret
            ? `rest_command:
  ${restCommandName}:
    # Si tu KXDeck solo es accesible desde fuera a traves de un dominio con
    # login por delante (Cloudflare Access u otro proxy de autenticacion),
    # esta llamada NUNCA llegara -- usa aqui la IP local de KXDeck en su
    # lugar (algo como http://192.168.x.x:5000/api/kxdeck/ha/light-state),
    # no la URL con la que abres KXDeck en el navegador.
    url: "${origin}/api/kxdeck/ha/light-state"
    method: POST
    headers:
      Content-Type: application/json
    payload: '{"secret": "${row.secret}", "on": {{ (state == "on") | lower }} }'`
            : null;

          // El "data:" es imprescindible: "trigger" es una variable propia
          // de ESTA automatizacion, y un rest_command (definido aparte, en
          // configuration.yaml) NO hereda ese contexto al ser llamado como
          // accion -- sin pasarlo explicito, su propia plantilla ve
          // "trigger" como indefinido y falla (UndefinedError, visible en
          // el log de HA, no en KXDeck).
          const automationState = `alias: KXDeck - reportar estado de ${row.label || "la luz"}
triggers:
  - trigger: state
    entity_id: light.TU_LUZ_AQUI   # la misma luz de arriba
actions:
  - action: rest_command.${restCommandName}
    data:
      state: "{{ trigger.to_state.state }}"`;

          return (
            <div key={row.draftKey} className="rounded-lg border border-neutral-100/10 p-2.5">
              <div className="mb-2 flex items-center gap-1.5">
                <input
                  value={row.label}
                  onChange={(e) => updateRow(row.draftKey, { label: e.target.value })}
                  placeholder="Etiqueta (p. ej. Luz salón)"
                  className={inputClass}
                />
                <button
                  onClick={() => removeLight(row)}
                  title="Eliminar esta luz"
                  className="shrink-0 rounded-lg border border-neutral-100/10 bg-neutral-800 p-1.5 text-red-400"
                >
                  ✕
                </button>
              </div>
              <label className="mb-2 block text-xs">
                <span className="mb-1 block text-neutral-400">ID del webhook (el que dispara la automatización)</span>
                <input
                  value={row.webhookId}
                  onChange={(e) => updateRow(row.draftKey, { webhookId: e.target.value })}
                  placeholder="kxdeck_luz_salon"
                  className={inputClass}
                />
              </label>

              {row.id && (
                <div className="mb-2 flex items-center gap-1.5">
                  <button
                    onClick={() => testLight(row.id!)}
                    disabled={testing === row.id}
                    title="Llama al webhook de salida ahora mismo -- enciende/apaga la luz de verdad si la automatización ya está lista"
                    className="rounded-lg border border-neutral-100/10 bg-neutral-800 px-2 py-1 text-xs font-medium disabled:opacity-60"
                  >
                    {testing === row.id ? "Probando..." : "Probar"}
                  </button>
                  {testResult?.id === row.id && (
                    <span className={`text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                      {testResult.ok ? "✓ KXDeck ha llegado a HA" : "✗ No se ha podido llamar al webhook"}
                    </span>
                  )}
                  <span className="text-xs text-neutral-500">
                    Estado: {row.state === true ? "encendida" : row.state === false ? "apagada" : "desconocido"}
                  </span>
                </div>
              )}

              {row.secret ? (
                <>
                  <div className="mb-2 text-xs">
                    <span className="mb-1 block text-neutral-400">Secreto del webhook de entrada</span>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 truncate rounded-lg border border-neutral-100/10 bg-neutral-800 px-2 py-1.5 text-[11px] text-neutral-300">
                        {row.secret}
                      </code>
                      <button
                        onClick={() => copy(row.secret!, `secret-${row.id}`)}
                        title="Copiar"
                        className="shrink-0 rounded-lg border border-neutral-100/10 bg-neutral-800 p-1.5"
                      >
                        {copied === `secret-${row.id}` ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        onClick={() => regenerateSecret(row.id!)}
                        title="Regenerar (invalida el anterior)"
                        className="shrink-0 rounded-lg border border-neutral-100/10 bg-neutral-800 p-1.5"
                      >
                        <RefreshCw size={14} />
                      </button>
                    </div>
                  </div>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-neutral-400">Automatizaciones a añadir en HA</summary>
                    <div className="mt-2 space-y-2">
                      {[
                        { key: `action-${row.id}`, title: "1. Automatización — dispara la acción real", code: automationAction },
                        { key: `rest-${row.id}`, title: "2. rest_command (en configuration.yaml)", code: restCommand! },
                        { key: `state-${row.id}`, title: "3. Automatización — reporta el estado a KXDeck", code: automationState },
                      ].map(({ key, title, code }) => (
                        <div key={key}>
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-[11px] font-medium text-neutral-400">{title}</span>
                            <button
                              onClick={() => copy(code, key)}
                              className="rounded-md border border-neutral-100/10 bg-neutral-800 px-1.5 py-0.5 text-[10px]"
                            >
                              {copied === key ? "Copiado" : "Copiar"}
                            </button>
                          </div>
                          <pre className="overflow-x-auto rounded-lg bg-black/40 p-2 text-[11px] text-neutral-300">{code}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <p className="text-[11px] text-neutral-500">Guarda para generar el secreto y ver las automatizaciones.</p>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={addLight}
        className="mt-2 w-full rounded-lg border border-dashed border-neutral-100/20 py-1.5 text-xs font-medium text-neutral-400"
      >
        + Añadir luz
      </button>

      {error && <p className="mt-2 text-xs text-red-400">⚠ {error}</p>}
      <button
        onClick={() => persist(rows)}
        disabled={saving}
        className="mt-2 w-full rounded-lg bg-[var(--accent-500)] py-1.5 text-sm font-medium text-white disabled:opacity-60"
      >
        {saved ? "Guardado ✓" : saving ? "Guardando..." : "Guardar"}
      </button>
    </div>
  );
}

function injectHeaderMenuStyle() {
  if (document.getElementById("kxd-header-menu-style")) return;
  const style = document.createElement("style");
  style.id = "kxd-header-menu-style";
  style.textContent =
    "#kxd-header-menu-btn{display:none}" +
    "@media(max-width:640px){" +
    "header{position:relative}" +
    "#kxd-header-menu-btn{display:inline-flex!important}" +
    "#kxd-header-menu{display:none;position:absolute;top:100%;right:12px;margin-top:6px;" +
    "background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px;" +
    "flex-direction:column;align-items:stretch;gap:6px;z-index:200;box-shadow:0 4px 16px #0006;" +
    "min-width:180px}" +
    "#kxd-header-menu.kxd-open{display:flex}" +
    "}";
  document.head.appendChild(style);
}

/** En movil el header nativo (nombre/version de impresora, tema, ajustes,
 * conectar/desconectar) no cabe en una sola fila junto al logo y al badge
 * de estado -- se agrupan todos esos controles (todo menos el logo y el
 * badge "LISTO") detras de un boton de menu hamburguesa que solo se ve por
 * debajo de 640px (ver injectHeaderMenuStyle). En desktop no cambia nada
 * visualmente: siguen en la misma fila que en el panel nativo, el
 * hamburguesa esta oculto. Los elementos se MUEVEN (no se clonan), asi que
 * el JS nativo que ya los controla por ID/clase (togglePrinterDropdown,
 * toggleTheme, showPanel, toggleConnection) sigue funcionando igual. */
function patchHeaderMobileMenu() {
  const header = document.querySelector<HTMLElement>("header");
  const badge = document.getElementById("h-badge");
  if (!header || !badge || document.getElementById("kxd-header-menu-btn")) return;
  injectHeaderMenuStyle();

  const ids = ["printer-dropdown-wrap", "h-pname-single", "h-version"];
  const selectors = [".theme-btn", "#settings-btn", "#conn-btn"];
  const items = [
    ...ids.map((id) => document.getElementById(id)),
    ...selectors.map((sel) => header.querySelector<HTMLElement>(sel)),
  ].filter((el): el is HTMLElement => !!el);
  if (!items.length) return;

  const wrapper = document.createElement("div");
  wrapper.id = "kxd-header-menu";
  header.insertBefore(wrapper, badge);
  items.forEach((el) => wrapper.appendChild(el));

  const menuBtn = document.createElement("button");
  menuBtn.id = "kxd-header-menu-btn";
  menuBtn.className = "theme-btn";
  menuBtn.title = "Más opciones";
  menuBtn.textContent = "☰";
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    wrapper.classList.toggle("kxd-open");
  };
  header.appendChild(menuBtn);

  document.addEventListener("click", (e) => {
    if (wrapper.classList.contains("kxd-open") && !wrapper.contains(e.target as Node)) {
      wrapper.classList.remove("kxd-open");
    }
  });
}

// Que inyecciones son opcionales (Ajustes -> KXDeck, ver KxDeckFeaturesCard)
// y bajo que llave de localStorage. Activadas por defecto -- solo se
// desactivan si el usuario lo pide expresamente. Se leen UNA vez al
// arrancar (antes de llamar a cada patchXxx en mount()), asi que un cambio
// aqui no se aplica hasta recargar la pagina (avisado en la propia
// tarjeta) -- son patches que enganchan listeners/observers al cargar, no
// tiene sentido desmontarlos en caliente.
const FEATURE_DEFS = [
  { key: "cameraGcode", label: "Cámara + visor GCode combinados" },
  { key: "filamentIcons", label: "Bobinas animadas en la tarjeta de filamento" },
  { key: "cameraFilamentStrip", label: "Bobinas de filamento junto a la cámara" },
  { key: "sidebarCollapse", label: "Botón de colapsar menú lateral" },
  { key: "headerMobileMenu", label: "Menú hamburguesa en móvil" },
  { key: "filamentDialogPreview", label: "Vista previa 3D al preparar una impresión" },
  { key: "haLight", label: "Interruptor de luz de Home Assistant junto a la cámara" },
  { key: "pauseSchedule", label: "Menú de pausas programadas (⋮ junto a Pausa)" },
  { key: "progressEta", label: "Hora de fin y pausas pendientes en Progreso" },
] as const;
type FeatureKey = (typeof FEATURE_DEFS)[number]["key"];

function isFeatureEnabled(key: FeatureKey): boolean {
  return localStorage.getItem(`kxdeck.feature.${key}`) !== "0";
}

function setFeatureEnabled(key: FeatureKey, enabled: boolean) {
  localStorage.setItem(`kxdeck.feature.${key}`, enabled ? "1" : "0");
}

interface GeneralSettings {
  prewarm_enabled: boolean;
}

/** Tarjeta de la categoria "KXDeck" en Ajustes (ver backend/kx_home.py,
 * marcador #kxd-features-root): que inyecta KXDeck en el panel nativo
 * (toggles solo de navegador, requieren recargar) y si el renderizado
 * 3D/2D en segundo plano debe correr (ajuste real de servidor via
 * general_settings.py, se aplica sin recargar -- lo lee el propio bucle en
 * cada vuelta). */
function KxDeckFeaturesCard() {
  const [flags, setFlags] = useState<Record<FeatureKey, boolean>>(() =>
    Object.fromEntries(FEATURE_DEFS.map((f) => [f.key, isFeatureEnabled(f.key)])) as Record<FeatureKey, boolean>,
  );
  const [prewarm, setPrewarm] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    apiGet<GeneralSettings>("/api/kxdeck/settings/general")
      .then((s) => setPrewarm(s.prewarm_enabled))
      .catch(() => setError("No se han podido cargar los ajustes de KXDeck."));
  }, []);

  function toggleFeature(key: FeatureKey, checked: boolean) {
    setFeatureEnabled(key, checked);
    setFlags((f) => ({ ...f, [key]: checked }));
    setChanged(true);
  }

  async function togglePrewarm(checked: boolean) {
    const prev = prewarm;
    setPrewarm(checked);
    setSaving(true);
    setError(null);
    try {
      await apiPost<GeneralSettings>("/api/kxdeck/settings/general", { prewarm_enabled: checked });
    } catch {
      setError("No se ha podido guardar -- se ha dejado como estaba.");
      setPrewarm(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-100/10 bg-neutral-900 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span>🧩</span> Qué inyecta KXDeck
      </div>
      <p className="mb-2 text-xs text-neutral-400">Cambios aquí abajo requieren recargar la página.</p>
      <div className="space-y-1.5 rounded-lg border border-neutral-100/10 p-2.5">
        {FEATURE_DEFS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 text-sm">
            <span>{f.label}</span>
            <input
              type="checkbox"
              checked={flags[f.key]}
              onChange={(e) => toggleFeature(f.key, e.target.checked)}
              className="accent-[var(--accent-500)]"
            />
          </label>
        ))}
      </div>
      {changed && <p className="mt-2 text-xs text-amber-400">Recarga la página para aplicar los cambios.</p>}

      <div className="mt-3 border-t border-neutral-100/10 pt-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Renderizado 3D/2D en segundo plano</span>
          <input
            type="checkbox"
            checked={prewarm ?? false}
            disabled={prewarm === null || saving}
            onChange={(e) => togglePrewarm(e.target.checked)}
            className="accent-[var(--accent-500)]"
          />
        </label>
        <p className="mt-1 text-xs text-neutral-400">
          Precalienta el render de toda la biblioteca cada pocos minutos para que abrir una pieza sea instantáneo.
          Se aplica sin recargar.
        </p>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

let popoverPortalRoot: HTMLElement | null = null;

/** Contenedor de nivel superior para popovers que necesitan escapar del
 * scroll/recorte propio de las tarjetas del dashboard nativo
 * (".grid-stack-item-content>.card" trae "overflow-y:auto;overflow-x:hidden"
 * en el CSS de KX-Bridge -- cualquier position:absolute dentro de una
 * tarjeta se recorta ahi, o le mete scroll propio a la tarjeta entera, en
 * vez de flotar por encima de todo como un popover normal).
 *
 * Se crea una unica vez, como hijo directo de <body> con su PROPIO shadow
 * root (mountShadowRoot, mismo mecanismo que cualquier otro montaje de
 * KXDeck -- el CSS de Tailwind no llega aqui si no se repite alli dentro),
 * y se reutiliza via createPortal para cualquier popover que lo necesite. */
function getPopoverPortalRoot(): HTMLElement {
  if (!popoverPortalRoot) {
    const host = document.createElement("div");
    host.id = "kxd-popover-portal";
    document.body.appendChild(host);
    popoverPortalRoot = mountShadowRoot(host);
  }
  return popoverPortalRoot;
}

/** Menu "⋮" junto al boton nativo de Pausa (#kxd-pause-menu-root, marcador
 * insertado en kx_home.py justo despues de #d-btn-pause): solo PROGRAMAR
 * una pausa nueva por capa o por tiempo transcurrido para la impresion en
 * curso. El backend YA las vigila (ver PauseSchedule en kx_client.py,
 * consultada en cada vuelta de tracker_loop) desde antes de que existiera
 * esta interfaz -- esto solo le añade una forma de programarlas.
 *
 * Ver/quitar las ya programadas (o las del propio gcode) vive en la
 * tarjeta Progreso (ScheduledPausesList, mas abajo) -- tenerlo tambien
 * aqui era redundante, y con la impresion avanzando esta lista se quedaba
 * obsoleta en cuanto se cerraba el popover.
 *
 * Sin prop de fileId propia: el backend ya liga la programacion al
 * fichero que este imprimiendo AHORA MISMO (ver h_kxdeck_pause_schedule_add,
 * lee kx.filename el mismo), asi que aqui basta con no mostrar nada
 * mientras no hay impresion -- igual que el propio boton de Pausa
 * (#d-ctrl-btns) esta oculto en ese caso.
 *
 * El desplegable se renderiza vía createPortal en getPopoverPortalRoot()
 * (fijo por coordenadas, no "absolute" colgado del boton) para escapar del
 * "overflow-y:auto" de la tarjeta -- ver esa funcion. Eso mismo obliga a
 * detectar el click "fuera" con event.composedPath() en vez de
 * event.target/Node.contains(): el boton vive en el shadow root de
 * #kxd-pause-menu-root y el popover en el de #kxd-popover-portal, DOS
 * arboles de shadow DOM distintos -- un listener en document ve cualquier
 * click dentro de cualquiera de los dos con el target retargeted al HOST
 * de ese shadow root (nunca al elemento real que se pulso), asi que
 * comparar contra el target siempre daba "fuera" y el popover se cerraba
 * en cuanto se intentaba tocar cualquier cosa dentro (el select, el
 * input...). composedPath() sí trae la ruta real, shadow-inclusive. */
function PauseScheduleMenu() {
  const { data } = useKxState();
  const printing = Boolean(data?.state.flags.printing);
  const currLayer = data?.kx.curr_layer;
  const totalLayers = data?.kx.total_layers;
  // Nunca se puede programar una capa ya pasada (currLayer) ni una que la
  // impresion no vaya a tener (totalLayers, si se conoce -- 0/undefined
  // significa "no se sabe todavia", no "esta impresion no tiene capas": en
  // ese caso no se limita el maximo en vez de bloquear todo por error).
  const minLayer = (currLayer ?? 0) + 1;
  const maxLayer = totalLayers && totalLayers > 0 ? totalLayers : undefined;

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [kind, setKind] = useState<"layer" | "time">("layer");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Recalcula la posicion a partir del boton real cada vez -- nunca se fija
  // "una vez" porque la tarjeta (o la ventana) puede haber scrolleado/
  // cambiado de tamaño desde la ultima vez que se abrio. Clampado al ancho
  // de la ventana para que en pantallas estrechas el popover (w-64, 256px)
  // no se salga por la derecha.
  function reposition() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 256;
    setCoords({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }

  useEffect(() => {
    if (!open) return;
    reposition();
  }, [open]);

  // Mientras esta abierto: si la tarjeta (o cualquier ancestro) scrollea o
  // la ventana cambia de tamaño, el popover (position:fixed, ya fuera de la
  // tarjeta) se quedaria pegado a coordenadas viejas si no se recalcula.
  // "scroll" con capture:true en window es lo unico que ve el scroll de
  // CUALQUIER contenedor descendiente (ese evento no burbujea solo).
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const path = e.composedPath();
      if (btnRef.current && path.includes(btnRef.current)) return;
      if (popoverRef.current && path.includes(popoverRef.current)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!printing) return null;

  async function add() {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Valor no válido.");
      return;
    }
    if (kind === "layer") {
      if (n < minLayer) {
        setError(currLayer != null ? `Esa capa ya se imprimió (vas por la ${currLayer}).` : "Esa capa ya se imprimió.");
        return;
      }
      if (maxLayer != null && n > maxLayer) {
        setError(`Esta impresión solo tiene ${maxLayer} capas.`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      // El backend guarda "time" como segundos transcurridos desde el
      // INICIO de la impresion (compara contra print_duration, ver
      // PauseSchedule.check) -- pero el formulario pide minutos DESDE AHORA
      // (mas util e intuitivo que un minuto absoluto de la impresion, y es
      // lo que de verdad pide el propio boton), asi que aqui se suma el
      // print_duration actual antes de mandarlo: n minutos desde ahora ==
      // (elapsed actual + n*60) segundos desde el inicio. Sin esto, pedir
      // "en 10 minutos" con la impresion ya a los 45 minutos programaba un
      // disparo en el segundo 600 -- que ya habia pasado hace rato -- y
      // pausaba de inmediato en vez de esperar los 10 minutos pedidos.
      const value_ = kind === "time" ? Math.round((data?.kx.print_duration ?? 0) + n * 60) : Math.round(n);
      await apiPost("/api/kxdeck/pause-schedule", { kind, value: value_ });
      setValue("");
      // Confirmacion breve en vez de dejar el formulario tal cual -- sin
      // lista aqui dentro (ver ScheduledPausesList, en la tarjeta Progreso)
      // no habia forma de saber si de verdad se habia guardado.
      setSuccess(true);
    } catch {
      setError("No se ha podido programar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Pausas programadas"
        className="rounded-lg border border-neutral-500/25 bg-neutral-500/10 px-2 py-1.5 text-sm font-bold leading-none text-neutral-600 dark:text-neutral-300"
      >
        ⋮
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: "fixed", top: coords.top, left: coords.left }}
            className="z-50 w-64 space-y-2 rounded-xl border border-neutral-100/10 bg-neutral-900 p-3 text-sm text-neutral-100 shadow-xl"
          >
            <div className="font-semibold">⏸ Programar pausa</div>
            <div className="space-y-1.5">
              {/* En su propia fila (no encaja junto al resto sin apretujarse
               * en las 256px del popover) -- el texto de cada opcion ya deja
               * claro por si solo que "minutos" es DESDE AHORA, no un
               * minuto absoluto de la impresion (ver add(), que sí lo
               * convierte a esa cuenta absoluta para el backend). */}
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as "layer" | "time");
                  setError(null);
                  setSuccess(false);
                }}
                className="w-full rounded-lg border border-neutral-100/10 bg-neutral-800 px-1.5 py-1 text-xs"
              >
                <option value="layer">Pausar en la capa</option>
                <option value="time">Pausar dentro de X minutos</option>
              </select>
              <div className="flex gap-1.5">
                <input
                  type="number"
                  min={kind === "layer" ? minLayer : 1}
                  max={kind === "layer" ? maxLayer : undefined}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setSuccess(false);
                  }}
                  placeholder={
                    kind === "layer" ? `${minLayer}${maxLayer != null ? `–${maxLayer}` : "+"}` : "minutos"
                  }
                  className="w-16 min-w-0 rounded-lg border border-neutral-100/10 bg-neutral-800 px-1.5 text-xs"
                />
                <button
                  onClick={add}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-[var(--accent-500)] text-xs font-medium text-white disabled:opacity-60"
                >
                  + Añadir
                </button>
              </div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            {success && !error && (
              <p className="text-xs text-emerald-400">✓ Programada -- ver "Próximas pausas" en Progreso.</p>
            )}
          </div>,
          getPopoverPortalRoot(),
        )}
    </>
  );
}

function patchPauseScheduleMenu() {
  const root = document.getElementById("kxd-pause-menu-root");
  if (!root) return;
  createRoot(mountShadowRoot(root)).render(<PauseScheduleMenu />);
}

function formatDurationShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Bloque extra en la tarjeta Progreso (#kxd-eta-root, insertado en
 * kx_home.py justo debajo de ".time-grid" y encima del nombre del
 * fichero): KX-Bridge ya muestra el tiempo restante como DURACION
 * (#d-remain, "2h 14m"), pero no a que hora del reloj se traduce eso --
 * util para saber si hace falta esperar despierto o si se puede ir a
 * dormir. Reutiliza la clase nativa ".time-block" (sin shadow DOM, mismo
 * motivo que HaLightToggles: verse identico a los bloques nativos de
 * al lado, cosa que un limite de shadow root impediria). */
function EstimatedFinish() {
  const { data } = useKxState();
  const printing = Boolean(data?.state.flags.printing || data?.state.flags.paused);
  const remain = data?.kx.remain_time;
  if (!printing || !remain || remain <= 0) return null;

  return (
    <div className="time-block" style={{ marginTop: "8px" }}>
      <div className="time-label">Fin estimado</div>
      <div className="time-val">{formatClock(new Date(Date.now() + remain * 1000))}</div>
    </div>
  );
}

/** Lista de pausas pendientes en la tarjeta Progreso (#kxd-pause-list-root,
 * justo debajo de EstimatedFinish): une DOS fuentes distintas en una sola
 * vista --
 * - Programadas por el usuario (menu "⋮" junto al boton de Pausa, ver
 *   PauseScheduleMenu) via /api/kxdeck/pause-schedule, sondeado aparte --
 *   esa API no viaja por el websocket, y este es un montaje INDEPENDIENTE
 *   del menu (no comparten estado), asi que hay que refrescarla aqui
 *   tambien para que anadir/quitar una desde el menu se refleje aqui.
 * - Embebidas en el propio gcode por el slicer (M600/M601, ver
 *   layer_pause_points en kx_client.py) via data.gcode_pause_layers, ya en
 *   vivo por el websocket sin peticion aparte.
 *
 * Para cada una se estima cuanto falta (tiempo Y capas, aunque el usuario
 * solo haya fijado una de las dos) a partir del RITMO MEDIO de toda la
 * impresion hasta ahora (capas/tiempo restantes totales, que KX-Bridge ya
 * calcula) -- no hay un cronometro por capa aqui accesible desde el
 * navegador (eso vive en LayerTracker, solo en el backend, para otra
 * cosa); es una aproximacion igual de razonable que la que ya ensena
 * KX-Bridge para su propio tiempo restante total. */
function ScheduledPausesList() {
  const { data } = useKxState();
  const printing = Boolean(data?.state.flags.printing || data?.state.flags.paused);
  const [entries, setEntries] = useState<PauseScheduleEntry[]>([]);

  function refresh() {
    apiGet<{ entries: PauseScheduleEntry[] }>("/api/kxdeck/pause-schedule")
      .then((d) => setEntries(d.entries))
      .catch(() => {});
  }

  useEffect(() => {
    if (!printing) {
      setEntries([]);
      return;
    }
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
    // data?.job.file.name en las deps: al cambiar de fichero (impresion
    // nueva) refresca de inmediato -- el backend ya vacia la lista sola en
    // cuanto detecta el cambio (ver PauseSchedule._ensure_file), pero sin
    // esto aqui se veria con hasta 4s de retraso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printing, data?.job.file.name]);

  async function removeSchedule(id: number) {
    try {
      await apiDelete(`/api/kxdeck/pause-schedule/${id}`);
      refresh();
    } catch {
      // Silencioso -- si de verdad fallo, la entrada sigue en la lista
      // tal cual estaba.
    }
  }

  async function skipGcodePause(layer0: number) {
    // No hace falta quitarla de la lista a mano aqui: data.gcode_pause_layers
    // llega por el propio websocket (~1.5s) y el backend ya la filtra fuera
    // en cuanto se marca (ver job_payload/GcodePauseSkips), asi que
    // desaparece sola en el siguiente tick -- igual que el resto de datos
    // en vivo de esta tarjeta.
    try {
      await apiPost("/api/kxdeck/pause-schedule/gcode-skip", { layer: layer0 });
    } catch {
      // Silencioso, mismo motivo que removeSchedule.
    }
  }

  if (!printing || !data) return null;

  const currLayer = data.kx.curr_layer;
  const totalLayers = data.kx.total_layers;
  const remainTime = data.kx.remain_time;
  const printDuration = data.kx.print_duration;
  const layersRemaining = totalLayers && currLayer != null ? totalLayers - currLayer : null;

  // targetLayer/targetElapsed: solo se rellena UNO de los dos segun el
  // origen del dato (capa exacta para programadas por capa y para las de
  // gcode; segundo absoluto de impresion para programadas por tiempo, ver
  // PauseScheduleMenu::add) -- esta funcion deriva el OTRO por regla de
  // tres contra el ritmo medio actual.
  function estimate(targetLayer: number | null, targetElapsed: number | null) {
    if (targetLayer != null && currLayer != null) {
      const layersLeft = targetLayer - currLayer;
      const etaSeconds =
        layersRemaining && layersRemaining > 0 && remainTime ? (remainTime * layersLeft) / layersRemaining : null;
      return { layersLeft, etaSeconds };
    }
    if (targetElapsed != null && printDuration != null) {
      const etaSeconds = targetElapsed - printDuration;
      const layersLeft =
        layersRemaining && layersRemaining > 0 && remainTime && remainTime > 0
          ? Math.round((layersRemaining * etaSeconds) / remainTime)
          : null;
      return { layersLeft, etaSeconds };
    }
    return { layersLeft: null as number | null, etaSeconds: null as number | null };
  }

  const upcoming: {
    key: string;
    label: string;
    layersLeft: number | null;
    etaSeconds: number | null;
    onRemove: () => void;
  }[] = [];

  for (const e of entries) {
    if (e.triggered) continue;
    const { layersLeft, etaSeconds } = e.kind === "layer" ? estimate(e.value, null) : estimate(null, e.value);
    if (etaSeconds != null && etaSeconds <= 0) continue; // a punto de saltar / ya deberia haber saltado
    upcoming.push({
      key: `s${e.id}`,
      label: e.kind === "layer" ? `Capa ${e.value}` : `Minuto ${Math.round(e.value / 60)}`,
      layersLeft,
      etaSeconds,
      onRemove: () => removeSchedule(e.id),
    });
  }

  for (const layer0 of data.gcode_pause_layers) {
    // layer_pause_points() (backend) es 0-based sobre el mismo indice que
    // offsets/layer_offsets; curr_layer/total_layers son 1-based (mismo
    // convenio que job_payload:: idx = curr_layer - 1) -- de ahi el +1.
    const targetLayer = layer0 + 1;
    if (currLayer != null && targetLayer <= currLayer) continue;
    const { layersLeft, etaSeconds } = estimate(targetLayer, null);
    upcoming.push({
      key: `g${layer0}`,
      label: `Capa ${targetLayer}`,
      layersLeft,
      etaSeconds,
      onRemove: () => skipGcodePause(layer0),
    });
  }

  if (upcoming.length === 0) return null;
  upcoming.sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity));

  return (
    <div style={{ marginTop: "8px" }}>
      <div className="time-label">⏸ Próximas pausas</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}>
        {upcoming.map((p) => (
          <div
            key={p.key}
            style={{
              background: "var(--raised)",
              borderRadius: "10px",
              padding: "8px 10px",
              fontSize: "12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span>{p.label}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ color: "var(--txt2)", textAlign: "right" }}>
                {p.layersLeft != null && `${p.layersLeft} capas · `}
                {p.etaSeconds != null
                  ? `en ${formatDurationShort(p.etaSeconds)} (~${formatClock(new Date(Date.now() + p.etaSeconds * 1000))})`
                  : "—"}
              </span>
              <button
                onClick={p.onRemove}
                title="Quitar pausa"
                style={{
                  color: "#ef4444",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "14px",
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function patchProgressEta() {
  const etaRoot = document.getElementById("kxd-eta-root");
  if (etaRoot) createRoot(etaRoot).render(<EstimatedFinish />);
  const pauseListRoot = document.getElementById("kxd-pause-list-root");
  if (pauseListRoot) createRoot(pauseListRoot).render(<ScheduledPausesList />);
}

function patchSettingsCards() {
  const appearance = document.getElementById("kxd-appearance-root");
  if (appearance) createRoot(mountShadowRoot(appearance)).render(<AccentSettingsCard />);
  const integrations = document.getElementById("kxd-integrations-root");
  if (integrations) {
    createRoot(mountShadowRoot(integrations)).render(
      <div className="space-y-3">
        <NotificationSettingsCard />
        <HaLightSettingsCard />
      </div>,
    );
  }
  const features = document.getElementById("kxd-features-root");
  if (features) createRoot(mountShadowRoot(features)).render(<KxDeckFeaturesCard />);
}

async function mount() {
  // Antes de montar nada: fija el acento guardado sobre document.documentElement
  // (recolorea el propio CSS nativo de KX-Bridge via --accent). Cada shadow
  // root que se monte despues (mountShadowRoot) fija su PROPIA copia local
  // ademas -- ver applyAccentToWrapper() y por que hace falta.
  applyAccent(localStorage.getItem("kxdeck.accent") ?? DEFAULT_ACCENT);

  injectSpoolKeyframes();
  patchFooterIntoMain();
  patchSidebarWheelForwarding();
  patchNativeCamera();
  if (isFeatureEnabled("haLight")) patchNativeCameraLight();
  if (isFeatureEnabled("sidebarCollapse")) patchSidebarCollapse();
  if (isFeatureEnabled("headerMobileMenu")) patchHeaderMobileMenu();
  if (isFeatureEnabled("filamentIcons")) patchNativeFilamentIcons();
  if (isFeatureEnabled("cameraFilamentStrip")) patchCameraFilamentStrip();
  if (isFeatureEnabled("pauseSchedule")) patchPauseScheduleMenu();
  if (isFeatureEnabled("progressEta")) patchProgressEta();
  patchGrowingCard("card-progress");
  patchGrowingCard("card-temps");
  if (isFeatureEnabled("filamentDialogPreview")) patchFilamentDialogPreview();
  // patchSettingsCards() (con la propia tarjeta de toggles, KxDeckFeaturesCard)
  // nunca es opcional -- si lo fuera y alguien lo desactivase, no tendria
  // forma de volver a activarlo salvo borrando localStorage a mano.
  patchSettingsCards();
  // La tarjeta de camara tiene su propia logica de tamaño (dentro de
  // patchCameraGcodeToggle -> sizeCameraRow): patchGrowingCard mide con un
  // clon fuera de pantalla (ver growGridCardToFitContent), que no ve el
  // contenido de un shadow root (el visor de gcode vive en uno) -- ahi
  // mediria siempre vacio.
  if (isFeatureEnabled("cameraGcode")) patchCameraGcodeToggle();

  if (!getApiKey()) {
    const key = await bootstrapApiKey();
    if (key) setApiKey(key);
  }

  const container = document.getElementById("kxdeck-widgets-root");
  if (container) {
    createRoot(mountShadowRoot(container)).render(<Widgets />);
  }

  const gcodePane = document.getElementById("kxd-cam-gcode-pane");
  if (gcodePane) {
    createRoot(mountShadowRoot(gcodePane)).render(<CameraGcodeViewer />);
  }

  // Sin shadow root (ver HaLightToggles -- necesita las clases nativas
  // ".toggle" de KX-Bridge tal cual, que no cruzan ese limite).
  const haLightRoot = document.getElementById("kxd-ha-light-root");
  if (haLightRoot) {
    createRoot(haLightRoot).render(<HaLightToggles />);
  }
}

mount();
