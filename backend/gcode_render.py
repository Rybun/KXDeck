"""Render 3D interactivo de una pieza completa (todas las capas, no una
sola como el visor de gcode), a partir del gcode real. Se usa para resaltar
visualmente que zona ocupa cada color de paint (al mapear a un slot fisico)
y que zona ocupa cada objeto nombrado (al elegir cuales saltar), y para dar
una vista 3D rotable y con sombreado real de la pieza.

Deliberadamente NO se manda al navegador nada mas que vertices ya listos: el
parseo completo del gcode (potencialmente >100MB) se hace aqui, y el
resultado es un contenedor binario que Three.js consume directo como
BufferGeometry, sin que el navegador tenga que interpretar gcode ni construir
geometria el mismo. El dibujado interactivo (rotar/zoom, sombreado) lo hace
la GPU via WebGL, que es tarea trivial incluso para millones de vertices.

Solo se genera geometria para tipos de gcode que serian visibles de verdad
en la pieza terminada — pared interna y relleno interno se descartan (nunca
se ven en la pieza real, y son la mayor parte del volumen de un gcode
tipico, lo que compensa el coste extra de mandar normales por vertice
frente al render de solo-lineas anterior). Los tipos que SI se dibujan se
tratan de forma distinta segun su naturaleza (ver WALL_TYPES/CAP_TYPES/
SUPPORT_TYPES): un contorno de perimetro (pared exterior, voladizo,
puentes) o un soporte se dibuja como pared VERTICAL; un relleno de
superficie en zigzag/concentrico (top/bottom surface, ironing) NO se puede
tratar igual -- una pared de ancho cero por linea deja huecos entre
"tablones" en vez de una tapa continua -- asi que se dibuja como CINTA
HORIZONTAL con ancho real para que las lineas adyacentes se solapen. Los
soportes van en su PROPIO bucket (is_support=true en el header, ver mas
abajo) para poder ocultarlos en el visor sin tocar el resto -- purga
(prime tower) sigue descartada del todo, nunca se ve en la pieza real ni
tiene sentido "mostrarla".

Formato del contenedor 3D (ver tambien frontend/src/hooks/usePrintRender3D.ts,
que es el consumidor):
  [4 bytes] longitud del header en bytes (uint32 little-endian)
  [N bytes] header UTF-8 JSON: {"bed": {...}, "objects": [...], "stride": 6,
      "buckets": [{"object_index":0,"tool":3,"color_hex":"23A3C7","count":12345,
          "offset":0,"is_support":false}, ...]}
  [resto] Float32Array concatenado de todos los buckets en orden del header;
      cada bucket son `count` vertices * `stride` floats (x,y,z,nx,ny,nz),
      `offset` es el byte donde empieza dentro de este bloque (no del
      fichero completo).

Ademas del render 3D, build_render_buffers() genera en la MISMA pasada un
segundo contenedor 2D (vista cenital/planta O isometrica, a elegir en el
frontend), para el resaltado de mapeo de colores/objetos a saltar cuando el
usuario tiene el render 3D desactivado (pesado en ficheros grandes, y sobre
todo pensado para dispositivos menos potentes). Solo usa los segmentos de
pared EXTERIOR (WALL_TYPES) -- son ya el contorno cerrado de cada capa, así
que no hace falta ningun calculo de silueta/hull: cada vez que la pluma
dejaria de seguir el mismo contorno continuo (cambia de objeto/herramienta,
salta a otra capa, o hay un hueco -- un tramo no-pared en medio) se cierra
el loop acumulado y se empieza uno nuevo. Todos los loops de un mismo
bucket (objeto+color) se pintan superpuestos con el MISMO color opaco: como
todas las capas de una pieza de paredes rectas comparten casi la misma
huella en X/Y, el simple solape ya da el efecto de "silueta rellena vista
desde arriba" sin ninguna operacion booleana de poligonos.

Con ficheros de muchas capas (p.ej. 0.06mm de altura en una pieza de 10cm
son ~1600 capas) esto podia acumular cientos de miles de puntos por bucket
-- un <path> SVG tan complejo resulta MAS pesado de animar (el resaltado
por hover) en el navegador que el propio render 3D via WebGL, justo lo
contrario de la idea de esta vista (ligera, para moviles/equipos menos
potentes). Por eso, antes de serializar, cada bucket se reduce a un maximo
de MAX_LOOPS_PER_BUCKET capas Z (_group_layers + _downsample_layers,
muestreo uniforme que siempre incluye la primera y la ultima): aproximacion
deliberada, igual de pragmatica que el resto de este modulo -- la mayoria de
tramos rectos verticales de una pieza tienen practicamente el mismo contorno
capa a capa, asi que perder capas intermedias apenas se nota, y sea cual sea
el tamano del fichero el peor caso queda acotado. El recorte agrupa PRIMERO
por Z real (una misma capa puede tener varias islas independientes -- p.ej.
orejas, lazos, cuerdas decorativas sueltas -- y hay que conservarlas o
descartarlas juntas): si se recortara por loop suelto sin agrupar, el
muestreo por indice podia quedarse solo con la loop de una decoracion suelta
de una capa, dejando sin rellenar el cuerpo principal de esa misma capa --
un hueco real, no solo perdida de detalle.

Ademas, el `d` de cada <path> SVG (para AMBAS vistas, cenital e isometrica)
se construye aqui mismo, no en el navegador: el cliente solo tiene que
inyectar el string ya listo, sin repetir ningun calculo de proyeccion ni
de construccion de geometria (ver _project/_build_view). El contenedor es
JSON plano (no hace falta el framing binario del render 3D: tras el
recorte de arriba, el volumen de datos es pequeño):
  {"objects": [...],
   "views": {
     "top": {"bounds": {"minX":.., "minY":.., "maxX":.., "maxY":..},
              "bed_d": "M...Z", "paths": [{"object_index":0, "tool":3,
              "color_hex":"23A3C7", "d": "M...Z M...Z ..."}, ...]},
     "iso": {... misma forma, proyectado con el mismo angulo que la camara
             por defecto de PrintRenderScene.tsx, PERO cada path trae ademas
             "quads": [{"d":"M...Z", "color_hex":"..."}, ...] -- un
             pequeño cuadrilatero por segmento de pared, ya sombreado
             segun su normal, MAS un ultimo poligono (la tapa superior, ver
             _build_view). "d" en si sigue siendo el contorno combinado
             (para el trazo de glow del hover), el relleno visible en
             isometrico usa los quads. Ademas trae "object_bounds":
             {"<object_index>": {"minX":.., "minY":.., "maxX":.., "maxY":..}}
             -- caja delimitadora 2D POR OBJETO (no solo la global de
             "bounds"), que el frontend usa para el mismo desplazamiento de
             "camara" (aqui, del viewBox del SVG) que PrintRenderScene.tsx
             hace al saltar objetos tapados por el desplegable. }
   }}

Cada segmento de pared real se convierte en un quad vertical (2 triangulos,
6 vertices SIN indexar -- misma normal repetida en los 6, flat shading): va
desde `z - altura_de_esta_capa` hasta `z`, con ancho = la longitud del
segmento en el plano XY y normal = perpendicular horizontal a la direccion
del segmento. Esto es lo que permite que una luz direccional revele el
contorno real de la pieza (paredes con distinta orientacion reciben distinta
cantidad de luz), cosa que una linea sin cara no puede hacer. La altura de
capa se lee EXACTA de cada `;HEIGHT:` (OrcaSlicer la pone justo tras cada
`;LAYER_CHANGE`) en vez de usar un valor nominal fijo para todo el fichero
-- con altura de capa variable, un valor fijo no cuadra con cada capa real
y deja huecos verticales entre capas (aspecto de "malla" en vez de pared
solida). Ademas, cada pared tambien lleva un remate horizontal arriba (misma
tecnica que las tapas, con ancho real): una pared es un plano de grosor
cero, invisible visto casi en vertical desde arriba/abajo sin ese remate.

Aproximacion deliberada, igual que frontend/src/lib/gcodeParser.ts: solo
G0/G1 en coordenadas absolutas (sin G91), sin interpretar arcos G2/G3; no se
intenta unir/suavizar la normal con los segmentos vecinos.
"""

