import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser always talks to the Vite dev server (same origin), which
// forwards /api and /socket.io to the backend. Inside Docker the backend is
// reached by its Compose service name (VITE_PROXY_TARGET=http://backend:4000);
// on the host it is http://localhost:4000.
const target = process.env.VITE_PROXY_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
    css: false,
  },
});
