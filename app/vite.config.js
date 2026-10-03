import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// `npm run dev`: HTTPS (self-signed) so phones on the same Wi-Fi can use the microphone. Open
// https://<laptop-ip>:5173/guardian-test.html on the phone and accept the certificate warning.
// `npm run dev:local`: plain HTTP on localhost (the mic works there too, no certificate prompt).
export default defineConfig({
  plugins: [react(), ...(process.env.FIREFLY_HTTP ? [] : [basicSsl()])],
  server: {
    host: true,
    // API: P3's local server (cd api && npm start) on :4280.
    proxy: { '/api': { target: process.env.FIREFLY_API ?? 'http://localhost:4280', changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        guardianTest: resolve(import.meta.dirname, 'guardian-test.html'),
      },
    },
  },
  test: { environment: 'node' },
});
