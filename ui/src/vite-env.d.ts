/// <reference types="vite/client" />

// sqlcipher/sqlcipher.js is untyped vendored JS, not part of ui/'s own
// sources -- see ui/src/crypto/sqlcipherLoader.ts's Node-side dynamic import.
declare module "*.js" {
  const value: unknown;
  export default value;
}
