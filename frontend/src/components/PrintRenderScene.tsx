import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RenderData3D } from "../hooks/usePrintRender3D";
import type { RenderQuality } from "../lib/renderQualityPref";
import { BED_TEXTURE_SIZE, BED_TEXTURE_SQUARE_SIZE, bedTextureUrl } from "../lib/bedTexture";

const NORMAL_OPACITY = 1;
// Opacidad persistente de un objeto ya marcado para saltar: se queda asi
// aunque el cursor ya no este encima, para verlo de un vistazo en el render.
const EXCLUDED_OPACITY = 0.12;
// Rango y periodo del parpadeo al pasar el cursor: SOLO la pieza/color
// sobre el que se pasa el cursor oscila entre estos dos valores -- el
// resto se queda tal cual (a diferencia del resaltado anterior, que
// atenuaba todo menos el objetivo).
const PULSE_LOW = 0.15;
const PULSE_HIGH = 1;
const PULSE_PERIOD_MS = 900;
// Velocidad con la que una pieza que deja de estar en el objetivo (o dejo
// de estar excluida) vuelve a su opacidad base -- suave, no instantaneo.
const SETTLE_RATE = 0.18;
// Halo aditivo alrededor de la pieza/color resaltado: crece un poco por
// fuera de la geometria real (GLOW_SCALE) y su intensidad sigue el MISMO
// parpadeo que la opacidad (GLOW_MAX_OPACITY en el pico, 0 en el valle) --
// nunca desacoplado del ritmo del pulso.
const GLOW_SCALE = 1.05;
const GLOW_MAX_OPACITY = 0.9;
// Margen (pixeles) que se deja entre el objeto desplazado y el borde
// izquierdo real del desplegable, para que quede claramente despejado y no
// justo al filo.
const OCCLUSION_SAFETY_PX = 14;
const CAMERA_SETTLE_RATE = 0.12;
// Opacidad del "fantasma" (ver ghostUnprinted): visible lo justo para leer
// su forma/orientacion contra el fondo, claramente distinto de una pieza
// opaca de verdad -- ni casi invisible ni tan marcado que compita
// visualmente con lo ya impreso.
const GHOST_OPACITY = 0.16;

interface MaterialEntry {
  object_index: number;
  tool: number;
  material: THREE.MeshLambertMaterial;
  glowMaterial: THREE.MeshBasicMaterial;
}

interface SceneState {
  render: () => void;
  materials: MaterialEntry[];
  // Ver ghostUnprinted/printedHeightMm: un unico par de planos COMPARTIDO
  // por todos los buckets (el corte es el mismo para toda la pieza), asi
  // que actualizar la altura impresa es solo mover estas dos constantes --
  // nunca reconstruye la escena. null si ghostUnprinted es false.
  printedPlanes: { opaque: THREE.Plane; ghost: THREE.Plane } | null;
  animRaf: number | null;
  pulseStart: number;
  camera: THREE.OrthographicCamera;
  controls: OrbitControls;
  cameraTarget: THREE.Vector3;
  originalCameraPos: THREE.Vector3;
  originalTarget: THREE.Vector3;
  camRight: THREE.Vector3;
  // Mitad del ancho del frustum ortografico en unidades de mundo (=
  // viewSize*aspect): convierte un desplazamiento NDC deseado en el
  // desplazamiento de camara real que lo produce.
  frustumHalfWidth: number;
  // Las 8 esquinas (espacio mundo) de la caja delimitadora de cada objeto
  // por indice -- se usa el objeto COMPLETO (no solo su centro) para saber
  // si el desplegable lo tapa y cuanto desplazar la camara: un objeto ancho
  // puede tener el centro fuera de la zona tapada pero un extremo dentro, y
  // desplazar solo hasta despejar el centro dejaba ese extremo tapado igual.
  objectCorners: Map<number, THREE.Vector3[]>;
  cameraAnimRaf: number | null;
}

/** Escena 3D interactiva del gcode (rotar/mover/zoom), construida a partir
 * de los buckets de vertices ya calculados en el servidor (ver
 * usePrintRender3D.ts / backend/gcode_render.py). El navegador no parsea
 * gcode ni calcula geometria: solo sube vertices+normales ya calculados a
 * la GPU via WebGL, que es tarea trivial incluso para millones de vertices.
 *
 * Cada segmento de extrusion visible (pared exterior, superficies, ver
 * filtro en gcode_render.py) es una pared vertical con normal real: una luz
 * direccional revela su orientacion, dando relieve de verdad -- no como el
 * render anterior de lineas, que al no tener cara no podia mostrar sombreado
 * dentro de una misma pieza (solo el tono cambiaba por niebla entre piezas
 * distintas). La niebla se mantiene como señal complementaria de
 * profundidad ENTRE piezas. */
