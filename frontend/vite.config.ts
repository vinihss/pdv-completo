import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'
// Correção: Módulos locais importados em ambiente TypeScript devem omitir a extensão .ts
// ou referenciar a extensão compilada dependendo das regras restritas do seu ecossistema.
import { ALL, appProfilePlugin, resolveAppProfile } from './vite/app-profiles'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Garante um fallback seguro caso a variável de ambiente não seja injetada no terminal
const currentProfileEnv = process.env.VITE_APP_PROFILE || 'all'
const appProfile = resolveAppProfile(currentProfileEnv)
const isSingleApp = appProfile !== ALL

const input = isSingleApp
    ? { index: path.resolve(__dirname, 'index.html') }
    : {
      index: path.resolve(__dirname, 'index.html'),
      kds: path.resolve(__dirname, 'kds.html'),
    }

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    appProfilePlugin({ appProfile }),
    // Configuração do PWA adaptada ao ecossistema multi-profile
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline', // Recomendado para builds híbridos/Tauri
      manifest: {
        name: `PDV Completo - ${(appProfile || 'APP').toUpperCase()}`,
        short_name: `PDV ${(appProfile || 'APP').toUpperCase()}`,
        description: 'Sistema de Ponto de Venda para Restaurantes e Pubs',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      devOptions: {
        enabled: true // Permite debugar o Service Worker no localhost:5173
      }
    })
  ],
  base: './', // <-- Essencial para apps desktop híbridos
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/uploads': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/webhooks': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/realtime': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  define: {
    __APP_PROFILE__: JSON.stringify(appProfile),
  },
  build: {
    outDir: isSingleApp ? path.join('dist', appProfile) : 'dist',
    emptyOutDir: true,

    // Configurações do bundler interno do Vite 8 (Rolldown)
    rolldownOptions: {
      input,
      output: {
        // Configura a divisão avançada de código sugerida pelo aviso
        codeSplitting: {
          minSize: 10000, // Diminuído para 10kB para forçar mais divisões de ficheiros pequenos
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/]react/, // Isolamento total do núcleo do React
              priority: 30,
            },
            {
              name: 'lucide-icons',
              test: /node_modules[\\/]lucide-react/, // Isola os ícones (que costumam ser pesados)
              priority: 25,
            },
            {
              name: 'vendor',
              test: /node_modules/, // Agrupa o restante das dependências (ex: tailwind/axios)
              priority: 10,
            },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
