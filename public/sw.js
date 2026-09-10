// DayPay Service Worker - PWA offline-first
const CACHE_NAME = 'daypay-v15-brand'
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/daypay-icon.svg',
  '/daypay-icon-512.png',
  '/apple-touch-icon.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Some assets might fail, still cache what we can
        return cache.addAll(['/', '/index.html', '/manifest.json'])
      })
    })
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    })
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Skip Supabase API and other external requests - let them go network
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com')) {
    return
  }

  // For navigation requests, serve index.html from cache (SPA fallback)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        // Update cache with fresh index.html
        const copy = res.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy))
        return res
      }).catch(() => {
        return caches.match('/index.html') || caches.match('/')
      })
    )
    return
  }

  // For assets (css, js, images, svg), cache-first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached
      return fetch(req).then(res => {
        // Cache successful responses
        if (res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'image' || url.pathname.endsWith('.svg') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
          const copy = res.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy))
        }
        return res
      }).catch(() => {
        // Fallback for images
        if (req.destination === 'image') {
          return caches.match('/daypay-icon-512.png')
        }
      })
    })
  )
})
