import { hexToRgb } from "../lib/color";

function circlePath(cx: number, cy: number, r: number): string {
  return `M ${cx - r},${cy} A ${r},${r} 0 1,0 ${cx + r},${cy} A ${r},${r} 0 1,0 ${cx - r},${cy} Z`;
}

const SPOKE_ANGLES_DEG = [-90, 30, 150];

/** Luminancia relativa WCAG (con la correccion gamma de sRGB por canal):
 * un rojo saturado como rgb(244,0,49) sale muy "oscuro" con una media
 * ponderada simple (por el canal G=0), aunque un borde negro se vea de
 * sobra sobre el. Comparando el contraste real contra negro y blanco (en
 * vez de un umbral de luminancia fijo) da el resultado correcto. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastStroke(hex: string): string {
  const l = relativeLuminance(hex);
  const contrastWithBlack = (l + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (l + 0.05);
  return contrastWithBlack >= contrastWithWhite ? "#111827" : "#ffffff";
}

/** Bobina de filamento vista de frente: aro de color con borde exterior
 * negro, agujero interior con su propio contorno, 3 radios finos uniendo
 * ambos contornos, y un hilo de filamento colgando por la izquierda.
 *
 * active=true (slot realmente alimentando la impresion en curso): la rueda
 * gira en sentido antihorario y el hilo colgante serpentea, via las
 * animaciones CSS spool-spin/spool-sway (definidas en index.css).
 *
 * empty=true (ningun slot cargado del material que hace falta, ver
 * PrintConfigPanel): aro hueco de trazo discontinuo en vez de relleno de
 * color -- distingue de un vistazo "sin asignar" de "asignado mal", que con
 * un simple gris solido se podian confundir. */
export function Spool({
  color,
  size = 32,
  active = false,
  empty = false,
}: {
  color: string;
  size?: number;
  active?: boolean;
  empty?: boolean;
}) {
  const w = size;
  const h = size * 1.4;
  const cx = w / 2;
  const cy = w / 2;
  const outerR = w * 0.42;
  const innerR = w * 0.16;

  const donutPath = `${circlePath(cx, cy, outerR)} ${circlePath(cx, cy, innerR)}`;

  const spokes = SPOKE_ANGLES_DEG.map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return {
      x1: cx + innerR * Math.cos(rad),
      y1: cy + innerR * Math.sin(rad),
      x2: cx + outerR * Math.cos(rad),
      y2: cy + outerR * Math.sin(rad),
    };
  });

  // 145 grados (sentido horario desde la derecha, como el resto de angulos de
  // este componente) cae abajo-a-la-izquierda. 200 grados caia arriba-a-la-
  // izquierda por error, por eso el hilo se salia por encima del borde.
  const tailRad = (145 * Math.PI) / 180;
  const tx = cx + outerR * Math.cos(tailRad);
  const ty = cy + outerR * Math.sin(tailRad);
  const tailEx = tx - w * 0.01;
  const tailEy = ty + h * 0.17;
  const tailPath = `M ${tx},${ty} C ${tx - w * 0.03},${ty + h * 0.06} ${tx + w * 0.04},${ty + h * 0.11} ${tailEx},${tailEy}`;
  const tailStrokeWidth = Math.max(1.5, w * 0.055);

  if (empty) {
    // Misma estructura que la bobina normal (aro exterior, agujero interior,
    // 3 radios) pero solo el contorno, sin relleno de color -- antes era un
    // unico anillo discontinuo que no se parecia en nada a una bobina.
    const emptyStroke = "#9ca3af";
    const emptyWidth = Math.max(1, w * 0.045);
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible">
        <circle cx={cx} cy={cy} r={outerR} fill="none" stroke={emptyStroke} strokeWidth={emptyWidth} strokeDasharray="3 3" />
        <circle cx={cx} cy={cy} r={innerR} fill="none" stroke={emptyStroke} strokeWidth={emptyWidth} strokeDasharray="3 3" />
        {spokes.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={emptyStroke}
            strokeWidth={Math.max(1, w * 0.035)}
            strokeLinecap="round"
            strokeDasharray="3 3"
          />
        ))}
      </svg>
    );
  }

  const stroke = contrastStroke(color);

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible">
      {/* La "barriga" (la curva que se abomba a un lado) se desplaza de
       * izquierda a derecha y vuelta -- no por CSS (la forma exacta depende
       * de tx/ty/w/h, distintos en cada instancia segun "size"), sino en JS
       * (ver animateThreadBelly en widgets/entry.tsx), leyendo estos
       * data-* como los unicos numeros que hacen falta para recalcular la
       * curva en cada frame. Sin active, se queda con su forma fija de
       * siempre (sin data-*, sin que el JS la toque). */}
      <path
        d={tailPath}
        fill="none"
        stroke={color}
        strokeWidth={tailStrokeWidth}
        strokeLinecap="round"
        className={active ? "spool-thread" : undefined}
        data-tx={active ? tx : undefined}
        data-ty={active ? ty : undefined}
        data-ex={active ? tailEx : undefined}
        data-ey={active ? tailEy : undefined}
        data-w={active ? w : undefined}
        data-h={active ? h : undefined}
      />
      <g
        className={active ? "spool-wheel" : undefined}
        style={active ? { animation: "spool-spin 32s linear infinite", transformOrigin: `${cx}px ${cy}px` } : undefined}
      >
        <path d={donutPath} fill={color} fillRule="evenodd" stroke={stroke} strokeWidth={Math.max(1, w * 0.045)} />
        <circle cx={cx} cy={cy} r={innerR} fill="none" stroke={stroke} strokeWidth={Math.max(1, w * 0.045)} />
        {spokes.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke={stroke}
            strokeWidth={Math.max(1, w * 0.035)}
            strokeLinecap="round"
          />
        ))}
      </g>
    </svg>
  );
}