import array
import json
import math
import struct

# Mismo fallback que TOOL_PALETTE en frontend/src/lib/gcodeColors.ts —
# mantener sincronizados si se cambia uno de los dos.
DEFAULT_TOOL_PALETTE = [
    "#fbbf24", "#38bdf8", "#f472b6", "#34d399",
    "#a78bfa", "#f87171", "#fb923c", "#94a3b8",
]

# Tipos de gcode que forman un contorno de perimetro cerrado: se dibujan
# como pared VERTICAL (de z-layer_height a z, ancho = longitud del
# segmento). Coincidencia EXACTA (no substring) tras minusculizar:
# importante para no colar "Internal Bridge" al buscar "bridge".
WALL_TYPES = {
    "outer wall", "overhang wall", "bridge",
}

# Tipos de gcode que son relleno de superficie en zigzag/concentrico (cubren
# un AREA, no un contorno). Una pared vertical de ancho cero por linea deja
# huecos entre lineas -- se dibujan en cambio como CINTA HORIZONTAL con
# ancho real (NOMINAL_LINE_WIDTH), para que las lineas adyacentes se solapen
# y tapen del todo (sin esto la pieza queda "abierta" por arriba, dejando
# ver el fondo a traves — justo el aspecto "semitransparente" reportado).
CAP_TYPES = {
    "top surface", "bottom surface", "ironing",
}

# Soportes: DESACTIVADO por ahora -- ver el aviso grande mas abajo antes de
# volver a activarlo.
#
# Un intento de dibujarlos (misma tecnica de pared vertical que WALL_TYPES,
# en su propio bucket is_support para poder ocultarlos) reboto en produccion:
# el volumen de gcode de soporte de una pieza tipica es varias veces el de
# la propia pieza (es relleno denso, no un simple contorno), y la tecnica de
# "pared+remate" (18 floats por segmento, ver el bucle mas abajo) multiplica
# eso todavia mas -- un bucket de soporte llego a 16.3 MILLONES de vertices
# en un solo fichero real de la biblioteca (~390MB solo esa lista de
# Python). Multiplicado por prewarm_loop recorriendo TODA la biblioteca sin
# parar, el proceso murio a manos del OOM killer del sistema repetidas
# veces por minuto (Raspberry Pi con ~20 contenedores mas compartiendo RAM)
# -- confirmado con `dmesg`/journalctl: "Out of memory: Killed process ...
# (python)" cada 60-90s, docker reiniciando el contenedor sin parar detras.
#
# Si se retoma esta idea: NO reusar la tecnica de pared+remate tal cual
# para soportes (demasiados floats por segmento para su volumen tipico) --
# pensar en algo mas barato (una cinta simple sin remate, un muestreo/
# decimado del propio soporte, o generarlo bajo demanda SOLO cuando el
# usuario active el interruptor en vez de en cada pasada de prewarm) y
# probar contra un fichero con soportes densos de verdad antes de desplegar.
SUPPORT_TYPES: set[str] = set()

STRIDE = 6  # x,y,z,nx,ny,nz por vertice
STRIDE_2D = 3  # x,y,z por punto acumulado (buffer interno, no va por cable)
DEFAULT_LAYER_HEIGHT = 0.2
# Ancho nominal de linea para las cintas horizontales de las tapas: un poco
# mayor que el 0.4mm de boquilla tipico para asegurar solape entre lineas
# adyacentes (aproximacion deliberada, no se calcula el ancho real de
# extrusion por segmento).
NOMINAL_LINE_WIDTH = 0.48
# Tope de loops (capas) por bucket en la vista 2D: ver docstring del modulo
# (evita <path> con cientos de miles de puntos en piezas de muchas capas).
MAX_LOOPS_PER_BUCKET = 48

# Mismo angulo que la camara por defecto de PrintRenderScene.tsx (3D):
# azimut -45°, elevacion 37°. Se calcula aqui DIRECTAMENTE en espacio gcode
# (Z arriba) -- formula equivalente a la de esa escena, pero sin pasar por
# su rotacion a espacio Three.js (Y arriba): local.x=world.x,
# local.z=world.y, local.y=-world.z es la conversion inversa de esa
# rotacion.
_ISO_AZIMUTH = -math.pi / 4
_ISO_ELEVATION = math.radians(37)


def _cross(a: tuple, b: tuple) -> tuple:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _normalize(v: tuple) -> tuple:
    length = math.hypot(*v) or 1.0
    return (v[0] / length, v[1] / length, v[2] / length)


