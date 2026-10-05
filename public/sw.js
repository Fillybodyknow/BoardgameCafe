/**
 * Service worker — รับแจ้งเตือนออเดอร์เข้าครัว
 *
 * push ที่ส่งมาไม่มีเนื้อหา (ดู supabase/functions/notify-kitchen) ข้อความ
 * จึงเขียนไว้ที่นี่ ไม่ใช่ส่งมาจากเซิร์ฟเวอร์ — แลกกับการไม่ต้องเข้ารหัส
 * payload ซึ่งซับซ้อนและพังง่าย
 *
 * ไฟล์นี้อยู่ใน public/ จึงถูกคัดลอกไป dist ตรง ๆ และเสิร์ฟที่ <base>/sw.js
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('มีออเดอร์ใหม่เข้าครัว', {
      body: 'แตะเพื่อเปิดจอครัว',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // แทนที่อันเดิมแทนที่จะกองซ้อนกัน ออเดอร์รัว ๆ จะได้ไม่ท่วมจอ
      tag: 'kitchen-order',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = new URL('#/kitchen', self.registration.scope).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // ถ้าเปิดแอปค้างอยู่แล้วให้สลับไปแท็บนั้น ดีกว่าเปิดแท็บใหม่ซ้อน
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          client.navigate?.(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
