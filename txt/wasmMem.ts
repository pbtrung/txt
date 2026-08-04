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
  // regardless of whether `fn` throws. Generic over the exact key sets of
  // `inputs`/`outLens` (rather than a plain `Record<string, number>`) so
  // `fn`'s own `ptrs` parameter has real, individually-typed properties --
  // under this project's `noUncheckedIndexedAccess`, a generic index
  // signature would make every `ptrs.foo` access `number | undefined`
  // instead of `number`, even though the caller already knows exactly which
  // keys it passed in.
  withBuffers<
    TIn extends Record<string, Uint8Array>,
    TOut extends Record<string, number>,
    T,
  >(
    inputs: TIn,
    outLens: TOut,
    fn: (ptrs: { [K in keyof TIn | keyof TOut]: number }) => T,
  ): T {
    const ptrs = {} as { [K in keyof TIn | keyof TOut]: number };
    for (const [k, v] of Object.entries(inputs)) {
      (ptrs as Record<string, number>)[k] = this.alloc(v);
    }
    for (const [k, len] of Object.entries(outLens)) {
      (ptrs as Record<string, number>)[k] = this.allocOut(len);
    }
    try {
      return fn(ptrs);
    } finally {
      this.free(Object.values(ptrs));
    }
  }
}
