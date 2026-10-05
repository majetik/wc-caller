// WC Caller service worker: shows push notifications and opens the right post when tapped.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'WC Caller', {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: data.tag,
    data: { url: data.url || self.registration.scope },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'open-url', url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
