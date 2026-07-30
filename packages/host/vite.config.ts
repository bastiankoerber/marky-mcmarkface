import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = `http://127.0.0.1:${process.env.PILCROW_PORT ?? 7423}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Dev only. In production the Hono server serves these assets itself, so there is one
    // origin and no proxy at all.
    proxy: {
      '/api': { target: SERVER, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // Heavy viewers are React.lazy'd; keeping the chunk warning low surfaces it when a
    // contributed viewer accidentally lands in the entry bundle.
    chunkSizeWarningLimit: 700,
  },
});