export function PrintRenderScene({
  data,
  loading,
  highlightObject,
  highlightTool,
  excludedObjects,
  quality = "auto",
  aspectClassName = "aspect-square",
  className = "",
  occluderRect = null,
  ghostUnprinted = false,
  printedHeightMm = null,
}: {
  data: RenderData3D | null;
  loading?: boolean;
  highlightObject?: string | null;
  highlightTool?: number | null;
  excludedObjects?: string[];
  quality?: RenderQuality;
  aspectClassName?: string;
  className?: string;
  // DOMRect real (coordenadas de pagina, getBoundingClientRect) del
  // desplegable "Saltar objetos" mientras esta abierto, o null si esta
  // cerrado. Se usa para comprobar con precision si la pieza senalada
  // (highlightObject) queda tapada, y para calcular EXACTAMENTE cuanto
  // desplazar la camara para despejarla -- ni de mas ni de menos.
  occluderRect?: DOMRect | null;
  // Vista "en curso de impresion" (CameraGcode3DViewer, junto a la camara):
  // lo YA impreso se ve opaco de siempre, lo que falta en semi-transparente
  // -- igual que la previsualizacion de secuencia de OrcaSlicer. false
  // (por defecto) mantiene el comportamiento de siempre para el resto de
  // usos de este componente (Vista previa antes de imprimir, etc.): pieza
  // entera opaca, sin ningun corte.
  ghostUnprinted?: boolean;
  // Altura Z (mm, mismas unidades que el gcode) hasta la que se considera
  // "ya impreso" -- solo importa si ghostUnprinted es true. Se actualiza en
  // vivo (sondeo de estado) SIN reconstruir la escena entera: ver el efecto
  // dedicado mas abajo, que solo mueve dos constantes de plano.
  printedHeightMm?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  // Construye la escena una vez por fichero (por `data` nuevo). El
  // resaltado (efecto de abajo) reutiliza esta misma instancia.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data) return;

    const width = container.clientWidth || 300;
    // El contenedor ya NO es cuadrado (ver aspectClassName): ancho completo,
    // alto a la mitad. Se lee el alto real ya calculado por CSS
    // (aspect-ratio), no se asume igual al ancho.
    const height = container.clientHeight || width / 2;
    const scene = new THREE.Scene();
    // Puntero "coarse" (tactil) es la señal fiable de movil/tablet -- a
    // diferencia del ancho de pantalla, no depende de como este maximizada
    // la ventana. En estos dispositivos la GPU suele ser mucho mas
    // limitada, pero desactivar del todo la sombra (como se hacia antes)
    // dejaba las piezas sin ninguna pista de profundidad -- un plano
    // uniformemente iluminado por su propia normal no basta para distinguir
    // un volumen del vecino sin verse tapado por nada. "auto" usa una
    // sombra barata (BasicShadowMap, mapa pequeño) en vez de quitarla del
    // todo; "alta"/"rendimiento" (elegidos a mano en el boton de calidad)
    // fuerzan un nivel fijo sea cual sea el dispositivo.
    const isMobile = window.matchMedia("(pointer: coarse)").matches;
    const tier: "alta" | "media" | "rendimiento" =
      quality === "alta" ? "alta" : quality === "rendimiento" ? "rendimiento" : isMobile ? "media" : "alta";
    const antialias = tier === "alta";
    const pixelRatioCap = tier === "alta" ? 2 : 1;
    const shadowsEnabled = tier !== "rendimiento";
    const shadowMapSize = tier === "alta" ? 1024 : 512;
    // Ortografica (isometrica), no en perspectiva: sin distorsion de fuga,
    // el tamano aparente no cambia con la distancia a cada punto.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
    // Sombra real (no solo luz direccional+ambiental): sin esto, una muesca
    // o rincon recibe la misma luz que la superficie de alrededor segun su
    // propia normal, pero nunca se oscurece por estar tapada por la
    // geometria vecina -- por eso no se percibia profundidad real en
    // esquinas/relieves por mucho que se ajustara el angulo de las luces.
    renderer.shadowMap.enabled = shadowsEnabled;
    renderer.shadowMap.type = tier === "alta" ? THREE.PCFShadowMap : THREE.BasicShadowMap;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // "Local clipping" (material.clippingPlanes por material, no un corte
    // global del renderer) es lo que permite que la pieza opaca y su
    // fantasma convivan en la MISMA escena, cada uno recortado por su lado.
    // Un unico par de planos para toda la pieza (no uno por bucket): el
    // corte de altura es el mismo pase lo que pase el color/objeto.
    let printedPlanes: { opaque: THREE.Plane; ghost: THREE.Plane } | null = null;
    if (ghostUnprinted) {
      renderer.localClippingEnabled = true;
      // constant=Infinity al construir (antes de que el efecto dedicado de
      // printedHeightMm fije el valor real): mantiene TODO del lado opaco y
      // NADA del lado fantasma -- nunca se ve el modelo "roto" a medias
      // mientras el estado en vivo aun no ha llegado.
      printedPlanes = {
        opaque: new THREE.Plane(new THREE.Vector3(0, -1, 0), Infinity),
        ghost: new THREE.Plane(new THREE.Vector3(0, 1, 0), Infinity),
      };
    }

    // Caja delimitadora en espacio gcode (X/Y bandeja, Z altura), calculada
    // a mano sin asignar objetos por punto: con ficheros de millones de
    // vertices, Box3.expandByPoint por vertice seria muy lento.
    const stride = data.stride;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of data.buckets) {
      const p = b.vertexData;
      for (let i = 0; i < p.length; i += stride) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = minY = minZ = 0;
      maxX = data.bed.width;
      maxY = data.bed.height;
      maxZ = 50;
    }
    const localCenter = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const size = new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ);
    const radius = Math.max(size.length(), 20);

    // gcode es Z-up (X/Y = bandeja, Z = altura); Three.js es Y-up. Se rota
    // el grupo entero -90 en X en vez de tocar los datos (que son vistas
    // SIN COPIA sobre el ArrayBuffer descargado).
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;
    scene.add(group);

    const materials: MaterialEntry[] = [];
    const disposables: { geometry?: THREE.BufferGeometry; material: THREE.Material }[] = [];
    // Caja delimitadora acumulada POR OBJETO (un objeto puede tener varios
    // buckets, uno por color/herramienta): usada para saber hacia donde
    // desplazar la camara cuando ese objeto esta senalado y tapado por el
    // desplegable "Saltar objetos" (ver efecto mas abajo).
    const objectBoundsLocal = new Map<
      number,
      { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
    >();
    for (const b of data.buckets) {
      // vertexData esta intercalado (x,y,z,nx,ny,nz por vertice, stride=6):
      // un unico InterleavedBuffer sirve de vista SIN COPIA tanto para
      // "position" como para "normal".
      const interleaved = new THREE.InterleavedBuffer(b.vertexData, stride);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
      geometry.setAttribute("normal", new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
      const material = new THREE.MeshLambertMaterial({
        color: `#${b.color_hex}`,
        side: THREE.DoubleSide,
        transparent: true,
      });
      material.fog = true;
      if (printedPlanes) material.clippingPlanes = [printedPlanes.opaque];
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push({ geometry, material });

      // Fantasma: MISMO geometry (sin copiar vertices) y color, pero sin
      // sombra propia (quedaria como una mancha oscura poco legible a esta
      // opacidad) y recortado por el plano OPUESTO al de arriba -- entre
      // los dos planos, cada punto del modelo cae siempre en uno u otro
      // lado (nunca en ambos ni en ninguno), asi que la pieza se ve entera
      // en todo momento, solo que partida en dos tratamientos visuales.
      if (printedPlanes) {
        const ghostMaterial = new THREE.MeshLambertMaterial({
          color: `#${b.color_hex}`,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: GHOST_OPACITY,
          depthWrite: false,
          clippingPlanes: [printedPlanes.ghost],
        });
        ghostMaterial.fog = true;
        const ghostPrintMesh = new THREE.Mesh(geometry, ghostMaterial);
        group.add(ghostPrintMesh);
        disposables.push({ material: ghostMaterial });
      }

      // Centro (bbox) de ESTE bucket concreto (no el de la pieza entera):
      // el halo de glow se escala alrededor de este punto para que "crezca"
      // desde dentro del propio bucket en vez de desplazarse hacia un lado.
      let bminX = Infinity, bminY = Infinity, bminZ = Infinity;
      let bmaxX = -Infinity, bmaxY = -Infinity, bmaxZ = -Infinity;
      const p = b.vertexData;
      for (let i = 0; i < p.length; i += stride) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < bminX) bminX = x;
        if (x > bmaxX) bmaxX = x;
        if (y < bminY) bminY = y;
        if (y > bmaxY) bmaxY = y;
        if (z < bminZ) bminZ = z;
        if (z > bmaxZ) bmaxZ = z;
      }
      const bcx = (bminX + bmaxX) / 2, bcy = (bminY + bmaxY) / 2, bcz = (bminZ + bmaxZ) / 2;

      const ob = objectBoundsLocal.get(b.object_index);
      if (!ob) {
        objectBoundsLocal.set(b.object_index, { minX: bminX, maxX: bmaxX, minY: bminY, maxY: bmaxY, minZ: bminZ, maxZ: bmaxZ });
      } else {
        ob.minX = Math.min(ob.minX, bminX); ob.maxX = Math.max(ob.maxX, bmaxX);
        ob.minY = Math.min(ob.minY, bminY); ob.maxY = Math.max(ob.maxY, bmaxY);
        ob.minZ = Math.min(ob.minZ, bminZ); ob.maxZ = Math.max(ob.maxZ, bmaxZ);
      }

      // Halo: el MISMO geometry (sin copiar los vertices), un poco mas
      // grande (escalado alrededor del centro de arriba) y en aditivo, para
      // que se lea como un resplandor alrededor de la pieza/color en vez de
      // un simple cambio de tono. Invisible (opacity 0) hasta que el
      // parpadeo lo active.
      const glowMaterial = new THREE.MeshBasicMaterial({
        color: `#${b.color_hex}`,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const glowMesh = new THREE.Mesh(geometry, glowMaterial);
      glowMesh.position.set(bcx * (1 - GLOW_SCALE), bcy * (1 - GLOW_SCALE), bcz * (1 - GLOW_SCALE));
      glowMesh.scale.setScalar(GLOW_SCALE);
      group.add(glowMesh);
      disposables.push({ material: glowMaterial });

      materials.push({ object_index: b.object_index, tool: b.tool, material, glowMaterial });
    }

    // Contorno de la bandeja en coordenadas de mundo (ya con el eje
    // vertical de pantalla, Y=0): X en [0, ancho], Z en [-alto, 0] -- mismo
    // cambio de eje que la rotacion del grupo, ver mapeo de worldCenter mas
    // abajo.
    const bw = data.bed.width;
    const bh = data.bed.height;
    const bedGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(bw, 0, 0),
      new THREE.Vector3(bw, 0, -bh),
      new THREE.Vector3(0, 0, -bh),
    ]);
    const bedMaterial = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5, fog: false });
    scene.add(new THREE.LineLoop(bedGeometry, bedMaterial));
    disposables.push({ geometry: bedGeometry, material: bedMaterial });

    // Serigrafia real de la bandeja (mismo SVG que PrintRenderFlat.tsx,
    // rasterizado aqui como textura): ayuda a saber la orientacion de la
    // pieza sobre la bandeja de un vistazo. Encajada por "contain" segun
    // el CUADRADO util (BED_TEXTURE_SQUARE_SIZE, ver su comentario) --
    // igual que bedTextureTransform() en lib/bedTexture.ts, el sobrante
    // (la solapa de la etiqueta) cuelga fuera de la bandeja en vez de
    // encajarse dentro, sin centrar. En 3D real no hace falta proyectar a
    // mano: la propia camara ya lo hace, solo hay que colocar el plano.
    const texScale = Math.min(bw / BED_TEXTURE_SQUARE_SIZE, bh / BED_TEXTURE_SQUARE_SIZE);
    const texW = BED_TEXTURE_SIZE.width * texScale;
    const texH = BED_TEXTURE_SIZE.height * texScale;
    const bedTexture = new THREE.TextureLoader().load(bedTextureUrl, () => render());
    bedTexture.colorSpace = THREE.SRGBColorSpace;
    const bedTexGeometry = new THREE.PlaneGeometry(texW, texH);
    const bedTexMaterial = new THREE.MeshBasicMaterial({
      map: bedTexture,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const bedTexMesh = new THREE.Mesh(bedTexGeometry, bedTexMaterial);
    // Plano por defecto mirando a +Z local; -90 en X lo tumba mirando a
    // +Y mundo (hacia la camara, que ve desde arriba) -- mismo giro que
    // convierte el resto de la geometria de espacio gcode (Z arriba) a
    // espacio Three.js (Y arriba). Posicion: borde izquierdo (svgX=0) en
    // gcode X=0, borde superior real -- el del cuadrado util, no el de la
    // solapa -- (svgY=0) en gcode Y=bh (fondo de la bandeja), dejando la
    // solapa asomar hacia gcode Y<0 (delante del borde).
    bedTexMesh.rotation.x = -Math.PI / 2;
    bedTexMesh.position.set(texW / 2, 0.02, texH / 2 - bh);
    scene.add(bedTexMesh);
    disposables.push({ geometry: bedTexGeometry, material: bedTexMaterial });

    // Centro/camara en coordenadas de mundo: (x,y,z) local -> (x,z,-y)
    // mundo, mismo cambio de eje que produce group.rotation.x = -PI/2.
    // Azimut NEGATIVO: frontal-izquierdo (X negativo respecto al centro),
    // no frontal-derecho.
    const worldCenter = new THREE.Vector3(localCenter.x, localCenter.z, -localCenter.y);
    const azimuth = -Math.PI / 4;
    // Elevacion inicial (angulo por defecto antes de que el usuario orbite
    // con el raton/dedo): 37° -- 15° mas que antes (22°), pedido para ver
    // la pieza mas desde arriba de entrada.
    const elevation = (37 * Math.PI) / 180;
    const dist = radius * 1.6;
    camera.position.set(
      worldCenter.x + dist * Math.cos(elevation) * Math.sin(azimuth),
      worldCenter.y + dist * Math.sin(elevation),
      worldCenter.z + dist * Math.cos(elevation) * Math.cos(azimuth),
    );
    // Encuadre ortografico: el tamano visible lo dan left/right/top/bottom,
    // no la distancia de la camara (a diferencia de una perspectiva). En vez
    // de un multiplicador aproximado sobre el radio (dejaba la pieza chica
    // con mucho margen alrededor), se proyectan las 8 esquinas de la caja
    // delimitadora sobre los ejes real "derecha"/"arriba" de ESTA camara (su
    // azimut/elevacion concretos) y se ajusta el encuadre justo a ese
    // tamano -- mismo aspecto ajustado que la miniatura del slicer, sin
    // apenas margen.
    const aspect = width / height;
    const worldCorners = [
      [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, minZ], [minX, maxY, maxZ],
      [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, minZ], [maxX, maxY, maxZ],
    ].map(([lx, ly, lz]) => new THREE.Vector3(lx, lz, -ly));
    const forward = worldCenter.clone().sub(camera.position).normalize();
    const camRight = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const camUp = new THREE.Vector3().crossVectors(camRight, forward).normalize();
    let minRight = Infinity, maxRight = -Infinity, minUp = Infinity, maxUp = -Infinity;
    for (const corner of worldCorners) {
      const rel = corner.clone().sub(worldCenter);
      const r = rel.dot(camRight);
      const u = rel.dot(camUp);
      if (r < minRight) minRight = r;
      if (r > maxRight) maxRight = r;
      if (u < minUp) minUp = u;
      if (u > maxUp) maxUp = u;
    }
    // Pequeño margen (8%) para que la pieza no quede pegada al borde.
    const margin = 1.08;
    const halfWidth = Math.max(Math.abs(minRight), Math.abs(maxRight), 1) * margin;
    const halfHeight = Math.max(Math.abs(minUp), Math.abs(maxUp), 1) * margin;
    const viewSize = Math.max(halfHeight, halfWidth / aspect);
    camera.top = viewSize;
    camera.bottom = -viewSize;
    camera.left = -viewSize * aspect;
    camera.right = viewSize * aspect;
    camera.near = 0.1;
    camera.far = dist * 20;
    camera.lookAt(worldCenter);
    camera.updateProjectionMatrix();

    // Las 8 esquinas de la caja delimitadora de cada objeto, en coordenadas
    // de mundo (mismo cambio de eje que worldCenter: local (x,y,z) -> mundo
    // (x,z,-y)) -- se usan proyectadas para saber si el desplegable tapa
    // CUALQUIER parte del objeto, no solo su centro (ver efecto mas abajo).
    const objectCorners = new Map<number, THREE.Vector3[]>();
    for (const [objectIndex, ob] of objectBoundsLocal) {
      const corners = [
        [ob.minX, ob.minY, ob.minZ], [ob.minX, ob.minY, ob.maxZ],
        [ob.minX, ob.maxY, ob.minZ], [ob.minX, ob.maxY, ob.maxZ],
        [ob.maxX, ob.minY, ob.minZ], [ob.maxX, ob.minY, ob.maxZ],
        [ob.maxX, ob.maxY, ob.minZ], [ob.maxX, ob.maxY, ob.maxZ],
      ].map(([lx, ly, lz]) => new THREE.Vector3(lx, lz, -ly));
      objectCorners.set(objectIndex, corners);
    }

    // Luz: ambiental suave (para que no haya negros absolutos) + direccional
    // que da el sombreado real. Ambas luces direccionales son HIJAS de la
    // camara (en vez de fijas en el mundo): con una luz fija, en cuanto el
    // usuario orbita la pieza, zonas que antes estaban bien iluminadas
    // pasan a quedar completamente a oscuras (la luz se queda "detras" o
    // en un lado que ya no corresponde a lo que se ve). Colgando la luz de
    // la camara con un desplazamiento en espacio LOCAL, gira junto con
    // cada arrastre/orbita sin recalcular nada a mano, y la iluminacion
    // relativa al punto de vista es SIEMPRE la misma sea cual sea el
    // angulo actual.
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));

    // key light: desplazada respecto al eje de vision (no pegada a la
    // camara del todo) para que distintas caras reciban distinta luz --
    // pegada del todo seria otra vez el efecto "foto con flash" sin
    // contraste. El desplazamiento (110° "azimut", 58° "elevacion") es
    // ahora relativo a hacia donde mira la camara, no al mundo.
    // Posicion/target escalados por `dist` (no un vector unitario): el
    // target se coloca exactamente en worldCenter (local (0,0,-dist) segun
    // mira la camara, que esta a `dist` de worldCenter), para que la camara
    // de sombra de mas abajo seguido siga viendo distancias del mismo
    // orden que antes (cuando la luz era fija en el mundo).
    const keyLocalAzimuth = (110 * Math.PI) / 180;
    const keyLocalElevation = (58 * Math.PI) / 180;
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(
      Math.cos(keyLocalElevation) * Math.sin(keyLocalAzimuth) * dist,
      Math.sin(keyLocalElevation) * dist,
      Math.cos(keyLocalElevation) * Math.cos(keyLocalAzimuth) * dist,
    );
    const keyLightTarget = new THREE.Object3D();
    keyLightTarget.position.set(0, 0, -dist);
    camera.add(keyLightTarget);
    keyLight.target = keyLightTarget;
    camera.add(keyLight);

    // Sombra proyectada real: sin esto, una muesca/rincon recibe luz solo
    // segun SU PROPIA normal, nunca se oscurece por estar tapada por la
    // geometria vecina. La camara de sombra (ortografica, como la propia
    // DirectionalLight) se encuadra al tamano real de la pieza igual que
    // la camara principal; su posicion/orientacion las hereda solas de la
    // luz (que ahora cuelga de la camara), no hay que tocarla al orbitar.
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const shadowCam = keyLight.shadow.camera;
    shadowCam.left = -radius * 1.2;
    shadowCam.right = radius * 1.2;
    shadowCam.top = radius * 1.2;
    shadowCam.bottom = -radius * 1.2;
    shadowCam.near = dist * 0.1;
    shadowCam.far = dist * 3;
    shadowCam.updateProjectionMatrix();
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.015;

    // Luz de relleno, pegada del todo a la direccion de vision (como una
    // linterna de foto en el propio ojo): rellena lo que el key light
    // desplazado deja demasiado oscuro. Intensidad baja: es relleno, no
    // debe aplanar el contraste que da el key light + la sombra real.
    const cameraLight = new THREE.DirectionalLight(0xffffff, 0.22);
    cameraLight.position.set(0, 0, 0);
    const cameraLightTarget = new THREE.Object3D();
    cameraLightTarget.position.set(0, 0, -1);
    camera.add(cameraLightTarget);
    cameraLight.target = cameraLightTarget;
    camera.add(cameraLight);
    // Imprescindible: para que el renderer recoja las luces colgadas de la
    // camara hay que colgar la propia camara de la escena (si no, sus
    // hijos -- las luces y sus target -- quedan fuera del grafo que se
    // recorre al buscar luces).
    scene.add(camera);

    // Niebla de profundidad calibrada al rango de profundidad REAL que ve
    // la camara (distancia a las 8 esquinas de la caja delimitadora), no al
    // tamano total de la pieza: con varios objetos repartidos en X/Y, la
    // diagonal 3D completa es mucho mayor que la altura de cada objeto, y
    // calibrar la niebla con esa diagonal la dejaba practicamente
    // imperceptible. Se recalcula en cada cambio de camara (ver
    // updateFog/controls "change" mas abajo): con zoom/orbita libres, un
    // rango fijo calculado solo una vez dejaba de encajar en cuanto te
    // alejabas (todo se veia gris) o te acercabas (nada se veia fogueado).
    const localCorners = [
      [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, minZ], [minX, maxY, maxZ],
      [maxX, minY, minZ], [maxX, minY, maxZ], [maxX, maxY, minZ], [maxX, maxY, maxZ],
    ].map(([lx, ly, lz]) => new THREE.Vector3(lx, lz, -ly));

    function updateFog() {
      let nearDepth = Infinity, farDepth = -Infinity;
      for (const corner of localCorners) {
        const d = camera.position.distanceTo(corner);
        if (d < nearDepth) nearDepth = d;
        if (d > farDepth) farDepth = d;
      }
      if (!Number.isFinite(nearDepth) || farDepth <= nearDepth) {
        nearDepth = dist * 0.5;
        farDepth = dist * 1.5;
      }
      // Rango bastante mas relajado que antes (near*0.3 / far*0.98): en
      // bandejas con varias piezas repartidas (no solo 2 juntas), esa
      // agresividad fogueaba casi TODO a un gris practicamente puro --
      // sobre todo grave con colores de filamento ya de por si grisaceos
      // (gris/blanco/beige son colores de PLA muy comunes), donde el color
      // real de la pieza y el color de la niebla casi coinciden: cualquier
      // pizca de niebla ya la hacia indistinguible del fondo. Ahora empieza
      // DESPUES del punto mas cercano (nada de niebla en primer plano) y
      // nunca llega a fogueado completo ni en el punto mas lejano.
      if (!scene.fog) scene.fog = new THREE.Fog(0xe8e8e8, 0, 1);
      (scene.fog as THREE.Fog).near = nearDepth * 1.15;
      (scene.fog as THREE.Fog).far = farDepth * 2.6;
    }
    updateFog();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(worldCenter);
    controls.update();

    function render() {
      updateFog();
      renderer.render(scene, camera);
    }
    render();
    controls.addEventListener("change", render);

    const resizeObserver = new ResizeObserver(() => {
      // El aspecto (ancho/alto) lo fija la clase CSS del contenedor y no
      // cambia con el tamano, asi que basta con redimensionar el renderer
      // -- no hace falta recalcular el frustum de la camara.
      const w = container.clientWidth || width;
      const h = container.clientHeight || height;
      renderer.setSize(w, h);
      render();
    });
    resizeObserver.observe(container);

    stateRef.current = {
      render,
      materials,
      animRaf: null,
      pulseStart: 0,
      camera,
      controls,
      cameraTarget: worldCenter.clone(),
      originalCameraPos: camera.position.clone(),
      originalTarget: worldCenter.clone(),
      camRight: camRight.clone(),
      frustumHalfWidth: viewSize * aspect,
      objectCorners,
      cameraAnimRaf: null,
      printedPlanes,
    };

    return () => {
      const st = stateRef.current;
      if (st?.animRaf != null) cancelAnimationFrame(st.animRaf);
      if (st?.cameraAnimRaf != null) cancelAnimationFrame(st.cameraAnimRaf);
      resizeObserver.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      renderer.dispose();
      for (const d of disposables) {
        d.geometry?.dispose();
        d.material.dispose();
      }
      bedTexture.dispose();
      container.innerHTML = "";
      stateRef.current = null;
    };
  }, [data, quality, ghostUnprinted]);

  // Solo mueve las dos constantes de plano compartidas (ver printedPlanes
  // arriba) y vuelve a pintar UN frame -- nunca reconstruye la escena, asi
  // que puede llamarse en cada sondeo de estado (varias veces por segundo
  // durante una impresion en curso) sin sobresalto ni coste real. Infinity
  // en ambos lados (altura desconocida) deja todo del lado opaco, igual que
  // al construir la escena la primera vez.
  useEffect(() => {
    const state = stateRef.current;
    if (!state?.printedPlanes) return;
    const h = printedHeightMm;
    state.printedPlanes.opaque.constant = h ?? Infinity;
    state.printedPlanes.ghost.constant = h != null ? -h : Infinity;
    state.render();
  }, [printedHeightMm]);

  // Resaltado: SOLO la pieza/color sobre el que se pasa el cursor parpadea
  // (oscila de forma continua entre transparente y opaco) -- el resto se
  // queda tal cual, sin atenuar. Un objeto ya marcado para saltar se queda
  // en su opacidad reducida de forma persistente (no solo mientras el
  // cursor esta encima), para verlo de un vistazo en el render.
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !data) return;

    const hasHighlight = highlightObject != null || highlightTool != null;
    state.pulseStart = performance.now();

    function isMatch(entry: MaterialEntry): boolean {
      if (highlightObject != null) {
        return (entry.object_index >= 0 ? data!.objects[entry.object_index] : null) === highlightObject;
      }
      if (highlightTool != null) return entry.tool === highlightTool;
      return false;
    }

    function baseOpacity(entry: MaterialEntry): number {
      if (excludedObjects && excludedObjects.length && entry.object_index >= 0) {
        const name = data!.objects[entry.object_index];
        if (excludedObjects.includes(name)) return EXCLUDED_OPACITY;
      }
      return NORMAL_OPACITY;
    }

    if (state.animRaf != null) cancelAnimationFrame(state.animRaf);
    const tick = () => {
      const st = stateRef.current;
      if (!st) return;
      const now = performance.now();
      let animating = false;
      for (const entry of st.materials) {
        const target = baseOpacity(entry);
        if (hasHighlight && isMatch(entry)) {
          const phase = ((now - st.pulseStart) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
          const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0..1..0 suave
          const pulseTarget = PULSE_LOW + (PULSE_HIGH - PULSE_LOW) * wave;
          // Se suaviza tambien la ENTRADA al parpadeo (en vez de saltar de
          // golpe a PULSE_LOW nada mas empezar el hover), para que no se
          // note un "golpe" de cambio de opacidad al iniciar la animacion.
          entry.material.opacity += (pulseTarget - entry.material.opacity) * SETTLE_RATE;
          // Glow: mismo ritmo que el parpadeo de opacidad, nunca
          // desacoplado -- en el valle del pulso (PULSE_LOW) desaparece del
          // todo, en el pico (PULSE_HIGH) llega a su maximo.
          const glowTarget =
            (GLOW_MAX_OPACITY * Math.max(0, pulseTarget - PULSE_LOW)) / (PULSE_HIGH - PULSE_LOW);
          entry.glowMaterial.opacity += (glowTarget - entry.glowMaterial.opacity) * SETTLE_RATE;
          animating = true;
        } else {
          const cur = entry.material.opacity;
          if (Math.abs(cur - target) > 0.003) {
            entry.material.opacity = cur + (target - cur) * SETTLE_RATE;
            animating = true;
          } else {
            entry.material.opacity = target;
          }
          if (Math.abs(entry.glowMaterial.opacity) > 0.003) {
            entry.glowMaterial.opacity += (0 - entry.glowMaterial.opacity) * SETTLE_RATE;
            animating = true;
          } else {
            entry.glowMaterial.opacity = 0;
          }
        }
      }
      st.render();
      if (animating) {
        st.animRaf = requestAnimationFrame(tick);
      } else {
        st.animRaf = null;
      }
    };
    state.animRaf = requestAnimationFrame(tick);
  }, [data, highlightObject, highlightTool, excludedObjects]);

  // Si el desplegable "Saltar objetos" esta abierto y la pieza senalada
  // queda tapada por su rectangulo REAL (occluderRect, medido en el
  // propio desplegable), la camara se desplaza a la derecha EXACTAMENTE
  // lo necesario para despejarla (ver calculo de shiftAmount: convierte el
  // desplazamiento NDC deseado en desplazamiento de camara real via
  // frustumHalfWidth, en vez de una cantidad fija que unas veces se queda
  // corta y otras se pasa). Al dejar de senalar una pieza tapada, vuelve a
  // su posicion original.
  useEffect(() => {
    const state = stateRef.current;
    const container = containerRef.current;
    if (!state || !data || !container) return;

    let shiftAmount = 0;
    if (occluderRect && highlightObject != null) {
      const objectIndex = data.objects.indexOf(highlightObject);
      const corners = objectIndex >= 0 ? state.objectCorners.get(objectIndex) : undefined;
      if (corners && corners.length) {
        const canvasWidth = container.clientWidth;
        const canvasHeight = container.clientHeight;
        const containerRect = container.getBoundingClientRect();
        // Rectangulo del desplegable, convertido de coordenadas de pagina a
        // coordenadas NDC (-1..1) de ESTE canvas concreto.
        const relLeft = occluderRect.left - containerRect.left;
        const relRight = occluderRect.right - containerRect.left;
        const relTop = occluderRect.top - containerRect.top;
        const relBottom = occluderRect.bottom - containerRect.top;
        const ndcRectLeft = (relLeft / canvasWidth) * 2 - 1;
        const ndcRectRight = (relRight / canvasWidth) * 2 - 1;
        const ndcRectTop = 1 - (relTop / canvasHeight) * 2;
        const ndcRectBottom = 1 - (relBottom / canvasHeight) * 2;

        // Caja NDC del objeto COMPLETO (las 8 esquinas proyectadas, no solo
        // el centro): un objeto ancho puede tener el centro fuera de la
        // zona tapada pero un extremo dentro, y viceversa un objeto grande
        // puede necesitar mucho mas desplazamiento que el que bastaria para
        // despejar solo su centro.
        let minNdcX = Infinity, maxNdcX = -Infinity, minNdcY = Infinity, maxNdcY = -Infinity;
        for (const corner of corners) {
          const ndc = corner.clone().project(state.camera);
          if (ndc.x < minNdcX) minNdcX = ndc.x;
          if (ndc.x > maxNdcX) maxNdcX = ndc.x;
          if (ndc.y < minNdcY) minNdcY = ndc.y;
          if (ndc.y > maxNdcY) maxNdcY = ndc.y;
        }
        const occluded = maxNdcX >= ndcRectLeft && minNdcX <= ndcRectRight && minNdcY <= ndcRectTop && maxNdcY >= ndcRectBottom;
        if (occluded) {
          const safetyNdc = (OCCLUSION_SAFETY_PX / canvasWidth) * 2;
          const ndcTargetX = ndcRectLeft - safetyNdc;
          // Se desplaza hasta despejar el punto MAS a la derecha del
          // objeto (maxNdcX), no su centro -- asi el objeto entero queda
          // fuera del desplegable, no solo su mitad.
          shiftAmount = Math.max(0, (maxNdcX - ndcTargetX) * state.frustumHalfWidth);
        }
      }
    }

    const targetCameraPos = state.originalCameraPos.clone().addScaledVector(state.camRight, shiftAmount);
    const targetLookAt = state.originalTarget.clone().addScaledVector(state.camRight, shiftAmount);

    if (state.cameraAnimRaf != null) cancelAnimationFrame(state.cameraAnimRaf);
    const tick = () => {
      const st = stateRef.current;
      if (!st) return;
      st.camera.position.lerp(targetCameraPos, CAMERA_SETTLE_RATE);
      st.cameraTarget.lerp(targetLookAt, CAMERA_SETTLE_RATE);
      st.controls.target.copy(st.cameraTarget);
      st.controls.update();
      st.render();
      const done =
        st.camera.position.distanceTo(targetCameraPos) < 0.05 && st.cameraTarget.distanceTo(targetLookAt) < 0.05;
      if (!done) {
        st.cameraAnimRaf = requestAnimationFrame(tick);
      } else {
        st.cameraAnimRaf = null;
      }
    };
    state.cameraAnimRaf = requestAnimationFrame(tick);
  }, [data, highlightObject, occluderRect]);

  if (!data) {
    return (
      <div className={`flex ${aspectClassName} w-full items-center justify-center rounded-xl bg-neutral-500/5 ${className}`}>
        {loading && <span className="text-xs text-neutral-500">Generando render...</span>}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`${aspectClassName} w-full touch-none overflow-hidden rounded-xl bg-neutral-500/5 ${className}`}
    />
  );
}
