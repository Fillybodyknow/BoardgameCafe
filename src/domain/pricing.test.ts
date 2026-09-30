import { describe, expect, it } from 'vitest'
import { billableMinutes, computeBill, playTimeCharge, splitByOwner } from './pricing'
import type { BillPreview, GuestPass, Order, RatePlan } from './types'

const NOW = new Date('2026-09-30T18:00:00Z')
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

const std: RatePlan = {
  id: 'rp-std', name: 'ทั่วไป', pricePerHour: 60,
  roundToMinutes: 30, minimumMinutes: 60, dayPassCap: 199,
}

/** เรตที่ pass ถือติดตัวตอนเช็คอิน — คิดเงินจากตัวนี้ ไม่ใช่เรตปัจจุบันของร้าน */
const snapshot = {
  name: std.name, pricePerHour: std.pricePerHour,
  roundToMinutes: std.roundToMinutes, minimumMinutes: std.minimumMinutes,
  dayPassCap: std.dayPassCap,
}

const pass = (o: Partial<GuestPass> = {}): GuestPass => ({
  id: 'p', visitId: 'v', displayName: 'x', ratePlanId: 'rp-std', status: 'active',
  checkedInAt: ago(60), checkedOutAt: null, pausedMinutes: 0, pausedAt: null,
  ...o,
  rate: o.rate ?? snapshot,
})

describe('billableMinutes', () => {
  it('นับเวลาตั้งแต่เช็คอินถึงตอนนี้', () => {
    expect(billableMinutes(pass({ checkedInAt: ago(95) }), NOW)).toBe(95)
  })

  it('หักเวลาที่เคยพักออก', () => {
    expect(billableMinutes(pass({ checkedInAt: ago(95), pausedMinutes: 12 }), NOW)).toBe(83)
  })

  it('หยุดนับขณะที่ยัง pause อยู่', () => {
    const p = pass({ checkedInAt: ago(95), status: 'paused', pausedAt: ago(9) })
    expect(billableMinutes(p, NOW)).toBe(86)
  })

  it('คนที่กลับไปแล้วนับถึงเวลาที่ออก ไม่ใช่ตอนนี้', () => {
    expect(billableMinutes(pass({ checkedInAt: ago(120), checkedOutAt: ago(30) }), NOW)).toBe(90)
  })
})

describe('playTimeCharge', () => {
  it('ต่ำกว่าขั้นต่ำก็คิดเต็มชั่วโมงแรก', () => {
    expect(playTimeCharge(10, std)).toBe(60)
  })

  it('ปัดขึ้นเป็นช่วงละ 30 นาที', () => {
    expect(playTimeCharge(61, std)).toBe(90)
    expect(playTimeCharge(90, std)).toBe(90)
  })

  it('ไม่เกินเพดานเหมาจ่ายทั้งวัน', () => {
    expect(playTimeCharge(600, std)).toBe(199)
  })

  it('ไม่มีเพดานก็คิดตามจริง', () => {
    expect(playTimeCharge(600, { ...std, dayPassCap: null })).toBe(600)
  })
})

