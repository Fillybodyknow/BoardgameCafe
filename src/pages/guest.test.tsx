// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { mockAdapter, mockGuestAdapter } from '../data/mock/mockAdapter'
import { db } from '../data'
import { myPass, rememberMyPass } from '../lib/myPass'

/**
 * หน้าลูกค้าที่สแกน QR
 *
 * โจทย์หลักไม่ใช่ว่าสั่งของได้ไหม แต่คือ "ถือ QR โต๊ะหนึ่ง แตะโต๊ะอื่นได้ไหม"
 * ฝั่ง SQL ทดสอบไว้แล้วใน supabase/tests/30_guest_test.sql ที่นี่ตรวจฝั่งหน้าจอ
 */
/**
 * ลงชื่อไว้ล่วงหน้าเหมือนเครื่องที่เคยสแกนมาแล้ว
 *
 * ของจริงลูกค้าลงชื่อครั้งแรกครั้งเดียว เทสต์ที่สนใจเรื่องอื่นจึงข้ามขั้นนี้ไป
 */
async function signedInAs(token: string, name: string) {
  const pass = await mockGuestAdapter.register(token, name)
  rememberMyPass(token, pass)
  return pass
}

describe('ลูกค้าสแกน QR', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('ยังไม่เคยลงชื่อ ต้องถามชื่อก่อนถึงจะเห็นเมนู', async () => {
    window.location.hash = '#/t/qr-b1' // B1 มี visit v-1 เปิดอยู่
    render(<App />)

    expect(await screen.findByText('คุณชื่ออะไร')).toBeTruthy()
    expect(screen.queryByText('อเมริกาโน่เย็น')).toBeNull()
  })

  it('ลงชื่อแล้วเข้าหน้าเมนูได้ และถูกจำไว้ในเครื่อง', async () => {
    window.location.hash = '#/t/qr-b1'
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('ชื่อเล่นก็ได้'), {
      target: { value: 'คุณใหม่' },
    })
    fireEvent.click(screen.getByText('เริ่มสั่งของ'))

    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()
    expect(myPass('qr-b1')?.displayName).toBe('คุณใหม่')
  })

  it('เครื่องที่ลงชื่อแล้วเข้าเมนูได้เลย ไม่ถามซ้ำ', async () => {
    await signedInAs('qr-b1', 'คุณเดิม')
    window.location.hash = '#/t/qr-b1'
    render(<App />)

    expect(await screen.findByText('โต๊ะ B1')).toBeTruthy()
    expect(screen.queryByText('คุณชื่ออะไร')).toBeNull()
  })

  it('ไม่ต้องล็อกอิน — ไม่เจอหน้าเข้าสู่ระบบ', async () => {
    await signedInAs('qr-b1', 'คุณไม่ล็อกอิน')
    window.location.hash = '#/t/qr-b1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')
    expect(screen.queryByText(/เข้าสู่ระบบพนักงาน/)).toBeNull()
  })

  it('โต๊ะที่ยังไม่เปิด บอกให้ไปหาพนักงาน ไม่ให้สั่ง', async () => {
    window.location.hash = '#/t/qr-a3' // A3 ว่าง
    render(<App />)
    expect(await screen.findByText('ยังไม่ได้เปิดโต๊ะ')).toBeTruthy()
    expect(screen.queryByText('ส่งเข้าครัว')).toBeNull()
  })

  it('QR มั่วใช้ไม่ได้', async () => {
    window.location.hash = '#/t/ไม่มีอยู่จริง'
    render(<App />)
    expect(await screen.findByText('QR นี้ใช้ไม่ได้')).toBeTruthy()
  })

  // เคสที่เจอหน้าร้าน: เลือก 2 เมนู อย่างละชิ้น แล้วสั่งไม่ได้
  // เพราะเคยกด + แล้วกด − ใส่เมนูอีกอัน ทำให้เหลือรายการ qty=0 ค้างในตะกร้า
  // หน้าจอยังขึ้นว่า 2 รายการ (0 ไม่ถูกนับ) ลูกค้าจึงเดาไม่ออกว่าอะไรผิด
  it('กดเพิ่มแล้วกดลดจนเหลือศูนย์ ต้องไม่ทำให้สั่งทั้งออเดอร์ไม่ได้', async () => {
    await signedInAs('qr-b1', 'คุณตะกร้า')
    window.location.hash = '#/t/qr-b1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')

    const before = (await mockAdapter.getSnapshot()).orders.length
    const plus = screen.getAllByRole('button', { name: 'เพิ่ม' })

    fireEvent.click(plus[0]!) // เมนู 1
    fireEvent.click(plus[1]!) // เมนู 2
    fireEvent.click(plus[2]!) // เมนู 3 แล้วเปลี่ยนใจ

    // ปุ่มลดจะโผล่เฉพาะรายการที่มีจำนวน > 0 ตอนนี้จึงมี 3 ปุ่ม
    const minus = await screen.findAllByRole('button', { name: 'ลด' })
    expect(minus).toHaveLength(3)
    fireEvent.click(minus[2]!) // เอาเมนู 3 ออกจนเหลือ 0

    fireEvent.click(await screen.findByText('ส่งเข้าครัว'))

    await waitFor(async () => {
      const snap = await mockAdapter.getSnapshot()
      expect(snap.orders.length).toBe(before + 1)
      const created = snap.orders[snap.orders.length - 1]!
      // ต้องส่งไปแค่ 2 รายการ และต้องไม่มี qty 0 ติดไปด้วย
      expect(created.lines).toHaveLength(2)
      expect(created.lines.every((l) => l.qty > 0)).toBe(true)
    })
  })

  it('สั่งของแล้วเข้าครัวทันที และผูกกับโต๊ะที่สแกน', async () => {
    await signedInAs('qr-b1', 'คุณสั่ง')
    window.location.hash = '#/t/qr-b1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')

    const before = (await mockAdapter.getSnapshot()).orders.length
    fireEvent.click(screen.getAllByText('+')[0]!)
    fireEvent.click(await screen.findByText('ส่งเข้าครัว'))

    await waitFor(async () => {
      const snap = await mockAdapter.getSnapshot()
      expect(snap.orders.length).toBe(before + 1)
      const created = snap.orders[snap.orders.length - 1]!
      expect(created.placedBy).toBe('guest')
      expect(created.visitId).toBe('v-1') // visit ของโต๊ะ B1
      expect(created.status).toBe('placed')
    })
  })

  // ★ หัวใจของการให้แต่ละเครื่องลงชื่อเอง: ไม่ต้องเลือกชื่อตอนสั่งอีก
  // และออเดอร์ลงชื่อเจ้าของเครื่องเสมอ ไม่มีทางลงผิดคน
  it('ออเดอร์ลงชื่อเจ้าของเครื่องเอง ไม่ต้องเลือก', async () => {
    const me = await signedInAs('qr-b1', 'คุณเจ้าของเครื่อง')
    window.location.hash = '#/t/qr-b1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')

    fireEvent.click(screen.getAllByText('+')[0]!)
    fireEvent.click(await screen.findByText('ส่งเข้าครัว'))

    await waitFor(async () => {
      const snap = await mockAdapter.getSnapshot()
      const created = snap.orders[snap.orders.length - 1]!
      expect(created.orderedByPassId).toBe(me.passId)
      expect(created.splitMode).toBe('owner')
    })
  })
})