_ISO_CAM_DIR = (
    math.cos(_ISO_ELEVATION) * math.sin(_ISO_AZIMUTH),
    -math.cos(_ISO_ELEVATION) * math.cos(_ISO_AZIMUTH),
    math.sin(_ISO_ELEVATION),
)
_ISO_FORWARD = (-_ISO_CAM_DIR[0], -_ISO_CAM_DIR[1], -_ISO_CAM_DIR[2])
_ISO_RIGHT = _normalize(_cross(_ISO_FORWARD, (0.0, 0.0, 1.0)))
_ISO_UP = _normalize(_cross(_ISO_RIGHT, _ISO_FORWARD))

# Iluminacion IDENTICA a PrintRenderScene.tsx (mismos angulos/intensidades),
# para que el render 2D se vea igual que el 3D real en vez de una
# aproximacion propia. Ambas luces direccionales son alli HIJAS de la
# camara -- su posicion mundial es un offset LOCAL (ejes _ISO_RIGHT/_ISO_UP/
# -_ISO_FORWARD) sumado a la posicion de la camara, que a su vez ya esta
# desplazada del centro por `dist` a lo largo de -_ISO_FORWARD. Como solo
# importa la DIRECCION (luces direccionales), ese `dist` comun se cancela al
# normalizar -- ver el desarrollo completo en el comentario de cada luz.
_AMBIENT_INTENSITY = 0.22

# Key light: azimut/elevacion LOCAL 110°/58° respecto a la camara (mismos
# valores que keyLight en PrintRenderScene.tsx). Direccion (superficie ->
# luz) = normalize(right*cos(el)*sin(az) + up*sin(el) - forward*(1+cos(el)*
# cos(az))) -- el termino "+1" viene de que el propio target de la luz
# (worldCenter) ya esta a `dist` de la camara a lo largo de -forward, un
# offset que se suma al de la luz al restar posiciones.
_KEY_AZIMUTH = math.radians(110)
_KEY_ELEVATION = math.radians(58)
_KEY_INTENSITY = 1.35
_KEY_LIGHT_DIR = _normalize((
    _ISO_RIGHT[0] * math.cos(_KEY_ELEVATION) * math.sin(_KEY_AZIMUTH)
    + _ISO_UP[0] * math.sin(_KEY_ELEVATION)
    - _ISO_FORWARD[0] * (1 + math.cos(_KEY_ELEVATION) * math.cos(_KEY_AZIMUTH)),
    _ISO_RIGHT[1] * math.cos(_KEY_ELEVATION) * math.sin(_KEY_AZIMUTH)
    + _ISO_UP[1] * math.sin(_KEY_ELEVATION)
    - _ISO_FORWARD[1] * (1 + math.cos(_KEY_ELEVATION) * math.cos(_KEY_AZIMUTH)),
    _ISO_RIGHT[2] * math.cos(_KEY_ELEVATION) * math.sin(_KEY_AZIMUTH)
    + _ISO_UP[2] * math.sin(_KEY_ELEVATION)
    - _ISO_FORWARD[2] * (1 + math.cos(_KEY_ELEVATION) * math.cos(_KEY_AZIMUTH)),
))

# Fill light: pegada del todo a la direccion de vision (posicion local
# (0,0,0), target local (0,0,-1)) -- su direccion es simplemente -forward
# (relleno "desde el propio ojo de la camara").
_FILL_INTENSITY = 0.22
_FILL_LIGHT_DIR = (-_ISO_FORWARD[0], -_ISO_FORWARD[1], -_ISO_FORWARD[2])


def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(c: float) -> float:
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


# Pasos discretos del factor de luz (en vez de un valor casi-continuo por
# quad): con una pieza curva o con muchas paredes de orientacion parecida,
# esto hace que muchos quads compartan el mismo color EXACTO, lo que permite
# fusionarlos en _build_view en un unico <path> en vez de uno por quad --
# una bandeja con muchos objetos pequeños (p.ej. una bandeja AMS de 10
# piezas) podia generar mas de 17000 <path> individuales, suficiente para
# notarse en la fluidez del navegador. 32 pasos es imperceptible (el
# sombreado ya es plano por quad, no un degradado suave) pero reduce
# drasticamente cuantos colores EXACTOS distintos aparecen.
_SHADE_QUANT_STEPS = 32


def _lambert_shade(hex_color: str, normal: tuple) -> str:
    """Mismo calculo que MeshLambertMaterial en PrintRenderScene.tsx:
    ambiente + difuso de key+fill light segun la normal, en espacio de color
    LINEAL (como hace Three.js internamente con la gestion de color activada
    por defecto) y reconvertido a sRGB al final -- sin este paso de gamma el
    resultado sale sistematicamente mas plano que el 3D real."""
    n = _normalize(normal)
    key = max(0.0, n[0] * _KEY_LIGHT_DIR[0] + n[1] * _KEY_LIGHT_DIR[1] + n[2] * _KEY_LIGHT_DIR[2])
    fill = max(0.0, n[0] * _FILL_LIGHT_DIR[0] + n[1] * _FILL_LIGHT_DIR[1] + n[2] * _FILL_LIGHT_DIR[2])
    factor = _AMBIENT_INTENSITY + key * _KEY_INTENSITY + fill * _FILL_INTENSITY
    factor = round(factor * _SHADE_QUANT_STEPS) / _SHADE_QUANT_STEPS
    try:
        n_int = int(hex_color, 16)
    except ValueError:
        return f"#{hex_color}"
    out = []
    for shift in (16, 8, 0):
        c = ((n_int >> shift) & 0xFF) / 255.0
        lin = _srgb_to_linear(c) * factor
        out.append(max(0, min(255, round(_linear_to_srgb(lin) * 255))))
    return f"{out[0]:02x}{out[1]:02x}{out[2]:02x}"


