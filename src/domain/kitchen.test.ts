import { describe, expect, it } from 'vitest'
import { cartNeedsKitchen, kitchenWindow, needsKitchen } from './kitchen'
import type { MenuItem, ShopHours } from './types'

/**
 * เวลาปิดครัว — ฝั่งคำนวณ
 *
 * ต้องให้ผลตรงกับ kitchen_window() ฝั่ง SQL เป๊ะ ๆ (ดู 96_kitchen_hours_test.sql)
 * ถ้าสองฝั่งคิดไม่ตรงกัน ลูกค้าจะเห็นปุ่มกดได้แล้วโดนปฏิเสธตอนกด ซึ่งแย่กว่า
 * ไม่เตือนเลย
 *
 * ใช้เวลาแบบระบุโซนไทยชัดเจน เพราะเครื่องที่รันเทสต์อาจตั้งโซนเวลาไว้คนละแบบ
 */

const day = (over: Partial<ShopHours> = {}): ShopHours => ({
  weekday: 0,
  openTime: '11:00',
  closeTime: '23:00',
  closed: false,
  kitchenCloseTime: '22:00',
  ...over,
})

/** ทุกวันเหมือนกันหมด เทสต์จะได้ไม่พังเฉพาะบางวันของสัปดาห์ */
const everyDay = (over: Partial<ShopHours> = {}): ShopHours[] =>
  Array.from({ length: 7 }, (_, weekday) => day({ ...over, weekday }))

const at = (iso: string) => new Date(iso)

describe('ครัวเปิดอยู่ไหม', () => {
  it('บ่ายสามเปิด', () => {
    expect(kitchenWindow(everyDay(), at('2026-10-05T15:00:00+07:00')).open).toBe(true)
  })

  it('สี่ทุ่มตรงปิดแล้ว', () => {
    expect(kitchenWindow(everyDay(), at('2026-10-05T22:00:00+07:00')).open).toBe(false)
  })

  it('ข้อความบอกเวลาปิดครัว ไม่ใช่เวลาปิดร้าน', () => {
    const w = kitchenWindow(everyDay(), at('2026-10-05T22:30:00+07:00'))
    expect(w.reason).toBe('ครัวปิดแล้ว (22:00 น.)')
    expect(w.closeAt).toBe('22:00')
  })

  it('ก่อนร้านเปิดก็ยังไม่เปิดครัว', () => {
    expect(kitchenWindow(everyDay(), at('2026-10-05T09:00:00+07:00')).open).toBe(false)
  })

  // ★ จุดที่พลาดง่าย: ตีครึ่งคืนเลขนาทีน้อยกว่า 22:00 แต่ต้องไม่นับว่าเปิด
  it('หลังเที่ยงคืนต้องนับว่าปิด', () => {
    expect(kitchenWindow(everyDay(), at('2026-10-06T00:30:00+07:00')).open).toBe(false)
  })

  it('ไม่ตั้งเวลาปิดครัว = ปิดพร้อมร้าน', () => {
    const hours = everyDay({ kitchenCloseTime: null })
    expect(kitchenWindow(hours, at('2026-10-05T22:30:00+07:00')).open).toBe(true)
    expect(kitchenWindow(hours, at('2026-10-05T23:10:00+07:00')).open).toBe(false)
  })

  it('วันที่ร้านปิด ครัวปิดด้วย', () => {
    const w = kitchenWindow(everyDay({ closed: true }), at('2026-10-05T15:00:00+07:00'))
    expect(w.open).toBe(false)
    expect(w.reason).toBe('วันนี้ร้านปิด')
  })

  // เครื่องที่ตั้งโซนเวลาผิดต้องไม่ทำให้ครัวเปิด/ปิดผิด
  it('คิดตามเวลาไทย ไม่ใช่เวลาเครื่อง', () => {
    // 16:00 UTC = 23:00 ไทย → ครัวปิดแล้ว
    expect(kitchenWindow(everyDay(), at('2026-10-05T16:00:00Z')).open).toBe(false)
    // 08:00 UTC = 15:00 ไทย → ยังเปิด
    expect(kitchenWindow(everyDay(), at('2026-10-05T08:00:00Z')).open).toBe(true)
  })
})

describe('ของชิ้นไหนต้องใช้ครัว', () => {
  const item = (category: MenuItem['category']) => ({ category })

  it('อาหารจานหลักกับของหวานต้องใช้', () => {
    expect(needsKitchen(item('food'))).toBe(true)
    expect(needsKitchen(item('dessert'))).toBe(true)
  })

  it('เครื่องดื่มกับของกินเล่นไม่ต้อง', () => {
    expect(needsKitchen(item('drink'))).toBe(false)
    expect(needsKitchen(item('snack'))).toBe(false)
  })

  it('ตะกร้าที่ปนกันถือว่าต้องใช้ครัว', () => {
    const menu = [
      { id: 'a', category: 'drink' },
      { id: 'b', category: 'food' },
    ] as MenuItem[]

    expect(cartNeedsKitchen(menu, [{ menuItemId: 'a', qty: 1 }])).toBe(false)
    expect(
      cartNeedsKitchen(menu, [
        { menuItemId: 'a', qty: 1 },
        { menuItemId: 'b', qty: 1 },
      ]),
    ).toBe(true)
  })

  it('เมนูที่หาไม่เจอไม่ทำให้พัง', () => {
    expect(cartNeedsKitchen([], [{ menuItemId: 'ไม่มีอยู่จริง', qty: 1 }])).toBe(false)
  })
})
