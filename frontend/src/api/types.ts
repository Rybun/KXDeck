export interface StateFlags {
  operational: boolean;
  paused: boolean;
  printing: boolean;
  pausing: boolean;
  cancelling: boolean;
  sdReady: boolean;
  error: boolean;
  ready: boolean;
  closedOrError: boolean;
}

export interface AceDrying {
  status: number;
  target_temp: number;
  duration: number;
  remain_time: number;
  humidity: number | null;
  current_temp: number | null;
}

export interface KxRawState {
  printer_name: string;
  firmware_version: string;
  print_state: string;
  kobra_state: string;
  nozzle_temp: number;
  nozzle_target: number;
  bed_temp: number;
  bed_target: number;
  progress: number;
  print_duration: number;
  remain_time: number;
  curr_layer: number;
  total_layers: number;
  z_mm: number;
  filename: string;
  slicer_time: number;
  camera_url: string;
  fan_speed: number;
  light_on: boolean;
  light_brightness: number;
  ace_drying?: AceDrying;
  connection_error?: string;
  nozzle_history?: number[];
  bed_history?: number[];
  [key: string]: unknown;
}

export interface KxDeckState extends KxRawState {
  state: { text: string; flags: StateFlags };
}

export interface JobFile {
  id: string | null;
  name: string | null;
  path: string | null;
  display: string | null;
  origin: string | null;
  size: number | null;
  date: number | null;
}

export interface JobPayload {
  file: JobFile;
  estimatedPrintTime: number | null;
  filament: { tool0: { length: number; volume: number } } | null;
  user: string | null;
}

export interface JobProgress {
  completion: number | null;
  filepos: number | null;
  printTime: number | null;
  printTimeLeft: number | null;
  printTimeLeftOrigin: string | null;
}

export interface SkipState {
  objects: string[];
  skipped: string[];
  svg_b64: string;
  ts: number;
  filename: string;
}

export interface HaLightState {
  id: string;
  label: string;
  on: boolean | null;
}

export interface KxDeckWsMessage {
  state: { text: string; flags: StateFlags };
  kx: KxRawState;
  job: JobPayload;
  progress: JobProgress;
  skip: SkipState | null;
  ha_lights: HaLightState[];
  // Capas (0-based) con una pausa EMBEBIDA en el propio gcode (M600/M601,
  // ver KxFiles.layer_pause_points en kx_client.py) -- distintas de las
  // pausas programadas por KXDeck (PauseScheduleEntry, mas abajo). []
  // mientras el indexado de capas del fichero en curso no ha terminado
  // todavia, o si de verdad no trae ninguna.
  gcode_pause_layers: number[];
}

export interface FileObjectsInfo {
  names: string[];
  svg_b64: string;
}

export interface PauseScheduleEntry {
  id: number;
  kind: "layer" | "time";
  // Capa objetivo si kind es "layer"; segundos transcurridos si es "time".
  value: number;
  triggered: boolean;
}


export interface FilamentSlot {
  slot_index: number;
  material: string;
  color_hex: string;
  status: string;
  filament_id: string;
  filament_vendor: string;
  filament_name: string;
}

export interface FilamentProfile {
  id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

export interface KxFileEntry {
  id: string;
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  date: number;
  thumbnail_b64: string | null;
  est_print_time_sec: number;
  filament_used_mm: number;
  layer_count: number;
  filament_colors: string[];
  filament_materials: string[];
  gcode_filaments: string | null;
  last_print_status: string | null;
  last_print_duration: number | null;
  last_print_at: string | null;
  prints: { success: number; failure: number };
}

/** Una entrada de gcode_filaments (JSON string en KxFileEntry): un "paint"
 * del slicer (color/material), no un slot fisico del AMS/ACE. */
export interface FilamentChannel {
  slot_index: number;
  color_hex: string;
  material: string;
  is_used?: boolean;
}

export interface FilamentAssignment {
  paint_index: number;
  is_used: boolean;
  slot_index: number;
  material: string;
  paint_color: [number, number, number, number];
  ams_color: [number, number, number, number];
}

export interface HistoryJob {
  name: string;
  path: string;
  origin: string;
  startTime: number;
  endTime: number;
  printTime: number;
  success: boolean;
  status: string;
}

export interface LayerIndex {
  filename: string;
  size: number;
  count: number;
  offsets: number[];
  // Herramienta activa al INICIO de cada capa (mismo indice que offsets),
  // ver GcodeViewerCore.tsx -- sin esto, saltar a cualquier capa que no sea
  // la 0 arrancaba el parseo asumiendo siempre herramienta 0.
  start_tools: number[];
}
