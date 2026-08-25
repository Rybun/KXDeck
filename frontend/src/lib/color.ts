export function hexToRgb(hex: string): [number, number, number] {
  const c = (hex || "").replace("#", "");
  const full = c.length === 3 ? c.split("").map((ch) => ch + ch).join("") : c;
  const n = parseInt(full || "ffffff", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r, g, b, 255];
}

export function colorDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
}
