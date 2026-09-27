import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// X-Ray runs entirely in the browser. Vite only serves the static assets —
// there is no X-Ray backend and no server-side processing of project files.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
