// Minimal service worker: makes Amber installable as a PWA (required for the
// Android share-target save path). Network passthrough — the library itself is
// server-rendered data and shouldn't be stale-cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally empty: presence of a fetch handler is what Chrome's
  // installability heuristic checks; default network handling does the rest.
});
