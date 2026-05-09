import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    host: true,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
