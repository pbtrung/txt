function pushLine(out: string[], line: string): void {
  const blank = line.trim() === "";
  if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  if (!blank) out.push(line);
}

export function preprocessText(content: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8").decode(content);
  const trimmed = text.replace(/\r\n$|\r$|\n$/, "");
  const lines = trimmed.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of lines) pushLine(out, line);
  return new TextEncoder().encode(out.join("\n"));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function accumulatePart(
  parts: Uint8Array[],
  cur: Uint8Array,
  para: string,
  target: number
): Uint8Array {
  const chunk = new TextEncoder().encode(para + "\n\n");
  if (cur.length > 0 && cur.length + chunk.length > target) {
    parts.push(cur);
    return chunk;
  }
  return concatBytes(cur, chunk);
}

export function splitParts(content: Uint8Array, target: number): Uint8Array[] {
  const text = new TextDecoder("utf-8").decode(content);
  const paras = text.split(/\r?\n\r?\n/);
  const parts: Uint8Array[] = [];
  let cur: Uint8Array = new Uint8Array(0);
  for (const p of paras) cur = accumulatePart(parts, cur, p, target);
  if (cur.length > 0) parts.push(cur);
  return parts;
}
