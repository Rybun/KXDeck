export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  travel: boolean;
  type: string;
  tool: number;
  // Nombre del objeto con nombre (OrcaSlicer EXCLUDE_OBJECT_START/END, ver
  // mas abajo) al que pertenece este segmento, o null si esta fuera de
  // cualquier bloque de objeto (purga, prime tower...). Mismo dato que
  // gcode_render.py usa para "object_index" en el render 3D/2D, aqui como
  // nombre directo ya que el frontend siempre trabaja con nombres.
  objectName: string | null;
}

export interface ParseState {
  type: string;
  tool: number;
  objectName: string | null;
}

export interface ParseResult {
  segments: Segment[];
  endState: ParseState;
}

const MOVE_RE = /^(G0|G1)\s/;
const PARAM_RE = /([XYE])(-?[\d.]+)/g;

/** Parsea el gcode de una capa (texto plano) en segmentos 2D coloreables.
 * No interpreta el gcode completo (sin G2/G3, sin modos relativos de XY):
 * solo lo necesario para dibujar el trazado de una capa, igual que el resto
 * del proyecto prefiere aproximaciones simples y explicitas a un interprete
 * completo de gcode. */
export function parseLayerGcode(text: string, start: ParseState): ParseResult {
  let type = start.type;
  let tool = start.tool;
  let objectName = start.objectName;
  let x: number | null = null;
  let y: number | null = null;
  const segments: Segment[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.charCodeAt(0) === 59 /* ; */) {
      if (line.startsWith(";TYPE:")) type = line.slice(6).trim();
      continue;
    }

    const semi = line.indexOf(";");
    const code = semi >= 0 ? line.slice(0, semi).trim() : line;
    if (!code) continue;

    if (code[0] === "T" && /^T\d+$/.test(code)) {
      tool = parseInt(code.slice(1), 10) || 0;
      continue;
    }

    // EXCLUDE_OBJECT_START/END son comandos reales (no comentarios) que
    // emite OrcaSlicer para delimitar los tramos de cada objeto con nombre
    // -- mismo marcador que backend/gcode_render.py usa para "object_index".
    if (code.startsWith("EXCLUDE_OBJECT_START")) {
      const idx = code.indexOf("NAME=");
      objectName = idx >= 0 ? code.slice(idx + 5).trim() : null;
      continue;
    }
    if (code.startsWith("EXCLUDE_OBJECT_END")) {
      objectName = null;
      continue;
    }

    if (!MOVE_RE.test(code)) continue;

    let nx: number | null = x;
    let ny: number | null = y;
    let e: number | undefined;
    PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PARAM_RE.exec(code))) {
      const v = parseFloat(m[2]);
      if (Number.isNaN(v)) continue;
      if (m[1] === "X") nx = v;
      else if (m[1] === "Y") ny = v;
      else if (m[1] === "E") e = v;
    }

    if (nx === null || ny === null) continue;
    if (x !== null && y !== null) {
      segments.push({ x1: x, y1: y, x2: nx, y2: ny, travel: !(e !== undefined && e > 0), type, tool, objectName });
    }
    x = nx;
    y = ny;
  }

  return { segments, endState: { type, tool, objectName } };
}
