import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

function leancryptoEsm() {
  return {
    name: 'leancrypto-esm',
    transform(code, id) {
      if (id.endsWith('leancrypto/leancrypto.js')) {
        return code + '\nexport default leancrypto;\n';
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), leancryptoEsm()],
  optimizeDeps: {
    exclude: ['brotli-wasm'],
  },
});
