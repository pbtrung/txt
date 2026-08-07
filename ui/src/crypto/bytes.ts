// Small byte-array helpers shared across the crypto/data layers.

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Decodes a base64 string (e.g. a config file's username_lookup_key/user_root_key). */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Overwrites every byte with 0 in place -- best-effort scrubbing of key
 * material immediately before its last reference is dropped (e.g.
 * VaultContext.tsx's lock()). This reliably clears this specific buffer,
 * but it's not a complete guarantee: it can't reach any other reference to
 * the same bytes held elsewhere (there shouldn't be one, but nothing
 * enforces that), and it says nothing about copies the WASM crypto layer
 * made and already freed unzeroed on its own side. */
export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}
