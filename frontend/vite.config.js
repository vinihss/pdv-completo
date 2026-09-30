import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'
import { ALL, appProfilePlugin, resolveAppProfile } from './vite/app-profiles.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Um build, N apps: o MESMO bundle React sobe nas 4 entries, o que muda é o
// outDir e o que o plugin escreve por cima (manifest + sw).
//
//   VITE_APP_PROFILE=all (default) → dist/index.html na raiz, com as 4
//     entries lado a lado. É o app único que o app de produção consome —
//     `frontendDist: "../dist"` em src-tauri/tauri.conf.json aponta para a
//     raiz, então `dist/index.html` não pode sumir nem mudar de lugar.
//   VITE_APP_PROFILE=kds         → dist/kds/index.html, só a entry da cozinha
//   ...idem para pdv, garcon e entregador
const appProfile = resolveAppProfile(process.env.VITE_APP_PROFILE)
const isSingleApp = appProfile !== ALL

// App isolado monta o bundle a partir do MESMO `index.html` (e não do
// `kds.html`): o nome do arquivo de saída vem do caminho da entry, então
// `index.html` continua saindo `index.html` — dentro de `dist/<profile>/`,
// que é o que o `frontendDist` de cada app Tauri vai apontar. Quem dá o
// título e o nome do app é o plugin, que troca o profile no HTML e injeta o
// `window.__APP_PROFILE__` antes do bundle carregar.
const input = isSingleApp
  ? { index: path.resolve(__dirname, 'index.html') }
  : {
      index: path.resolve(__dirname, 'index.html'),
      kds: path.resolve(__dirname, 'kds.html'),
      garcon: path.resolve(__dirname, 'garcon.html'),
      entregador: path.resolve(__dirname, 'entregador.html'),
    }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), appProfilePlugin({ appProfile })],
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
  define: {
    // Fallback de build: vale para o bundle inteiro, inclusive para quem
    // abrir o app sem passar por uma entry. Quem sabe em qual entry subiu é
    // o `window.__APP_PROFILE__` que o plugin injeta no HTML — no build
    // `all` as 4 entries dividem este bundle, então um valor só aqui não
    // distinguiria uma entrada da outra. Ver src/shared/lib/appProfile.js.
    __APP_PROFILE__: JSON.stringify(appProfile),
  },
  build: {
    // `dist/kds`, `dist/garcon`... Um app por diretório, então publicar os
    // 4 é copiar `dist/` inteiro. `emptyOutDir` explícito porque o outDir
    // está dentro da root e o Vite não adivinha a intenção.
    outDir: isSingleApp ? path.join('dist', appProfile) : 'dist',
    emptyOutDir: true,
    // `input` mora AQUI dentro, e não na raiz da config. Duas armadilhas do
    // Vite 8 (rolldown) que custam tempo, porque as duas passam o build sem
    // erro nenhum e só falham em silêncio:
    //   - `rollupOptions` (o nome antigo) só é reencaminhado para
    //     `rolldownOptions` dentro de `build`/`worker`/`optimizeDeps`;
    //   - o `input` no topo da config é OUTRA chave (`config.input`), e o
    //     bundler só lê `build.rolldownOptions.input`.
    // Errando as duas, o build sai verde, produz um index.html só e as
    // outras 3 entries simplesmente não existem.
    rolldownOptions: {
      input,
    },
  },
})
