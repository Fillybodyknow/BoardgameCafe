// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { adminDb, db, mockAdapter } from '../data'

/**
 * VAT ที่เจ้าของร้านตั้งไว้ ต้องมีผลกับตัวเลขที่พนักงานเห็นด้วย
 *
 * เคยพังจริง: หน้าผังโต๊ะกับหน้าโต๊ะคิดบิลเองฝั่ง client ด้วยค่า VAT 7%
 * ที่เขียนตายตัวในโค้ด ส่วนฐานข้อมูลใช้ค่าที่ตั้งไว้จริง สองฝั่งจึงได้
 * คนละเลข — พนักงานเก็บเงินตามจอ แล้วบิลที่บันทึกเป็นอีกยอด
 */
const baht = (n: number) =>
  n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

describe('ค่า VAT ที่ตั้งไว้ มีผลกับทุกจอ', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('เปลี่ยนเป็น VAT แยกนอกราคา ยอดสุทธิต้องสูงขึ้น', async () => {
    const before = await db.previewBill('v-1')

    await adminDb.saveTaxConfig({ serviceChargeRate: 0, vatRate: 0.1, vatIncluded: false })
    const after = await db.previewBill('v-1')

    expect(after.subtotal).toBe(before.subtotal)
    expect(after.total).toBeCloseTo(Number((before.subtotal * 1.1).toFixed(2)), 2)
    expect(after.total).toBeGreaterThan(before.total)
  })

  it('ค่าบริการที่ตั้งไว้ถูกบวกเข้าไปด้วย', async () => {
    const before = await db.previewBill('v-1')

    await adminDb.saveTaxConfig({ serviceChargeRate: 0.1, vatRate: 0, vatIncluded: false })
    const after = await db.previewBill('v-1')

    expect(after.serviceCharge).toBeCloseTo(Number((before.subtotal * 0.1).toFixed(2)), 2)
  })

  it('ป้าย VAT บนหน้าโต๊ะบอกอัตราที่ตั้งไว้จริง ไม่ใช่ 7% ตายตัว', async () => {
    await adminDb.saveTaxConfig({ serviceChargeRate: 0, vatRate: 0.12, vatIncluded: true })

    window.location.hash = '#/visit/v-1'
    render(<App />)

    expect(await screen.findByText(/VAT 12%/)).toBeTruthy()
    expect(screen.queryByText(/VAT 7%/)).toBeNull()
  })

  // ★ ตัวเลขบนจอต้องเป็นตัวเดียวกับที่ฐานข้อมูลจะคิดตอนปิดบิล
  // ไม่ใช่แค่ป้ายถูกแต่ยอดผิด — พนักงานเก็บเงินตามจอ
  it('ยอดบนหน้าโต๊ะตรงกับยอดที่เซิร์ฟเวอร์คิด เมื่อ VAT ไม่ใช่ค่าตั้งต้น', async () => {
    await adminDb.saveTaxConfig({ serviceChargeRate: 0.1, vatRate: 0.1, vatIncluded: false })
    const server = await db.previewBill('v-1')

    window.location.hash = '#/visit/v-1'
    render(<App />)

    await waitFor(() => {
      const shown = screen.getAllByText(/^฿[\d,]+\.\d{2}$/).map((el) => el.textContent)
      expect(shown).toContain(`฿${baht(server.total)}`)
    })
  })

  // ★ ยอดบนหน้าโต๊ะมาจากการคิดฝั่ง client — ต้องหักส่วนที่คนกลับก่อนจ่ายไปแล้ว
  // ไม่งั้นพนักงานจะเก็บเงินเกิน เพราะหน้าจอยังโชว์ยอดเต็ม
  it('หลังเก็บเงินคนที่กลับก่อน ยอดบนหน้าโต๊ะลดลงตาม', async () => {
    const snap = await db.getSnapshot()
    const target = snap.passes.find((p) => p.visitId === 'v-1' && p.status === 'active')!

    const before = await db.previewBill('v-1')
    const calc = await db.passSettlement(target.id)
    await db.settlePass(target.id, [{ method: 'cash', amount: calc.total }])

    window.location.hash = '#/visit/v-1'
    render(<App />)

    const expected = Number((before.total - calc.total).toFixed(2))
    await waitFor(() => {
      const shown = screen.getAllByText(/^฿[\d,]+\.\d{2}$/).map((el) => el.textContent)
      expect(shown).toContain(`฿${baht(expected)}`)
    })
  })
})

/** กันไม่ให้หน้าตั้งค่ารับอัตราที่เป็นไปไม่ได้ */
describe('ขอบเขตของค่าที่ตั้งได้', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
  })

  it('บันทึกแล้วอ่านกลับได้ค่าเดิม', async () => {
    await adminDb.saveTaxConfig({ serviceChargeRate: 0.05, vatRate: 0.07, vatIncluded: false })
    expect(await adminDb.taxConfig()).toEqual({
      serviceChargeRate: 0.05,
      vatRate: 0.07,
      vatIncluded: false,
    })
  })
})

