/**
 * Service worker — รับแจ้งเตือนออเดอร์เข้าครัว
 *
 * push มาพร้อมข้อความที่เข้ารหัสไว้ เบราว์เซอร์ถอดให้แล้วส่งต่อมาที่นี่
 * แต่ต้องรองรับกรณีไม่มีเนื้อหาด้วย เพราะถ้าเซิร์ฟเวอร์ประกอบข้อความไม่สำเร็จ
 * มันจะถอยไปส่งแบบเปล่า ๆ ซึ่งยังดีกว่าไม่แจ้งเตือนเลย
 *
 * ไฟล์นี้อยู่ใน public/ จึงถูกคัดลอกไป dist ตรง ๆ และเสิร์ฟที่ <base>/sw.js
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let title = 'มีออเดอร์ใหม่เข้าครัว'
  let body = 'แตะเพื่อเปิดจอครัว'

  try {
    const data = event.data?.json()
    if (data?.title) title = data.title
    if (data?.body) body = data.body
  } catch {
    // ส่งมาแบบไม่มีเนื้อหา หรือเนื้อหาไม่ใช่ JSON — ใช้ข้อความสำรอง
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
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
