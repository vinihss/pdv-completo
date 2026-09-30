import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { appProfile, isDesktop } from '@/shared/lib'

// @inspector/react só em dev (ferramenta de inspeção — não vai pro bundle
// de produção: o Vite troca import.meta.env.DEV por `false` no build e o
// ramo morto é eliminado junto com o import dinâmico).
const InspectorDevTools = import.meta.env.DEV
  ? (await import('@inspector/react')).InspectorDevTools
  : () => null

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <InspectorDevTools />
  </StrictMode>,
)

// O MESMO bundle sobe nas 4 entries (caixa/cozinha/garçom/entregador), e o
// profile de qual delas abriu vem do HTML, não da URL — no desktop o mesmo
// app aparece na raiz do `tauri://localhost`. Deixar isso no <html> é o que
// permite ao CSS e ao app Tauri saberem qual app está na tela
// (ver vite/app-profiles.js e src/shared/lib/appProfile.js).
document.documentElement.dataset.appProfile = appProfile()

// Registra o service worker só no web em produção (build), pra não atrapalhar
// o hot-reload do Vite em dev. No desktop o bundle é servido pelo protocolo do
// Tauri: um SW ali só serviria pra cachear um index.html antigo e esconder a
// versão nova depois do auto-update.
if (!isDesktop() && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // Relativo, não `/sw.js`: no build de um app só o sw fica ao lado do
    // index (`dist/kds/sw.js`), não na raiz do site.
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // instalabilidade é um "nice to have" — se falhar, o app continua
      // funcionando normalmente como página web comum.
    })
  })
}
