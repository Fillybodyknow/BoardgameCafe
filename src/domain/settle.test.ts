import { describe, expect, it } from 'vitest'
import { computeBill, settlementFor } from './pricing'
import type { GuestPass, Order, RateSnapshot } from './types'

/**
 * จ่ายตอนกลับก่อน — ฝั่งคำนวณ
 *
 * ชุดนี้ต้องให้ผลตรงกับ supabase/tests/95_settle_test.sql เป๊ะ ๆ เพราะโหมด
 * จำลองใช้โค้ดนี้ ส่วนของจริงใช้ SQL ถ้าสองฝั่งคิดไม่เหมือนกัน บั๊กจะผ่าน
 * เทสต์ในโหมดจำลองแล้วไปโผล่หน้าร้าน — เคยเกิดมาแล้วสี่ครั้งในโปรเจกต์นี้
 *
 * ใช้เรตชั่วโมงละ 0 เพื่อให้ตัวเลขมาจากค่าอาหารล้วน ๆ จะได้ไม่ต้องเดาว่า
 * เทสต์ล้มเพราะสูตรหารหรือเพราะนาฬิกาเดิน
 */

const FREE: RateSnapshot = {
  name: 'ฟรี',
  pricePerHour: 0,
  roundToMinutes: 1,
  minimumMinutes: 0,
  dayPassCap: null,
}

const NOW = new Date('2026-10-05T12:00:00+07:00')

const pass = (id: string, status: GuestPass['status'] = 'active'): GuestPass => ({
  id,
  visitId: 'v',
  displayName: id,
  ratePlanId: 'rp',
  status,
  checkedInAt: NOW.toISOString(),
  checkedOutAt: null,
  pausedMinutes: 0,
  pausedAt: null,
  rate: FREE,
})

const order = (
  id: string,
  splitMode: Order['splitMode'],
  orderedByPassId: string | null,
  price: number,
  qty = 1,
): Order => ({
  id,
  visitId: 'v',
  orderedByPassId,
  placedBy: 'staff',
  splitMode,
  tableIdSnapshot: null,
  status: 'served',
  placedAt: NOW.toISOString(),
  lines: [
    {
      id: `l-${id}`,
      menuItemId: 'm',
      nameSnapshot: 'ของกิน',
      unitPriceSnapshot: price,
      qty,
    },
  ],
})

function bill(passes: GuestPass[], orders: Order[], sharedSettled = 0) {
  return computeBill({ visitId: 'v', passes, orders, sharedSettled, now: NOW })
}

describe('ยอดของคนที่จะกลับก่อน', () => {
  it('ของตัวเอง + ส่วนแบ่งของที่หารกัน', () => {
    const passes = [pass('a'), pass('b'), pass('c')]
    const orders = [order('shared', 'shared', null, 100, 3), order('own', 'owner', 'a', 50)]

    const calc = settlementFor(bill(passes, orders), 'a', 3)

    expect(calc.sharedShare).toBe(100)
    expect(calc.total).toBe(150)
  })

  it('คนสุดท้ายรับเศษไปทั้งหมด ยอดรวมจึงไม่ขาดไม่เกิน', () => {
    const passes = [pass('a'), pass('b'), pass('c')]
    const orders = [order('shared', 'shared', null, 100)]

    const first = settlementFor(bill(passes, orders), 'a', 3)
    const second = settlementFor(bill(passes, orders, first.sharedShare), 'b', 2)
    const last = settlementFor(
      bill(passes, orders, first.sharedShare + second.sharedShare),
      'c',
      1,
    )

    expect(first.sharedShare + second.sharedShare + last.sharedShare).toBeCloseTo(100, 2)
  })
})

describe('ยอดที่เหลือหลังมีคนจ่ายไปแล้ว', () => {
  it('ตัดค่าเล่นและของที่คนนั้นสั่งเองออก', () => {
    const passes = [pass('a', 'billed'), pass('b')]
    const orders = [order('own-a', 'owner', 'a', 50), order('own-b', 'owner', 'b', 70)]

    const remaining = bill(passes, orders)

    expect(remaining.lines.some((l) => l.guestPassId === 'a')).toBe(false)
    expect(remaining.total).toBe(70)
  })

  it('ของที่หารกันยังอยู่ครบ แล้วหักด้วยบรรทัดที่เห็นได้', () => {
    const passes = [pass('a', 'billed'), pass('b'), pass('c')]
    const orders = [order('shared', 'shared', null, 300)]

    const remaining = bill(passes, orders, 100)

    const adjust = remaining.lines.find((l) => l.source === 'adjustment')
    expect(adjust?.amount).toBe(-100)
    expect(remaining.total).toBe(200)
  })

  // ★ ของที่สั่งหลังคนหนึ่งกลับไปแล้ว คนที่กลับไปต้องไม่ถูกคิดด้วย
  it('ของที่สั่งทีหลัง หารเฉพาะคนที่ยังอยู่', () => {
    const passes = [pass('a', 'billed'), pass('b'), pass('c')]
    const orders = [order('s1', 'shared', null, 300), order('s2', 'shared', null, 100)]

    // a จ่ายส่วนแบ่งของ 300 ไปแล้ว = 100
    const calc = settlementFor(bill(passes, orders, 100), 'b', 2)

    // เหลือ 400 − 100 = 300 หารสองคน
    expect(calc.sharedShare).toBe(150)
  })
})
