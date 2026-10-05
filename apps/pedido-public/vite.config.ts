import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Este app NÃO é dono do código que ele serve: `src/app` é novo, mas a
    // página do cardápio vem inteira de `frontend/src` pelo alias `@/`. Os dois
    // lados bring their own `node_modules` (o app tem lockfile próprio, o
    // frontend o dele), então sem o `dedupe` o Vite entrega DUAS cópias de
    // `react`/`react-dom`/`react-router-dom`: o `createRoot` deste app
    // montaria a árvore com um React e os componentes herdados usariam outro.
    // O sintoma não é um erro de build — é `Invalid hook call` em produção,
    // porque contexto e dispatcher são por instância. O `dedupe` amarra tudo na
    // cópia que vive em `apps/pedido-public/node_modules`.
    dedupe: ['react', 'react-dom', 'react-router-dom', 'lucide-react'],
    alias: {
      '@': path.resolve(__dirname, '../../frontend/src'),
    },
  },
  server: {
    port: 5175,
    host: true,
  },
  preview: {
    port: 5175,
    host: true,
  },
  base: './',
})