/* global workbox */
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js");

const APP_VERSION = "1772975985479";
const CACHE_PREFIXES = ["aura-pages-", "aura-audio-", "aura-images-", "aura-api-", "aura-flight-mode-"];
const ACTIVE_CACHES = new Set([
  `aura-pages-${APP_VERSION}`,
  `aura-audio-${APP_VERSION}`,
  `aura-images-${APP_VERSION}`,
  `aura-api-${APP_VERSION}`,
  `aura-flight-mode-${APP_VERSION}`
]);

if (workbox) {
  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  workbox.precaching.precacheAndRoute([
    { url: "/", revision: APP_VERSION },
    { url: "/index.html", revision: APP_VERSION },
    { url: "/styles.css", revision: APP_VERSION },
    { url: "/app.js", revision: APP_VERSION },
    { url: "/manifest.json", revision: APP_VERSION },
    { url: "/audio/rain.mp3", revision: APP_VERSION },
    { url: "/audio/wind.mp3", revision: APP_VERSION },
    { url: "/audio/fire.mp3", revision: APP_VERSION }
  ]);

  workbox.routing.registerRoute(
    ({ request }) => request.destination === "document",
    new workbox.strategies.NetworkFirst({ cacheName: `aura-pages-${APP_VERSION}` })
  );

  workbox.routing.registerRoute(
    ({ request, url }) =>
      request.destination === "audio" ||
      url.origin.includes("jamendo.com") ||
      url.pathname.startsWith("/audio/"),
    new workbox.strategies.CacheFirst({
      cacheName: `aura-audio-${APP_VERSION}`,
      plugins: [new workbox.expiration.ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 })]
    })
  );

  workbox.routing.registerRoute(
    ({ request, url }) =>
      request.destination === "image" ||
      url.origin.includes("googleapis.com") ||
      url.origin.includes("gstatic.com"),
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: `aura-images-${APP_VERSION}`,
      plugins: [new workbox.expiration.ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 15 })]
    })
  );

  workbox.routing.registerRoute(
    ({ url }) => url.pathname.startsWith("/api/"),
    new workbox.strategies.NetworkFirst({
      cacheName: `aura-api-${APP_VERSION}`,
      networkTimeoutSeconds: 6,
      plugins: [
        {
          handlerDidError: async ({ request }) => {
            const body = {
              error: request.url.includes("/api/books")
                ? "Book search is unavailable right now. Check your connection and try again."
                : "Request unavailable while offline. Please retry when connected."
            };

            return new Response(JSON.stringify(body), {
              status: 503,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
      ]
    })
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cacheName) => {
          const isAuraCache = CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
          if (!isAuraCache || ACTIVE_CACHES.has(cacheName)) {
            return Promise.resolve(false);
          }

          return caches.delete(cacheName);
        })
      )
    )
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (!event.data || event.data.type !== "CACHE_URLS") {
    return;
  }

  const urls = Array.isArray(event.data.payload) ? event.data.payload : [];
  event.waitUntil(
    caches.open(`aura-flight-mode-${APP_VERSION}`).then(async (cache) => {
      for (const url of urls) {
        try {
          await cache.add(url);
        } catch (error) {
          console.warn("Could not cache", url, error);
        }
      }
    })
  );
});
