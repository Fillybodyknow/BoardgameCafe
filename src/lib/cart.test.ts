import { describe, expect, it } from 'vitest'
import { cartCount, cartItems, cartTotal, setCartQty } from './cart'

describe('ตะกร้าสั่งอาหาร', () => {
  it('เพิ่มและลดจำนวนได้', () => {
    let cart = setCartQty({}, 'a', 1)
    expect(cart).toEqual({ a: 1 })
    cart = setCartQty(cart, 'a', 3)
    expect(cart).toEqual({ a: 3 })
  })

  // ★ ต้นเหตุของบั๊ก: เดิมเก็บคีย์ไว้ด้วยค่า 0 แล้วส่งไปกับออเดอร์
  it('ลดจนเหลือ 0 ต้องถอดออกจากตะกร้า ไม่ใช่เก็บเป็น 0', () => {
    const cart = setCartQty({ a: 1, b: 2 }, 'a', 0)
    expect(cart).toEqual({ b: 2 })
    expect(Object.keys(cart)).not.toContain('a')
  })

  it('ค่าติดลบก็ถอดออกเหมือนกัน', () => {
    expect(setCartQty({ a: 1 }, 'a', -5)).toEqual({})
  })

  it('ไม่แก้ตะกร้าเดิม (immutable)', () => {
    const before = { a: 1 }
    const after = setCartQty(before, 'b', 2)
    expect(before).toEqual({ a: 1 })
    expect(after).toEqual({ a: 1, b: 2 })
  })

  it('cartItems กรองรายการ qty 0 ทิ้ง แม้จะหลุดเข้ามา', () => {
    // จำลองตะกร้าที่เพี้ยนจากทางอื่น — ด่านสุดท้ายก่อนส่งต้องกันไว้
    const items = cartItems({ a: 1, b: 0, c: 2 })
    expect(items).toEqual([
      { menuItemId: 'a', qty: 1 },
      { menuItemId: 'c', qty: 2 },
    ])
  })

  it('ตะกร้าว่างได้รายการว่าง', () => {
    expect(cartItems({})).toEqual([])
  })

  it('นับจำนวนและคิดยอดไม่นับรายการ 0', () => {
    const cart = { a: 2, b: 0, c: 1 }
    const price = (id: string) => ({ a: 50, b: 999, c: 100 })[id]
    expect(cartCount(cart)).toBe(3)
    expect(cartTotal(cart, price)).toBe(200)
  })

  it('เมนูที่หาราคาไม่เจอไม่ทำให้ยอดพัง', () => {
    expect(cartTotal({ ghost: 2 }, () => undefined)).toBe(0)
  })
})
