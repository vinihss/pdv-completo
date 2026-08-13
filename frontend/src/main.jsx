import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registra o service worker só em produção (build), pra não atrapalhar o
// hot-reload do Vite em dev.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // instalabilidade é um "nice to have" — se falhar, o app continua
      // funcionando normalmente como página web comum.
    })
  })
}
