import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'VoterRecord',
        short_name: 'VoterRecord',
        description: 'Voter management dashboard for admin and field operations.',
        theme_color: '#0f172a',
        background_color: '#f8fafc',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB, was default 2 MiB
        // Take over immediately so a deploy can't leave users running stale JS that
        // still points at the old backend.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // The service worker must never answer API/media requests: those are
        // session-authenticated and must always hit the Worker.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/rest\//, /^\/storage\//, /^\/media\//],
        runtimeCaching: [
          {
            // Photos are immutable per key and are the bulk of egress, so cache them
            // in the browser rather than re-fetching from R2 on every page view.
            urlPattern: ({ url }) => url.pathname.startsWith('/media/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'voter-photos',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/rest': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/storage': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
