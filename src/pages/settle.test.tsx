// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettleDialog from './SettleDialog'
import { mockAdapter } from '../data/mock/mockAdapter'
import { db } from '../data'
import type { GuestPass } from '../domain/types'

/**
 * เก็บเงินคนที่กลับก่อน — เส้นทางเต็มผ่าน adapter จริง (โหมดจำลอง)
 *
 * ไม่ stub ตัวคิดเงิน เพราะสิ่งที่อยากพิสูจน์คือ "กดปุ่มแล้วเงินถูกบันทึก
 * และยอดของคนที่เหลือลดลงจริง" ถ้า stub ไว้ก็เหลือแค่ทดสอบว่าปุ่มกดได้
 */

async function setup() {
  mockAdapter.reset()
  const snap = await db.getSnapshot()
  const visit = snap.visits.find((v) => v.status === 'open')!
  const passes = snap.passes.filter((p) => p.visitId === visit.id && p.status !== 'billed')
  return { visit, passes }
}

function open(pass: GuestPass, onSettled: (name: string) => void = () => {}) {
  return render(<SettleDialog pass={pass} onClose={() => {}} onSettled={onSettled} />)
}

afterEach(cleanup)

describe('เก็บเงินคนที่กลับก่อน', () => {
  let visitId: string
  let target: GuestPass
  let others: GuestPass[]

  beforeEach(async () => {
    const s = await setup()
    visitId = s.visit.id
    target = s.passes[0]!
    others = s.passes.slice(1)
  })

  it('แสดงยอดที่คิดจากเซิร์ฟเวอร์ ไม่ใช่คิดเองในหน้าจอ', async () => {
    const expected = await db.passSettlement(target.id)
    open(target)

    await waitFor(() => {
      expect(screen.getByText(`฿${expected.total.toFixed(2)}`)).toBeTruthy()
    })
  })

  it('กดรับเงินแล้วคนนั้นถูกตีตราว่าจ่ายแล้ว', async () => {
    let settledName = ''
    open(target, (n) => (settledName = n))

    await waitFor(() => screen.getByText('รับเงินแล้วให้กลับได้'))
    fireEvent.click(screen.getByText('รับเงินแล้วให้กลับได้'))

    await waitFor(() => expect(settledName).toBe(target.displayName))

    const snap = await db.getSnapshot()
    expect(snap.passes.find((p) => p.id === target.id)!.status).toBe('billed')
  })

  // ★ หัวใจของฟีเจอร์: เก็บเงินคนหนึ่งแล้วยอดของโต๊ะต้องลดลงเท่าที่เก็บไป
  it('ยอดที่เหลือของโต๊ะลดลงเท่ากับที่เก็บไป', async () => {
    const before = await db.previewBill(visitId)
    const calc = await db.passSettlement(target.id)

    await db.settlePass(target.id, [{ method: 'cash', amount: calc.total }])

    const after = await db.previewBill(visitId)
    expect(after.total).toBeCloseTo(before.total - calc.total, 2)
  })

  it('คนที่เหลือยังเล่นต่อได้ โต๊ะไม่ถูกปิด', async () => {
    const calc = await db.passSettlement(target.id)
    await db.settlePass(target.id, [{ method: 'cash', amount: calc.total }])

    const snap = await db.getSnapshot()
    expect(snap.visits.find((v) => v.id === visitId)!.status).toBe('open')
    for (const o of others) {
      expect(snap.passes.find((p) => p.id === o.id)!.status).not.toBe('billed')
    }
  })

  it('เก็บเงินคนเดิมซ้ำไม่ได้', async () => {
    const calc = await db.passSettlement(target.id)
    await db.settlePass(target.id, [{ method: 'cash', amount: calc.total }])

    await expect(db.settlePass(target.id, [])).rejects.toThrow(/ชำระเงินไปแล้ว/)
  })

  it('คนที่จ่ายแล้วสั่งของเพิ่มไม่ได้', async () => {
    const calc = await db.passSettlement(target.id)
    await db.settlePass(target.id, [{ method: 'cash', amount: calc.total }])

    const snap = await db.getSnapshot()
    await expect(
      db.placeOrder({
        idempotencyKey: 'after-settle',
        visitId,
        orderedByPassId: target.id,
        splitMode: 'owner',
        placedBy: 'staff',
        items: [{ menuItemId: snap.menu[0]!.id, qty: 1 }],
      }),
    ).rejects.toThrow()
  })
})