# Cuantos puntos como mucho por ISLA se usan para generar quads de pared
# sombreados en la vista isometrica (aparte del tope de capas por bucket,
# MAX_LOOPS_PER_BUCKET): sin este segundo recorte, una capa muy detallada
# multiplicaria igual el numero de quads. Este es el techo cuando hay pocas
# islas por capa conservada; ver MAX_QUADS_PER_BUCKET para el caso de
# muchas islas simultaneas (p.ej. varias decoraciones sueltas por capa).
#
# Estos tres valores (aqui y los dos de abajo) subieron bastante respecto a
# los originales (48/1400/6): con piezas de MUCHAS islas simultaneas por
# bucket (p.ej. texto -- cada letra/trazo es su propia isla, decenas por
# capa), el reparto del presupuesto entre islas dejaba apenas 6-8 puntos por
# isla, demasiado pocos para una curva reconocible (letras ilegibles,
# aspecto de maraña). Ahora que los quads se fusionan por color tras
# generarse (ver el fusionado en _build_view), el numero de elementos SVG
# finales ya NO depende de cuantos quads se generen aqui -- se puede pedir
# mucha mas resolucion sin que la vista vuelva a pesar en el navegador.
# Verificado con Toti_10cm.gcode (el fichero mas pesado de la biblioteca,
# 200MB): sin cambio de tiempo medible (~22s en ambos casos), porque el
# coste dominante es parsear el gcode, no generar/fusionar estos quads.
ISO_MAX_POINTS_PER_LOOP = 72
# Presupuesto total de quads por bucket: acotar solo el numero de CAPAS
# (MAX_LOOPS_PER_BUCKET) no basta cuando una capa tiene muchas islas
# simultaneas (ver _group_layers) -- el numero de quads se multiplicaria
# igual por la cantidad de islas. Se reparte este presupuesto entre las
# islas realmente presentes en las capas conservadas: cuantas mas islas por
# capa, menos puntos por isla (nunca por debajo de ISO_MIN_POINTS_PER_LOOP,
# para que ninguna quede irreconocible), asi el peor caso queda acotado sea
# cual sea la complejidad de la pieza.
MAX_QUADS_PER_BUCKET = 6000
ISO_MIN_POINTS_PER_LOOP = 16


def _project(mode: str, x: float, y: float, z: float) -> tuple:
    """(x,y,z) gcode -> (sx,sy) SVG (Y ya invertido: mas "arriba" en el
    mundo = menor Y en pantalla, sin necesidad de transform en el <g>)."""
    if mode == "top":
        return x, -y
    sx = x * _ISO_RIGHT[0] + y * _ISO_RIGHT[1] + z * _ISO_RIGHT[2]
    sy = x * _ISO_UP[0] + y * _ISO_UP[1] + z * _ISO_UP[2]
    return sx, -sy


def _iso_depth(x: float, y: float, z: float) -> float:
    """Distancia (relativa, no absoluta) a lo largo del eje de vision de la
    camara isometrica: mayor valor = mas lejos de la camara. Se usa para
    ordenar los quads de la vista iso como un pintor (de atras hacia
    adelante) antes de mandarlos -- ver _build_view."""
    return x * _ISO_FORWARD[0] + y * _ISO_FORWARD[1] + z * _ISO_FORWARD[2]


def _decimate_points(points: list, max_count: int) -> list:
    """Muestreo uniforme de una lista de puntos (capa) a lo sumo max_count."""
    n = len(points)
    if n <= max_count:
        return points
    step = n / max_count
    seen = set()
    out = []
    for i in range(max_count):
        idx = int(i * step) % n
        if idx not in seen:
            seen.add(idx)
            out.append(points[idx])
    return out


def _group_layers(loops: list) -> list:
    """Agrupa loops consecutivos que comparten la misma Z real (una misma
    "capa" puede tener VARIAS islas independientes -- orejas, lazos, cuerdas
    decorativas sueltas, etc, cada una su propio loop cerrado) en una unica
    entrada de capa. Imprescindible para el downsampling de mas abajo: si se
    recortara por loop suelto sin agrupar, el muestreo por indice podia
    quedarse SOLO con la loop de una decoracion suelta de una capa entera
    (descartando la del cuerpo principal de esa misma capa), y al extruir
    esa unica loop hasta la capa conservada anterior con SU forma, el cuerpo
    principal se quedaba sin rellenar en todo ese tramo -- un hueco real,
    no solo perdida de detalle (verificado: Toti_10cm.gcode tiene capas con
    hasta 37 islas simultaneas en el mismo bucket)."""
    layers = []
    cur = None
    for loop, lh in loops:
        z = loop[2]
        if cur is not None and cur["z"] == z:
            cur["loops"].append(loop)
        else:
            cur = {"z": z, "lh": lh, "loops": [loop]}
            layers.append(cur)
    return layers


def _downsample_layers(layers: list) -> list:
    """Muestreo uniforme a lo sumo MAX_LOOPS_PER_BUCKET capas (cada una con
    TODAS sus islas intactas -- ver _group_layers), siempre incluyendo la
    primera y la ultima (base y remate de la pieza)."""
    n = len(layers)
    if n <= MAX_LOOPS_PER_BUCKET:
        return layers
    if MAX_LOOPS_PER_BUCKET <= 1:
        return [layers[0]]
    step = (n - 1) / (MAX_LOOPS_PER_BUCKET - 1)
    seen = set()
    out = []
    for i in range(MAX_LOOPS_PER_BUCKET):
        idx = round(i * step)
        if idx not in seen:
            seen.add(idx)
            out.append(layers[idx])
    return out


# Distancia maxima de centroide entre capas Z consecutivas para considerar
# que un loop es "la misma isla" que otro de la capa anterior -- ver
# _extract_top_caps. Bajado de 3.0 a 1.0: con piezas de detalle pequeño y
# denso (texto en relieve, donde cada letra es su propia isla y pueden estar
# a menos de 3mm una de otra) 3.0mm confundia letras/trazos DISTINTOS como
# si fueran la misma isla de una capa a la siguiente, generando tapas mal
# formadas que tapaban el propio detalle de las paredes (comprobado con
# Teclas_plate: con 3.0 el texto salia irreconocible, con 1.0 se distinguen
# la mayoria de las letras). Se comprobo tambien contra Toti_10cm.gcode (el
# caso que motivo el 3.0 original, con decoraciones grandes tipo cuerda) sin
# regresion visible ni de tiempo.
_ISLAND_MATCH_TOLERANCE = 1.0


