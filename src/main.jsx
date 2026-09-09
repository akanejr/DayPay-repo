/* DayPay — Know what your work is worth.
   Copyright © 2026 Akaninyene. All rights reserved.
   Unauthorized copying, modification, or distribution is prohibited. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import './ux-motion.js' // DayPay visual-only motion layer (no logic/data changes)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// DayPay PWA - register service worker for offline + installable (production only;
// disabled in dev so HMR + fresh assets are never shadowed by the SW cache)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('DayPay PWA: SW registered', reg.scope)
    }).catch(err => {
      console.log('DayPay PWA: SW registration failed', err)
    })
  })
}
