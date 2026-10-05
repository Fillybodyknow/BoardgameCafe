import type { ID } from '../domain/types'

/**
 * ตะกร้าสั่งอาหาร
 *
 * เคยเป็นบั๊ก: กด − จนเหลือ 0 แล้วเก็บคีย์ไว้ด้วยค่า 0 เวลาส่งออเดอร์จึงมี
 * รายการ qty=0 ติดไปด้วย แล้วเซิร์ฟเวอร์ปฏิเสธ "ทั้งออเดอร์" ด้วยข้อความ
 * จำนวนต้องมากกว่า 0 ทั้งที่หน้าจอแสดงจำนวนรายการถูกต้อง (0 ไม่ถูกนับ)
 * ลูกค้าจึงไม่มีทางเดาได้เลยว่าอะไรผิด
 *
 * รวมตรรกะไว้ที่เดียวเพราะมีสองหน้าใช้ตะกร้า (ลูกค้าสแกน QR และพนักงาน)
 * ถ้าแยกกันเขียน อีกหน้าจะหลุดเสมอ
 */
export type Cart = Record<ID, number>

/** ตั้งจำนวนของเมนูหนึ่ง — ถ้าเหลือ 0 ให้ถอดออกจากตะกร้า ไม่ใช่เก็บเป็น 0 */
export function setCartQty(cart: Cart, menuItemId: ID, qty: number): Cart {
  const next = { ...cart }
  if (qty > 0) {
    next[menuItemId] = qty
  } else {
    delete next[menuItemId]
  }
  return next
}

/**
 * แปลงตะกร้าเป็นรายการสำหรับส่งไปสั่ง
 *
 * กรอง qty <= 0 ซ้ำอีกชั้นแม้ setCartQty จะถอดให้แล้ว เพราะจุดนี้คือด่าน
 * สุดท้ายก่อนออกจากเครื่อง และราคาของการพลาดคือออเดอร์ทั้งใบถูกปฏิเสธ
 */
export function cartItems(cart: Cart): { menuItemId: ID; qty: number }[] {
  return Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([menuItemId, qty]) => ({ menuItemId, qty }))
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((sum, qty) => sum + Math.max(0, qty), 0)
}

export function cartTotal(cart: Cart, priceOf: (id: ID) => number | undefined): number {
  return Object.entries(cart).reduce(
    (sum, [id, qty]) => sum + (qty > 0 ? (priceOf(id) ?? 0) * qty : 0),
    0,
  )
}