def _extract_top_caps(layers: list) -> list:
    """Para cada isla (region que persiste a lo largo de varias capas Z --
    p.ej. el cuerpo principal de una pieza Y, por separado, un saliente o
    boss que sobresale por encima), se queda con su loop de la Z MAS ALTA en
    la que aparece esa isla concreta. Se usa para la tapa superior de la
    vista isometrica (ver _build_view): si dos islas de la misma pieza
    alcanzan alturas distintas, la Z global mas alta del bucket solo
    pertenece a UNA de ellas -- usar solo esa capa como tapa dejaria sin
    tapar (con aspecto hueco) a las demas islas mas bajas.

    Opera sobre TODAS las capas reales (antes del recorte de
    _downsample_layers a MAX_LOOPS_PER_BUCKET): la tapa necesita saber donde
    esta el tope REAL de cada isla, no solo el de las pocas capas
    conservadas para las paredes.

    Las islas se identifican por proximidad de centroide entre capas
    consecutivas (aproximacion deliberada, igual de pragmatica que el resto
    del modulo: sin llevar un identificador de isla real desde el gcode, es
    la señal mas simple que distingue "la misma protuberancia subiendo capa
    a capa" de "una isla nueva que aparece a esta Z"). Solo se compara cada
    loop contra las islas VIVAS de la capa INMEDIATAMENTE anterior (no
    contra todo el historial acumulado): con decoraciones que se desplazan
    rapido de una capa a otra (p.ej. una cuerda en espiral, que nunca
    encuentra pareja y genera una isla "nueva" en cada capa), acumular sin
    limite dejaba miles de islas activas y cada loop nuevo se comparaba
    contra todas ellas -- cuadratico en el numero de capas, y con ficheros
    de muchas capas (Toti_10cm.gcode, ~1600) esto duplicaba con creces el
    tiempo de generacion del render. Retirar las islas que no encuentran
    pareja en la capa actual (su ultimo loop visto pasa a formar parte del
    resultado, es su tope real) acota el trabajo por capa al numero de
    islas SIMULTANEAS en esa capa (unas pocas), no al total historico."""
    active: list = []
    caps: list = []
    for layer in layers:
        matched = [False] * len(active)
        next_active = []
        for loop in layer["loops"]:
            n = len(loop) // STRIDE_2D
            if n == 0:
                continue
            cx = sum(loop[i * STRIDE_2D] for i in range(n)) / n
            cy = sum(loop[i * STRIDE_2D + 1] for i in range(n)) / n
            best_idx = None
            best_dist = _ISLAND_MATCH_TOLERANCE
            for idx, isl in enumerate(active):
                if matched[idx]:
                    continue
                d = math.hypot(isl["cx"] - cx, isl["cy"] - cy)
                if d < best_dist:
                    best_idx = idx
                    best_dist = d
            if best_idx is not None:
                matched[best_idx] = True
            next_active.append({"cx": cx, "cy": cy, "loop": loop})
        for idx, isl in enumerate(active):
            if not matched[idx]:
                caps.append(isl["loop"])
        active = next_active
    caps.extend(isl["loop"] for isl in active)
    return caps


