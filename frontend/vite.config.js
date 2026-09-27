import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './', // <-- Essencial para apps desktop híbridos
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // @inspector/react resolvido do diretório versionado em vendor/ (só dev
      // usa o pacote — produção nem referencia; a resolução passa pelo
      // main/exports do package.json versionado, uma única vez, sem duplicar
      // o path).
      '@inspector/react': path.resolve(
        __dirname,
        './vendor/inspector-react',
      ),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/uploads': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      // Webhook da Meta: path do backend, sem o prefixo /api do dev.
      '/webhooks': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/realtime': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
})
