import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { appProfile, isDesktop } from '@/shared/lib'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
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
// Service worker desativado temporariamente para resolver problemas de cache
// que estavam causando configurações erradas em tenants multi-tenant.
// O SW pode ser reativado depois de resolver o problema de cache do Cloudflare.
if (!isDesktop() && 'serviceWorker' in navigator && import.meta.env.PROD) {
  // Desregistrar todos os service workers ativos
  window.addEventListener('load', async () => {
    if (navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }
    // Limpar todos os caches
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    }
  });
}
