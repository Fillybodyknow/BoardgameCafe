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
    window.location.hash = '#/t/qr-v1' // B1 มี visit v-1 เปิดอยู่
    render(<App />)

    expect(await screen.findByText('คุณชื่ออะไร')).toBeTruthy()
    expect(screen.queryByText('อเมริกาโน่เย็น')).toBeNull()
  })

  it('ลงชื่อแล้วเข้าหน้าเมนูได้ และถูกจำไว้ในเครื่อง', async () => {
    window.location.hash = '#/t/qr-v1'
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('ชื่อเล่นก็ได้'), {
      target: { value: 'คุณใหม่' },
    })
    fireEvent.click(screen.getByText('เริ่มสั่งของ'))

    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()
    expect(myPass('qr-v1')?.displayName).toBe('คุณใหม่')
  })

  it('เครื่องที่ลงชื่อแล้วเข้าเมนูได้เลย ไม่ถามซ้ำ', async () => {
    await signedInAs('qr-v1', 'คุณเดิม')
    window.location.hash = '#/t/qr-v1'
    render(<App />)

    expect(await screen.findByText('โต๊ะ B1')).toBeTruthy()
    expect(screen.queryByText('คุณชื่ออะไร')).toBeNull()
  })

  it('ไม่ต้องล็อกอิน — ไม่เจอหน้าเข้าสู่ระบบ', async () => {
    await signedInAs('qr-v1', 'คุณไม่ล็อกอิน')
    window.location.hash = '#/t/qr-v1'
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
    await signedInAs('qr-v1', 'คุณตะกร้า')
    window.location.hash = '#/t/qr-v1'
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
    await signedInAs('qr-v1', 'คุณสั่ง')
    window.location.hash = '#/t/qr-v1'
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
    const me = await signedInAs('qr-v1', 'คุณเจ้าของเครื่อง')
    window.location.hash = '#/t/qr-v1'
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
    const b1 = await mockGuestAdapter.orders('qr-v1') // v-1
    const a2 = await mockGuestAdapter.orders('qr-v2') // v-2
    expect(b1.length).toBeGreaterThan(0)
    expect(a2.length).toBeGreaterThan(0)
    const overlap = b1.filter((o) => a2.some((x) => x.id === o.id))
    expect(overlap).toHaveLength(0)
  })

  it('ใช้ QR โต๊ะหนึ่ง สั่งให้คนอีกโต๊ะไม่ได้', async () => {
    const other = (await mockAdapter.getSnapshot()).passes.find((p) => p.visitId === 'v-2')!
    await expect(
      mockGuestAdapter.placeOrder({
        token: 'qr-v1', // โต๊ะ B1 = v-1
        idempotencyKey: 'cross-1',
        orderedByPassId: other.id, // แต่สั่งในชื่อคนของ v-2
        splitMode: 'owner',
        items: [{ menuItemId: 'm-1', qty: 1 }],
      }),
    ).rejects.toThrow()
  })

  it('บิลที่เห็นเป็นของโต๊ะตัวเองเท่านั้น', async () => {
    const bill = await mockGuestAdapter.bill('qr-v1')
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
    const pass = await signedInAs('qr-v1', 'คนกดมั่ว')
    await db.voidPass(pass.passId)

    const snap = await mockAdapter.getSnapshot()
    expect(snap.passes.some((p) => p.id === pass.passId)).toBe(false)
  })

  it('คนที่สั่งของไปแล้วลบไม่ได้', async () => {
    const pass = await signedInAs('qr-v1', 'คนสั่งของ')
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
    const a = await signedInAs('qr-v1', 'คนเดิม')
    const b = await signedInAs('qr-v1', '  คนเดิม ')
    expect(b.passId).toBe(a.passId)
  })

  it('ลงชื่อตอนโต๊ะยังไม่เปิดไม่ได้', async () => {
    await expect(mockGuestAdapter.register('qr-a3', 'คนมาก่อน')).rejects.toThrow(/ยังไม่ได้เปิด/)
  })
})

/**
 * QR ต่อรอบ — เปิดโต๊ะหนึ่งครั้งได้ QR ใหม่หนึ่งใบ (migration 1800)
 * ฝั่ง SQL ทดสอบกติกาเดียวกันไว้ใน supabase/tests/30_guest_test.sql
 */
