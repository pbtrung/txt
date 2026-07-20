// Hand-written type declaration for the vendored Emscripten UMD build
// leancrypto.js (no declarations of its own). See ui/src/crypto/
// leancryptoLoader.ts for how this factory is used.
declare const factory: (opts?: Record<string, unknown>) => Promise<unknown>;
export default factory;