describe('ขอบเขตของ token (ระดับ adapter)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  it('เห็นออเดอร์เฉพาะโต๊ะตัวเอง', async () => {
    const b1 = await mockGuestAdapter.orders('qr-b1') // v-1
    const a2 = await mockGuestAdapter.orders('qr-a2') // v-2
    expect(b1.length).toBeGreaterThan(0)
    expect(a2.length).toBeGreaterThan(0)
    const overlap = b1.filter((o) => a2.some((x) => x.id === o.id))
    expect(overlap).toHaveLength(0)
  })

  it('ใช้ QR โต๊ะหนึ่ง สั่งให้คนอีกโต๊ะไม่ได้', async () => {
    const other = (await mockAdapter.getSnapshot()).passes.find((p) => p.visitId === 'v-2')!
    await expect(
      mockGuestAdapter.placeOrder({
        token: 'qr-b1', // โต๊ะ B1 = v-1
        idempotencyKey: 'cross-1',
        orderedByPassId: other.id, // แต่สั่งในชื่อคนของ v-2
        splitMode: 'owner',
        items: [{ menuItemId: 'm-1', qty: 1 }],
      }),
    ).rejects.toThrow()
  })

  it('บิลที่เห็นเป็นของโต๊ะตัวเองเท่านั้น', async () => {
    const bill = await mockGuestAdapter.bill('qr-b1')
    expect(bill.visitId).toBe('v-1')
  })

  it('โต๊ะที่ยังไม่เปิด สั่งของไม่ได้', async () => {
    await expect(
      mockGuestAdapter.placeOrder({
        token: 'qr-a3',
        idempotencyKey: 'empty-1',
        orderedByPassId: null,
        splitMode: 'shared',
        items: [{ menuItemId: 'm-1', qty: 1 }],
      }),
    ).rejects.toThrow()
  })
})

/**
 * ลบคนที่ลงชื่อผิด
 *
 * เปิดให้ลูกค้าสร้างคนเองแล้ว ต้องมีทางเก็บกวาดด้วย ไม่งั้นชื่อซ้ำ/ชื่อเล่น
 * ของเล่นจะค้างอยู่ในบิล — check_out_pass ใช้แทนไม่ได้เพราะยังคิดเงิน
 */
describe('ลบคนที่ลงชื่อผิด', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
  })

  it('พนักงานลบคนที่เพิ่งลงชื่อออกได้', async () => {
    const pass = await signedInAs('qr-b1', 'คนกดมั่ว')
    await db.voidPass(pass.passId)

    const snap = await mockAdapter.getSnapshot()
    expect(snap.passes.some((p) => p.id === pass.passId)).toBe(false)
  })

  it('คนที่สั่งของไปแล้วลบไม่ได้', async () => {
    const pass = await signedInAs('qr-b1', 'คนสั่งของ')
    const snap = await mockAdapter.getSnapshot()

    await db.placeOrder({
      idempotencyKey: 'void-guard',
      visitId: 'v-1',
      orderedByPassId: pass.passId,
      splitMode: 'owner',
      placedBy: 'staff',
      items: [{ menuItemId: snap.menu[0]!.id, qty: 1 }],
    })

    await expect(db.voidPass(pass.passId)).rejects.toThrow(/สั่งของไปแล้ว/)
  })

  it('ลงชื่อซ้ำไม่กลายเป็นสองคน', async () => {
    const a = await signedInAs('qr-b1', 'คนเดิม')
    const b = await signedInAs('qr-b1', '  คนเดิม ')
    expect(b.passId).toBe(a.passId)
  })

  it('ลงชื่อตอนโต๊ะยังไม่เปิดไม่ได้', async () => {
    await expect(mockGuestAdapter.register('qr-a3', 'คนมาก่อน')).rejects.toThrow(/ยังไม่ได้เปิด/)
  })
})
