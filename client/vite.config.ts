import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true, secure: false },
      '/socket.io': { target: 'http://127.0.0.1:3001', changeOrigin: true, ws: true, secure: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/socket.io-client/')) return 'socket';
        },
      },
    },
  },
});
