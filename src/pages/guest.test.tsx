// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { mockAdapter, mockGuestAdapter } from '../data/mock/mockAdapter'

/**
 * หน้าลูกค้าที่สแกน QR
 *
 * โจทย์หลักไม่ใช่ว่าสั่งของได้ไหม แต่คือ "ถือ QR โต๊ะหนึ่ง แตะโต๊ะอื่นได้ไหม"
 * ฝั่ง SQL ทดสอบไว้แล้วใน supabase/tests/30_guest_test.sql ที่นี่ตรวจฝั่งหน้าจอ
 */
describe('ลูกค้าสแกน QR', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('โต๊ะที่เปิดอยู่ เห็นเมนูและรายชื่อคนในโต๊ะ', async () => {
    window.location.hash = '#/t/qr-b1' // B1 มี visit v-1 เปิดอยู่
    render(<App />)

    expect(await screen.findByText('โต๊ะ B1')).toBeTruthy()
    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()

    const select = document.querySelector('select') as HTMLSelectElement
    const names = [...select.options].map((o) => o.textContent)
    expect(names).toContain('ต้น')
    // คนที่กลับไปแล้วต้องไม่อยู่ในรายการให้เลือก
    expect(names).not.toContain('บอส')
  })

  it('ไม่ต้องล็อกอิน — ไม่เจอหน้าเข้าสู่ระบบ', async () => {
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
