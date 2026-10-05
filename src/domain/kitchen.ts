import { KITCHEN_CATEGORIES } from './types'
import type { KitchenWindow, MenuItem, ShopHours } from './types'

/**
 * ครัวเปิดอยู่ไหม
 *
 * ต้องให้ผลตรงกับ kitchen_window() ฝั่ง SQL เป๊ะ ๆ — ฐานข้อมูลเป็นคนปฏิเสธจริง
 * ส่วนอันนี้มีไว้ให้หน้าจอเตือนล่วงหน้า ถ้าสองฝั่งคิดไม่ตรงกัน ลูกค้าจะเห็น
 * ปุ่มกดได้แล้วโดนปฏิเสธตอนกด ซึ่งแย่กว่าไม่เตือนเลย
 *
 * คิดตามเวลาไทยเสมอ ไม่ใช่เวลาเครื่อง เพราะพนักงานอาจเปิดจากเครื่องที่ตั้ง
 * โซนเวลาไว้ผิด
 */
export function kitchenWindow(hours: ShopHours[], now = new Date()): KitchenWindow {
  const { weekday, minutes } = bangkokNow(now)
  const today = hours.find((h) => h.weekday === weekday)

  if (!today || today.closed) {
    return { open: false, closeAt: null, reason: 'วันนี้ร้านปิด' }
  }

  const closeAt = today.kitchenCloseTime ?? today.closeTime
  const open = toMinutes(today.openTime)
  const close = toMinutes(closeAt)

  if (minutes < open) {
    return { open: false, closeAt, reason: `ร้านเปิด ${today.openTime} น.` }
  }
  if (minutes >= close) {
    return { open: false, closeAt, reason: `ครัวปิดแล้ว (${closeAt} น.)` }
  }
  return { open: true, closeAt, reason: null }
}

/** เมนูชิ้นนี้ต้องให้ครัวทำไหม */
export function needsKitchen(item: Pick<MenuItem, 'category'>): boolean {
  return KITCHEN_CATEGORIES.includes(item.category)
}

/** ในตะกร้ามีของที่ต้องให้ครัวทำไหม */
export function cartNeedsKitchen(
  menu: MenuItem[],
  items: { menuItemId: string; qty: number }[],
): boolean {
  return items.some((line) => {
    const item = menu.find((m) => m.id === line.menuItemId)
    return item ? needsKitchen(item) : false
  })
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** วันและนาทีของวันตามเวลาไทย ไม่ว่าเครื่องจะตั้งโซนเวลาไว้ยังไง */
function bangkokNow(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return {
    weekday: names.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}