def _build_view(mode: str, flat_buckets: dict, tool_colors: dict, bed_w: float, bed_h: float) -> dict:
    """Construye, para un modo ("top"/"iso"), el `d` de cada <path> SVG y
    los limites totales proyectados (para el viewBox del cliente) -- todo
    ya resuelto aqui, el navegador solo inyecta los strings.

    "top": un unico <path> por bucket (silueta plana, todos los loops
    superpuestos con el mismo color -- ver docstring del modulo).

    "iso": ADEMAS del contorno de arriba (que se manda igual, para el
    trazo de glow del hover), se generan pequeños quads de pared por
    SEGMENTO, cada uno sombreado con el MISMO Lambert (ambiente+key+fill,
    ver _lambert_shade) que usa PrintRenderScene.tsx segun la normal
    horizontal real del segmento -- es lo que revela relieve real
    (protuberancias, curvas) en vez de un degradado uniforme por toda
    la silueta, que no transmitia profundidad. Ademas, una tapa superior por
    isla (ver _extract_top_caps). Todo el conjunto (paredes + tapas) se
    ordena por profundidad real respecto a la camara antes de devolverlo
    (ver _iso_depth) -- sin esto, la tapa (al generarse la ultima) tapaba
    con su tono plano cualquier pared por debajo, aunque esa pared estuviera
    mas cerca de la camara y debiera verse por encima."""
    min_x = min_y = math.inf
    max_x = max_y = -math.inf
    # Caja delimitadora 2D POR OBJETO (no solo global): permite que el
    # frontend sepa si el desplegable "Saltar objetos" tapa un objeto
    # concreto y cuanto tendria que desplazar el viewBox para despejarlo del
    # todo -- mismo objetivo que objectCorners en PrintRenderScene.tsx, aqui
    # en 2D. Un objeto puede tener varios buckets (uno por color/tool), asi
    # que se acumula entre ellos.
    object_bounds: dict = {}

    def extend(sx, sy, obj_idx=None):
        nonlocal min_x, min_y, max_x, max_y
        if sx < min_x:
            min_x = sx
        if sx > max_x:
            max_x = sx
        if sy < min_y:
            min_y = sy
        if sy > max_y:
            max_y = sy
        if obj_idx is not None:
            ob = object_bounds.get(obj_idx)
            if ob is None:
                object_bounds[obj_idx] = [sx, sy, sx, sy]
            else:
                if sx < ob[0]:
                    ob[0] = sx
                if sy < ob[1]:
                    ob[1] = sy
                if sx > ob[2]:
                    ob[2] = sx
                if sy > ob[3]:
                    ob[3] = sy

    paths = []
    for (obj_idx, tool), bucket in flat_buckets.items():
        layers = bucket["layers"]
        color = _tool_color(tool, tool_colors).lstrip("#")

        outline_parts = []
        for layer in layers:
            for loop in layer["loops"]:
                n = len(loop) // STRIDE_2D
                cmds = []
                for i in range(n):
                    px, py, pz = loop[i * STRIDE_2D], loop[i * STRIDE_2D + 1], loop[i * STRIDE_2D + 2]
                    sx, sy = _project(mode, px, py, pz)
                    extend(sx, sy, obj_idx)
                    cmds.append(f"{'M' if i == 0 else 'L'}{sx:.3f},{sy:.3f}")
                outline_parts.append(" ".join(cmds) + " Z")

        entry = {
            "object_index": obj_idx,
            "tool": tool,
            "color_hex": color,
            "d": " ".join(outline_parts),
        }

        if mode == "iso":
            # El recorte a MAX_LOOPS_PER_BUCKET deja capas conservadas muy
            # separadas en Z (p.ej. cada ~2mm en una pieza de 10cm reducida
            # a 48 capas). Extruir cada quad solo su propio grosor real de
            # capa (lh, tipicamente 0.06-0.2mm) dejaba un HUECO enorme entre
            # una capa conservada y la siguiente -- de ahi el aspecto de
            # "anillos sueltos" en vez de superficie solida. En vez de eso,
            # cada quad se extruye hacia abajo hasta la Z de la capa
            # conservada ANTERIOR (o su propio lh si es la primera), asi
            # que las bandas quedan contiguas sin huecos sea cual sea el
            # muestreo. Ademas, TODAS las islas de una misma capa conservada
            # (ver _group_layers) usan el mismo span -- si solo se extruyera
            # la isla de una decoracion suelta, el cuerpo principal de esa
            # capa se quedaria sin rellenar en todo el tramo.
            total_islands = sum(len(layer["loops"]) for layer in layers) or 1
            points_per_loop = max(
                ISO_MIN_POINTS_PER_LOOP, min(ISO_MAX_POINTS_PER_LOOP, MAX_QUADS_PER_BUCKET // total_islands)
            )
            # (profundidad, quad): profundidad = punto representativo del
            # quad proyectado sobre _ISO_FORWARD (mismo eje de vision que la
            # camara). Un SVG no tiene z-buffer real -- sin ordenar por
            # profundidad y pintar de atras hacia adelante (algoritmo del
            # pintor), lo ultimo en la lista siempre "gana" sin importar si
            # esta realmente mas cerca de la camara. Esto importa sobre todo
            # para la tapa superior (ver mas abajo): antes se pintaba
            # siempre la ultima sin mas, y su relleno plano tapaba CUALQUIER
            # pared por debajo cuyo rectangulo proyectado cayera en la misma
            # zona de pantalla (la proyeccion hace que la Z no mueva la
            # posicion horizontal, asi que el hueco de pantalla de la tapa y
            # el de muchas paredes se solapan) -- se veia "sin sombras",
            # como si se hubiera aplanado toda la pieza con un tinte unico.
            # Ordenando por profundidad de verdad, una pared mas cercana a
            # la camara que la tapa se pinta ENCIMA de ella (se ve su
            # sombreado real), y la tapa solo tapa lo que de verdad queda
            # detras/debajo suyo.
            depth_quads: list = []
            prev_z = None
            for layer in layers:
                layer_z = layer["z"]
                lh = layer["lh"]
                span = max(layer_z - prev_z, lh) if prev_z is not None else lh
                prev_z = layer_z
                for loop in layer["loops"]:
                    n = len(loop) // STRIDE_2D
                    if n == 0:
                        continue
                    pts = [(loop[i * STRIDE_2D], loop[i * STRIDE_2D + 1], loop[i * STRIDE_2D + 2]) for i in range(n)]
                    pts = _decimate_points(pts, points_per_loop)
                    pn = len(pts)
                    for i in range(pn):
                        x1, y1, z1 = pts[i]
                        x2, y2, z2 = pts[(i + 1) % pn]
                        dx, dy = x2 - x1, y2 - y1
                        seg_len = math.hypot(dx, dy)
                        if seg_len < 1e-6:
                            continue
                        nrm_x, nrm_y = -dy / seg_len, dx / seg_len
                        quad_color = _lambert_shade(color, (nrm_x, nrm_y, 0.0))
                        top1, bot1 = _project(mode, x1, y1, z1), _project(mode, x1, y1, z1 - span)
                        top2, bot2 = _project(mode, x2, y2, z2), _project(mode, x2, y2, z2 - span)
                        for sx, sy in (top1, bot1, top2, bot2):
                            extend(sx, sy, obj_idx)
                        d = (
                            f"M{top1[0]:.3f},{top1[1]:.3f} L{bot1[0]:.3f},{bot1[1]:.3f} "
                            f"L{bot2[0]:.3f},{bot2[1]:.3f} L{top2[0]:.3f},{top2[1]:.3f} Z"
                        )
                        mid = (
                            (x1 + x2) / 2,
                            (y1 + y2) / 2,
                            (z1 + z2) / 2 - span / 2,
                        )
                        depth = _iso_depth(*mid)
                        depth_quads.append((depth, {"d": d, "color_hex": quad_color}))

            # Tapa superior, pintada AL FINAL (encima de todos los quads de
            # pared, no antes): los quads de pared solo cubren el LATERAL de
            # la pieza -- sin tapa, la cara de arriba queda invisible del
            # todo. En piezas altas y estrechas apenas se nota, pero en
            # piezas anchas y planas (p.ej. un disco) es la MAYOR PARTE de
            # la superficie visible: sin esto se ve "hueca", como mirando
            # dentro de un tubo abierto en vez de una pieza solida. Tiene
            # que pintarse ENCIMA porque la proyeccion isometrica hace que
            # la Z no mueva la posicion horizontal en pantalla (asi las
            # paredes verticales salen perfectamente verticales) -- un
            # segmento de pared largo (p.ej. el borde recto de una ranura
            # diametral real) proyecta un rectangulo ANCHO en pantalla
            # aunque sea fino en 3D, y si la tapa se pintara antes quedaria
            # tapada por esa franja ancha en vez de mostrarse solida. Se usa
            # el contorno de la Z mas alta de CADA isla por separado (ver
            # _extract_top_caps -- distinto de simplemente "la ultima capa
            # conservada", porque dos islas de la misma pieza pueden
            # alcanzar alturas distintas, p.ej. un saliente sobre una base
            # plana) tal cual -- si una isla tiene forma de "D" por un
            # corte/ranura real, el relleno respeta ese hueco solo con
            # rellenar el poligono cerrado, sin operacion booleana ninguna.
            # No hace falta tapa inferior: la camara isometrica por defecto
            # siempre mira desde arriba, la base nunca es visible.
            for loop in bucket["caps"]:
                n = len(loop) // STRIDE_2D
                if n < 3:
                    continue
                cap_color = _lambert_shade(color, (0.0, 0.0, 1.0))
                cmds = []
                cx = cy = cz = 0.0
                for i in range(n):
                    px, py, pz = loop[i * STRIDE_2D], loop[i * STRIDE_2D + 1], loop[i * STRIDE_2D + 2]
                    cx += px
                    cy += py
                    cz += pz
                    sx, sy = _project(mode, px, py, pz)
                    extend(sx, sy, obj_idx)
                    cmds.append(f"{'M' if i == 0 else 'L'}{sx:.3f},{sy:.3f}")
                depth = _iso_depth(cx / n, cy / n, cz / n)
                depth_quads.append((depth, {"d": " ".join(cmds) + " Z", "color_hex": cap_color}))

            # Fusion por color (sea cual sea la posicion del quad): se
            # probo tambien restringir la fusion a quads ademas cercanos en
            # el espacio (una rejilla 3D), pensando que mezclar fragmentos
            # lejanos en profundidad rompia el orden de pintado -- pero se
            # comprobo (Teclas_plate, texto en relieve que salia irreconocible)
            # que el problema NO era la fusion: con la fusion COMPLETAMENTE
            # desactivada la maraña seguia igual. La causa real era otra (ver
            # _ISLAND_MATCH_TOLERANCE) -- la fusion solo por color es igual de
            # correcta y comprime mucho mejor, asi que se mantiene simple.
            # Cada grupo de color se emite como un unico <path> con muchos
            # subtrazados, situado en la profundidad MEDIA de sus miembros.
            color_groups: dict = {}
            for depth, q in depth_quads:
                grp = color_groups.get(q["color_hex"])
                if grp is None:
                    grp = {"d_parts": [], "depth_sum": 0.0, "count": 0}
                    color_groups[q["color_hex"]] = grp
                grp["d_parts"].append(q["d"])
                grp["depth_sum"] += depth
                grp["count"] += 1

            merged = [
                (grp["depth_sum"] / grp["count"], {"d": " ".join(grp["d_parts"]), "color_hex": color_hex})
                for color_hex, grp in color_groups.items()
            ]
            merged.sort(key=lambda dq: dq[0], reverse=True)
            entry["quads"] = [q for _, q in merged]

        paths.append(entry)

    corners = ((0.0, 0.0, 0.0), (bed_w, 0.0, 0.0), (bed_w, bed_h, 0.0), (0.0, bed_h, 0.0))
    bed_pts = [_project(mode, cx, cy, cz) for cx, cy, cz in corners]
    bed_d = "M " + " L ".join(f"{sx:.3f},{sy:.3f}" for sx, sy in bed_pts) + " Z"

    if not math.isfinite(min_x):
        min_x, min_y, max_x, max_y = 0.0, 0.0, bed_w, bed_h

    return {
        "bounds": {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y},
        "bed_d": bed_d,
        "paths": paths,
        "object_bounds": {
            str(obj_idx): {"minX": ob[0], "minY": ob[1], "maxX": ob[2], "maxY": ob[3]}
            for obj_idx, ob in object_bounds.items()
        },
    }


def _tool_color(tool: int, tool_colors: dict) -> str:
    color = tool_colors.get(tool)
    if color:
        return color
    return DEFAULT_TOOL_PALETTE[tool % len(DEFAULT_TOOL_PALETTE)]


def build_render_buffers(
    data: bytes, tool_colors: dict, bed_w: float, bed_h: float, layer_height: float | None
) -> tuple[bytes, bytes]:
    """Parsea el gcode UNA sola vez y devuelve (buffer_3d, buffer_2d): ambos
    formatos comparten la misma deteccion de pared/objeto/color, asi que
    generarlos en un unico paso evita descargar y parsear el fichero (hasta
    ~200MB) dos veces."""
    # Fallback si el fichero no trajera ";HEIGHT:" por capa (no deberia
    # pasar con OrcaSlicer, pero por si acaso).
    fallback_lh = layer_height if layer_height and layer_height > 0 else DEFAULT_LAYER_HEIGHT
    cur_layer_height = fallback_lh
    text = data.decode("utf-8", "ignore")

    object_index_map = {}
    object_order = []
    cur_type = ""
    cur_tool = 0
    cur_object = -1
    x = None
    y = None
    z = None

    # bucket (object_index, tool) -> array.array de floats de los quads
    # (x,y,z,nx,ny,nz) por vertice.
    buckets: dict = {}

    # bucket (object_index, tool) -> lista de loops cerrados (cada loop es
    # un array.array de floats x,y,z intercalados). flat_open guarda el loop
    # EN CURSO de cada bucket (o None si no hay ninguno abierto todavia) mas
    # la capa (z) y el ultimo punto, para saber cuando cerrar/abrir uno
    # nuevo (ver docstring del modulo).
    flat_buckets: dict = {}
    flat_open: dict = {}

    def _flat_close(key2d):
        st = flat_open.get(key2d)
        if st is not None and st["loop"] is not None and len(st["loop"]) >= 2 * STRIDE_2D:
            flat_buckets.setdefault(key2d, []).append((st["loop"], st["lh"]))
        flat_open[key2d] = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        if line[0] == ";":
            if line.startswith(";TYPE:"):
                cur_type = line[6:].strip()
            elif line.startswith(";HEIGHT:"):
                # OrcaSlicer pone esto justo tras cada ;LAYER_CHANGE: la
                # altura EXACTA de la capa que empieza ahora. Usar este valor
                # en vez de una altura nominal fija es lo que evita huecos o
                # solapes entre capas (con altura de capa variable/adaptativa,
                # una unica altura fija para todo el fichero no cuadra con
                # cada capa real, dejando una "malla" de huecos verticales).
                try:
                    h = float(line[8:].strip())
                    if h > 0:
                        cur_layer_height = h
                except ValueError:
                    pass
            continue

        semi = line.find(";")
        code = line[:semi].strip() if semi >= 0 else line
        if not code:
            continue

        # EXCLUDE_OBJECT_START/END son comandos reales (no comentarios) que
        # emite OrcaSlicer para delimitar que tramos pertenecen a que objeto
        # con nombre, usados por la funcion de "saltar objeto" de KX-Bridge.
        if code.startswith("EXCLUDE_OBJECT_START"):
            name = code.split("NAME=", 1)[1].strip() if "NAME=" in code else ""
            if name:
                if name not in object_index_map:
                    object_index_map[name] = len(object_order)
                    object_order.append(name)
                cur_object = object_index_map[name]
            continue
        if code.startswith("EXCLUDE_OBJECT_END"):
            cur_object = -1
            continue

        if code[0] == "T" and code[1:].isdigit():
            cur_tool = int(code[1:])
            continue

        if not (code == "G0" or code == "G1" or code.startswith("G0 ") or code.startswith("G1 ")):
            continue

        nx, ny, nz, e = x, y, z, None
        for tok in code.split()[1:]:
            c = tok[0]
            if c == "X":
                try:
                    nx = float(tok[1:])
                except ValueError:
                    pass
            elif c == "Y":
                try:
                    ny = float(tok[1:])
                except ValueError:
                    pass
            elif c == "Z":
                try:
                    nz = float(tok[1:])
                except ValueError:
                    pass
            elif c == "E":
                try:
                    e = float(tok[1:])
                except ValueError:
                    pass

        if nx is None or ny is None or nz is None:
            x, y, z = nx, ny, nz
            continue

        is_extrusion = e is not None and e > 0
        type_lower = cur_type.lower()
        is_wall = type_lower in WALL_TYPES
        is_support = type_lower in SUPPORT_TYPES
        is_cap = type_lower in CAP_TYPES

        if is_extrusion and (is_wall or is_support or is_cap) and x is not None and y is not None and z is not None:
            dx = nx - x
            dy = ny - y
            seg_len = math.hypot(dx, dy)
            if seg_len > 1e-6:
                key = (cur_object, cur_tool, is_support)
                arr = buckets.get(key)
                if arr is None:
                    arr = array.array("f")
                    buckets[key] = arr

                if is_wall or is_support:
                    if is_wall:
                        # 2D (vista cenital): solo pared exterior forma ya un
                        # contorno cerrado util. Se continua el loop en curso
                        # de este bucket si el punto de arranque de este
                        # segmento coincide con donde acabo el anterior Y
                        # sigue en la misma capa (z) -- cualquier salto
                        # (objeto/color distinto, capa distinta, o un hueco
                        # de por medio) cierra el loop acumulado y empieza
                        # uno nuevo. Los soportes (is_support) NUNCA pasan
                        # por aqui -- no tienen sentido en el contorno 2D
                        # cenital, solo en 3D.
                        key2d = (cur_object, cur_tool)
                        st2d = flat_open.get(key2d)
                        if st2d is not None and st2d["z"] == z and st2d["last"] == (x, y):
                            st2d["loop"].extend((nx, ny, nz))
                            st2d["last"] = (nx, ny)
                        else:
                            _flat_close(key2d)
                            flat_open[key2d] = {
                                "z": z, "last": (nx, ny), "lh": cur_layer_height,
                                "loop": array.array("f", (x, y, z, nx, ny, nz)),
                            }

                    # Pared vertical: de z-altura_de_capa a z (altura EXACTA
                    # de esta capa, no una nominal fija -- ver ;HEIGHT: mas
                    # arriba), ancho = la longitud del segmento, normal =
                    # perpendicular horizontal a la direccion (revela el
                    # contorno bajo luz).
                    nrm_x = -dy / seg_len
                    nrm_y = dx / seg_len
                    top1 = (x, y, z)
                    top2 = (nx, ny, nz)
                    bot1 = (x, y, z - cur_layer_height)
                    bot2 = (nx, ny, nz - cur_layer_height)
                    for px, py, pz in (top1, bot1, top2, top2, bot1, bot2):
                        arr.extend((px, py, pz, nrm_x, nrm_y, 0.0))
                    # Remate horizontal arriba Y abajo de la pared (misma
                    # tecnica que las tapas, con ancho real): sin esto, una
                    # pared es un plano de grosor cero, invisible visto casi
                    # desde arriba/abajo. El remate de abajo importa tanto
                    # como el de arriba: piezas finas (p.ej. las clavijas de
                    # ensamblaje) no generan una pasada de "Bottom surface"
                    # propia -- toda su seccion es directamente pared -- asi
                    # que sin este remate su base se queda sin tapar del todo.
                    half_w = NOMINAL_LINE_WIDTH / 2
                    rim_px = nrm_x * half_w
                    rim_py = nrm_y * half_w
                    top_bot_z = z - cur_layer_height
                    top_bot_nz = nz - cur_layer_height
                    for rz, rnz in ((z, nz), (top_bot_z, top_bot_nz)):
                        ra = (x + rim_px, y + rim_py, rz)
                        rb = (nx + rim_px, ny + rim_py, rnz)
                        rc = (x - rim_px, y - rim_py, rz)
                        rd = (nx - rim_px, ny - rim_py, rnz)
                        for px, py, pz in (ra, rc, rb, rb, rc, rd):
                            arr.extend((px, py, pz, 0.0, 0.0, 1.0))
                else:
                    # Cinta horizontal con ancho real (no de ancho cero como
                    # una pared): las lineas de relleno adyacentes se solapan
                    # y tapan del todo, en vez de dejar huecos entre "tablones".
                    half_w = NOMINAL_LINE_WIDTH / 2
                    perp_x = (-dy / seg_len) * half_w
                    perp_y = (dx / seg_len) * half_w
                    a = (x + perp_x, y + perp_y, z)
                    b = (nx + perp_x, ny + perp_y, nz)
                    c = (x - perp_x, y - perp_y, z)
                    d = (nx - perp_x, ny - perp_y, nz)
                    for px, py, pz in (a, c, b, b, c, d):
                        arr.extend((px, py, pz, 0.0, 0.0, 1.0))

        x, y, z = nx, ny, nz

    # Cerrar cualquier loop 2D que se haya quedado abierto al llegar al
    # final del fichero (el ultimo segmento de pared de cada bucket).
    for key2d in list(flat_open.keys()):
        _flat_close(key2d)

    bucket_meta = []
    data_parts = []
    byte_offset = 0
    for (obj_idx, tool, bucket_is_support), arr in buckets.items():
        color = _tool_color(tool, tool_colors)
        count = len(arr) // STRIDE
        bucket_meta.append({
            "object_index": obj_idx,
            "tool": tool,
            "color_hex": color.lstrip("#"),
            "count": count,
            "offset": byte_offset,
            "is_support": bucket_is_support,
        })
        raw_bytes = arr.tobytes()
        data_parts.append(raw_bytes)
        byte_offset += len(raw_bytes)

    header = {
        "bed": {"width": bed_w, "height": bed_h},
        "objects": object_order,
        "stride": STRIDE,
        "buckets": bucket_meta,
    }
    header_bytes = json.dumps(header).encode("utf-8")
    # Float32Array exige que su offset dentro del ArrayBuffer sea multiplo de
    # 4; el prefijo de longitud ya son 4 bytes, asi que basta con que el
    # propio header tambien lo sea. Se rellena con espacios (whitespace
    # valido al final de un JSON, JSON.parse lo ignora sin problema).
    pad = (-len(header_bytes)) % 4
    header_bytes += b" " * pad
    buf3d = struct.pack("<I", len(header_bytes)) + header_bytes + b"".join(data_parts)

    for key2d in flat_buckets:
        grouped = _group_layers(flat_buckets[key2d])
        flat_buckets[key2d] = {"layers": _downsample_layers(grouped), "caps": _extract_top_caps(grouped)}

    payload2d = {
        "objects": object_order,
        "views": {
            "top": _build_view("top", flat_buckets, tool_colors, bed_w, bed_h),
            "iso": _build_view("iso", flat_buckets, tool_colors, bed_w, bed_h),
        },
    }
    buf2d = json.dumps(payload2d).encode("utf-8")

    return buf3d, buf2d
