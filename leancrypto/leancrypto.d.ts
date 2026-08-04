// Hand-written type declaration for the vendored Emscripten UMD build
// leancrypto.js (no declarations of its own). Lives at the repo top level
// (not under txt/ or ui/) since both sides load the same build -- see
// txt/crypto.ts (Node) and, once ported, ui/'s own crypto module (browser)
// for how this factory is used.
declare const factory: (opts?: Record<string, unknown>) => Promise<unknown>;
export default factory;
