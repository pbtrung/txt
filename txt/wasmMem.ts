// Thin buffer-marshaling helper around an Emscripten WASM Module, shared by
// anything that needs to pass byte buffers across the WASM boundary.
export class WasmMem {
  private module: any;

  constructor(module: any) {
    this.module = module;
  }

  private alloc(buf: Uint8Array): number {
    const ptr = this.module._malloc(buf.length || 1);
    this.module.HEAPU8.set(buf, ptr); // re-reads HEAPU8 fresh each call -- safe across mallocs
    return ptr;
  }

  private allocOut(len: number): number {
    return this.module._malloc(len || 1);
  }

  read(ptr: number, len: number): Buffer {
    return Buffer.from(this.module.HEAPU8.subarray(ptr, ptr + len));
  }

  private free(ptrs: number[]): void {
    for (const p of ptrs) this.module._free(p);
  }

  // Allocates one WASM pointer per entry in `inputs` (copying each buffer
  // in) and per entry in `outLens` (an empty output buffer of that length),
  // hands the named pointer map to `fn`, and frees everything afterwards --
  // regardless of whether `fn` throws.
  withBuffers<T>(
    inputs: Record<string, Uint8Array>,
    outLens: Record<string, number>,
    fn: (ptrs: Record<string, number>) => T,
  ): T {
    const ptrs: Record<string, number> = {};
    for (const [k, v] of Object.entries(inputs)) ptrs[k] = this.alloc(v);
    for (const [k, len] of Object.entries(outLens))
      ptrs[k] = this.allocOut(len);
    try {
      return fn(ptrs);
    } finally {
      this.free(Object.values(ptrs));
    }
  }
}
