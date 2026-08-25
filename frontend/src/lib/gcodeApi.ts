export const BED = { width: 260, depth: 260 };

export async function fetchLayerText(
  filename: string,
  start: number,
  end: number | null,
  signal?: AbortSignal,
): Promise<string> {
  const range = end !== null ? `bytes=${start}-${end - 1}` : `bytes=${start}-`;
  const res = await fetch(`/downloads/files/local/${encodeURIComponent(filename)}`, { headers: { Range: range }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
