import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVER = `http://127.0.0.1:${process.env.PILCROW_PORT ?? 7423}`;

/**
 * In development the UI is served by Vite, so it cannot receive the launch key the way the
 * production build does (injected into the served document). The proxy attaches it instead —
 * which is better anyway, since the key never reaches the browser at all.
 *
 * Read per request rather than once: the API process restarts independently of Vite, and each
 * restart mints a new key.
 */
function launchKey(): string {
  try {
    return readFileSync(join(homedir(), '.pilcrow', 'session'), 'utf8').trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Dev only. In production the Hono server serves these assets itself, so there is one
    // origin and no proxy at all.
    proxy: {
      '/api': {
        target: SERVER,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = launchKey();
            if (key) proxyReq.setHeader('X-Pilcrow', key);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    // Heavy viewers are React.lazy'd; keeping the chunk warning low surfaces it when a
    // contributed viewer accidentally lands in the entry bundle.
    chunkSizeWarningLimit: 700,
  },
});