describe('QR ต่อรอบ', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('เปิดโต๊ะแล้วได้ QR ของรอบนี้ ใช้ได้ทันที และคนละใบกับรอบอื่น', async () => {
    const a = await db.openVisit({ tableIds: ['t-a3'], guests: [{ name: 'ก', ratePlanId: '11111111-0000-4000-8000-000000000001' }] })
    const b = await db.openVisit({ tableIds: ['t-b2'], guests: [{ name: 'ข', ratePlanId: '11111111-0000-4000-8000-000000000001' }] })
    expect(a.qrToken).toBeTruthy()
    expect(a.qrToken).not.toBe(b.qrToken)
    expect((await mockGuestAdapter.session(a.qrToken!)).visitId).toBe(a.id)
  })

  // ★ เหตุผลหลักของการเปลี่ยน: QR ที่ลูกค้าเก่าถ่ายรูปไว้ ต้องเข้าบิลคนใหม่ไม่ได้
  it('สติกเกอร์ QR ติดโต๊ะแบบเก่า เข้าบิลของคนที่นั่งอยู่ไม่ได้', async () => {
    const s = await mockGuestAdapter.session('qr-b1') // B1 มี v-1 นั่งอยู่
    expect(s.visitId).toBeNull()
    expect(s.ended).toBe(false)
    await expect(mockGuestAdapter.register('qr-b1', 'คนนอกร้าน')).rejects.toThrow()
  })

  it('ย้ายโต๊ะแล้ว QR ใบเดิมตามกลุ่มไป ไม่ต้องพิมพ์ใหม่', async () => {
    await db.moveVisitToTables('v-1', ['t-a3'])
    const s = await mockGuestAdapter.session('qr-v1')
    expect(s.visitId).toBe('v-1')
    expect(s.tableCode).toBe('A3')
  })

  it('ปิดบิลแล้ว QR ใช้ไม่ได้ และหน้าจอบอกว่ารอบนี้จบแล้ว', async () => {
    await db.closeVisit('v-1')
    await expect(mockGuestAdapter.register('qr-v1', 'มาทีหลัง')).rejects.toThrow()

    window.location.hash = '#/t/qr-v1'
    render(<App />)
    expect(await screen.findByText('รอบนี้ปิดบิลแล้ว')).toBeTruthy()
    expect(screen.queryByText('ส่งเข้าครัว')).toBeNull()
  })

  it('ออก QR ใหม่แล้ว ใบเดิมใช้ไม่ได้ทันที', async () => {
    const fresh = await db.rotateVisitToken('v-1')
    expect(fresh).not.toBe('qr-v1')
    await expect(mockGuestAdapter.session('qr-v1')).rejects.toThrow(/ใช้ไม่ได้/)
    expect((await mockGuestAdapter.session(fresh)).visitId).toBe('v-1')
  })

  it('เปิดโต๊ะจากผังโต๊ะแล้วขึ้นใบ QR ให้พิมพ์ทันที', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('A3'))
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดโต๊ะ' }))
    expect(await screen.findByText('เปิดโต๊ะ A3 แล้ว')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'พิมพ์ใบ QR' })).toBeTruthy()
  })
})

/**
 * เคสที่เจอจริง: จอง 4 คน เช็คอินโดยไม่พิมพ์ชื่อ → "ผู้เล่น 1–4"
 * ลูกค้าสแกนแล้วลงชื่อ ระบบเคยสร้างคนที่ 5 แทนที่จะเป็นหนึ่งใน 4 คนนั้น
 * ฝั่ง SQL: supabase/tests/98_claim_pass_test.sql
 */
describe('รับชื่อที่พนักงานสร้างไว้ตอนเปิดโต๊ะ', () => {
  const STD = '11111111-0000-4000-8000-000000000001'

  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  async function checkedInFour() {
    return await db.openVisit({
      tableIds: ['t-a3'],
      guests: [1, 2, 3, 4].map((n) => ({ name: `ผู้เล่น ${n}`, ratePlanId: STD })),
    })
  }

  it('แตะชื่อตัวเองแล้วใส่ชื่อจริง — โต๊ะยังมี 4 คน ไม่ใช่ 5', async () => {
    const visit = await checkedInFour()
    window.location.hash = `#/t/${visit.qrToken}`
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'ผู้เล่น 2' }))
    const ok = screen.getByRole('button', { name: 'ใช่ ฉันเอง' }) as HTMLButtonElement
    expect(ok.disabled).toBe(true) // ชื่อชั่วคราว ต้องใส่ชื่อจริงก่อน

    fireEvent.change(screen.getByPlaceholderText('ชื่อที่จะให้เพื่อนเห็น'), { target: { value: 'แนน' } })
    fireEvent.click(ok)

    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()
    const snap = await mockAdapter.getSnapshot()
    const passes = snap.passes.filter((p) => p.visitId === visit.id)
    expect(passes).toHaveLength(4)
    expect(passes.map((p) => p.displayName)).toContain('แนน')
    expect(myPass(visit.qrToken!)?.displayName).toBe('แนน')
  })

  it('ชื่อที่มีคนรับไปแล้ว ไม่ขึ้นให้เครื่องอื่นเลือกอีก', async () => {
    const visit = await checkedInFour()
    const p1 = (await mockAdapter.getSnapshot()).passes.find(
      (p) => p.visitId === visit.id && p.displayName === 'ผู้เล่น 1',
    )!
    await mockGuestAdapter.claim(visit.qrToken!, p1.id, 'ต้น')

    window.location.hash = `#/t/${visit.qrToken}`
    render(<App />)
    await screen.findByRole('button', { name: 'ผู้เล่น 2' })
    expect(screen.queryByRole('button', { name: 'ต้น' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ผู้เล่น 1' })).toBeNull()
  })

  it('ไม่มีชื่อตัวเองในรายการ ก็ยังลงชื่อใหม่ได้เหมือนเดิม', async () => {
    const visit = await checkedInFour()
    window.location.hash = `#/t/${visit.qrToken}`
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('ชื่อเล่นก็ได้'), { target: { value: 'มาเพิ่ม' } })
    fireEvent.click(screen.getByText('เริ่มสั่งของ'))

    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()
    const snap = await mockAdapter.getSnapshot()
    expect(snap.passes.filter((p) => p.visitId === visit.id)).toHaveLength(5)
  })
})

// ใบหาย/เพื่อนมาทีหลัง — สแกน QR จากจอคนในโต๊ะได้ ไม่ต้องไปขอที่เคาน์เตอร์
describe('QR โต๊ะบนจอลูกค้า', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('กดปุ่ม QR แล้วเห็น QR ของรอบนี้ให้เพื่อนสแกน', async () => {
    await signedInAs('qr-v1', 'คุณมีมือถือ')
    window.location.hash = '#/t/qr-v1'
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'QR โต๊ะให้เพื่อนสแกน' }))

    const qr = await screen.findByRole('img', { name: 'QR โต๊ะ B1' })
    await waitFor(() => expect(qr.querySelector('svg')).toBeTruthy())
    expect(screen.getByText(/ใช้ได้เฉพาะรอบนี้/)).toBeTruthy()
  })
})
