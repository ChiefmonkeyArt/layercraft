import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const version = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
const stub = fileURLToPath(new URL('./src/stubs/no-asmjs.js', import.meta.url));
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022' },
  worker: { format: 'iife', rolldownOptions: { output: { keepNames: true } } }, // the depth model looks its image processor up by class name
  resolve: { alias: [{ find: /^\.\/wasm\/clipper$/, replacement: stub }] },
  optimizeDeps: { exclude: ['js-angusj-clipper'] },
});