describe('computeBill', () => {
  const passes = [
    pass({ id: 'p1', displayName: 'A' }),
    pass({ id: 'p2', displayName: 'B' }),
  ]

  const order = (o: Partial<Order>): Order => ({
    id: 'o', visitId: 'v', orderedByPassId: null, placedBy: 'staff', splitMode: 'owner',
    tableIdSnapshot: null, status: 'served', placedAt: ago(30), lines: [], ...o,
  })

  const orders: Order[] = [
    order({
      id: 'o1', orderedByPassId: 'p1', splitMode: 'owner',
      lines: [{ id: 'l1', menuItemId: 'm1', nameSnapshot: 'กาแฟ', unitPriceSnapshot: 65, qty: 1 }],
    }),
    order({
      id: 'o2', splitMode: 'shared', status: 'preparing',
      lines: [{ id: 'l2', menuItemId: 'm2', nameSnapshot: 'เฟรนช์ฟรายส์', unitPriceSnapshot: 89, qty: 1 }],
    }),
    order({
      id: 'o3', orderedByPassId: 'p2', status: 'cancelled',
      lines: [{ id: 'l3', menuItemId: 'm3', nameSnapshot: 'ที่ยกเลิก', unitPriceSnapshot: 999, qty: 1 }],
    }),
  ]

  const bill = computeBill({ visitId: 'v', passes, orders, ratePlans: { 'rp-std': std }, now: NOW })

  it('รวมค่าเล่นรายคน + อาหาร แต่ไม่รวมออเดอร์ที่ยกเลิก', () => {
    expect(bill.subtotal).toBe(274) // 60 + 60 + 65 + 89
  })

  it('แยก VAT ออกจากราคาที่รวมแล้ว', () => {
    expect(bill.vat).toBeCloseTo(17.93, 2)
    expect(bill.total).toBe(274)
  })

  it('ของที่สั่งแบบแชร์ไม่ผูกกับใครคนใดคนหนึ่ง', () => {
    const shared = bill.lines.filter((l) => l.guestPassId === null)
    expect(shared).toHaveLength(1)
    expect(shared[0]!.amount).toBe(89)
  })

  describe('splitByOwner', () => {
    const parts = splitByOwner(bill, passes)

    it('แต่ละคนจ่ายค่าเล่นตัวเอง + ของที่ตัวเองสั่ง + ส่วนแบ่งของแชร์', () => {
      expect(parts[0]!.total).toBe(169.5) // 60 + 65 + 44.5
      expect(parts[1]!.total).toBe(104.5) // 60 + 44.5
    })

    it('ผลรวมของบิลย่อยต้องเท่ากับยอดบิลเสมอ', () => {
      const sum = parts.reduce((s, p) => s + p.total, 0)
      expect(sum).toBe(bill.total)
    })
  })
})

describe('เปลี่ยนเรตราคาระหว่างที่ลูกค้ายังนั่งอยู่', () => {
  it('คิดจากเรตที่ pass ถือติดตัว ไม่ใช่เรตปัจจุบันของร้าน', () => {
    const p = pass({ id: 'p1', checkedInAt: ago(60) })
    const before = computeBill({
      visitId: 'v', passes: [p], orders: [], ratePlans: { 'rp-std': std }, now: NOW,
    })

    // เจ้าของร้านขึ้นราคาเป็นสองเท่า
    const raised: RatePlan = { ...std, pricePerHour: 120 }
    const after = computeBill({
      visitId: 'v', passes: [p], orders: [], ratePlans: { 'rp-std': raised }, now: NOW,
    })

    expect(before.total).toBe(60)
    expect(after.total).toBe(before.total)
  })

  it('คนที่เช็คอินหลังขึ้นราคา ได้เรตใหม่', () => {
    const raisedSnapshot = { ...snapshot, pricePerHour: 120 }
    const p = pass({ id: 'p2', checkedInAt: ago(60), rate: raisedSnapshot })
    const bill = computeBill({ visitId: 'v', passes: [p], orders: [], now: NOW })
    expect(bill.total).toBe(120)
  })
})

describe('เศษสตางค์ตอนหารไม่ลงตัว', () => {
  it('3 คนหาร 100 บาท แล้วรวมกลับต้องได้ 100 พอดี', () => {
    const passes = [pass({ id: 'a' }), pass({ id: 'b' }), pass({ id: 'c' })]
    const preview: BillPreview = {
      visitId: 'v',
      lines: [{
        id: 'x', source: 'order_item', sourceId: null, guestPassId: null,
        label: 'ของแชร์', qty: 1, unitPrice: 100, amount: 100,
      }],
      subtotal: 100, serviceCharge: 0, vat: 0, total: 100, computedAt: NOW.toISOString(),
    }
    const sum = splitByOwner(preview, passes).reduce((s, p) => s + p.total, 0)
    expect(sum).toBe(100)
  })
})
