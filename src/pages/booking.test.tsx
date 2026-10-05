// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { mockAdapter, mockBookingAdapter } from '../data/mock/mockAdapter'
import { mockAdminAdapter } from '../data/mock/adminAdapter'
import { forgetBooking, myBookings, rememberBooking } from '../lib/myBookings'

/** พรุ่งนี้ 18:00 เวลาไทย — ต้องเป็นอนาคตเสมอ ไม่งั้นติดกติกาจองล่วงหน้า */
function tomorrowAt(hhmm: string): string {
  const d = new Date(Date.now() + 24 * 3600_000 + 7 * 3600_000)
  return new Date(`${d.toISOString().slice(0, 10)}T${hhmm}:00+07:00`).toISOString()
}

async function freeTable(startAt: string, duration = 120) {
  const tables = await mockBookingAdapter.availableTables(startAt, duration)
  return tables.find((t) => t.available && !t.allowShare)!
}

describe('จองโต๊ะออนไลน์ (ระดับ adapter)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  it('จองสำเร็จแล้วได้รหัส 6 ตัว ไม่มีอักขระที่สับสน', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const r = await mockBookingAdapter.create({
      customerName: 'คุณเทส', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    expect(r.code).toHaveLength(6)
    expect(r.code).not.toMatch(/[01OI]/)
    expect(r.status).toBe('pending')
    expect(r.tables).toContain(t.code)
  })

  it('โต๊ะที่จองแล้วขึ้นว่าไม่ว่างทันที', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    await mockBookingAdapter.create({
      customerName: 'ก', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    const after = await mockBookingAdapter.availableTables(startAt, 120)
    expect(after.find((x) => x.id === t.id)!.available).toBe(false)
  })

  it('จองทับเวลาเดิมไม่ได้', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    await mockBookingAdapter.create({
      customerName: 'ก', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    await expect(
      mockBookingAdapter.create({
        customerName: 'ข', phone: '082-222-3333', partySize: 2,
        startAt, durationMinutes: 120, tableIds: [t.id],
      }),
    ).rejects.toThrow(/ไม่ว่าง/)
  })

  it('เว้นเวลาเก็บโต๊ะระหว่างรอบ (buffer)', async () => {
    const startAt = tomorrowAt('14:00')
    const t = await freeTable(startAt)
    await mockBookingAdapter.create({
      customerName: 'ก', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    // รอบเดิมจบ 16:00 — จอง 16:05 ต้องติด buffer 15 นาที
    await expect(
      mockBookingAdapter.create({
        customerName: 'ข', phone: '082-222-3333', partySize: 2,
        startAt: tomorrowAt('16:05'), durationMinutes: 120, tableIds: [t.id],
      }),
    ).rejects.toThrow()

    // 17:00 ห่างพอแล้ว จองได้
    const ok = await mockBookingAdapter.create({
      customerName: 'ค', phone: '083-333-4444', partySize: 2,
      startAt: tomorrowAt('17:00'), durationMinutes: 120, tableIds: [t.id],
    })
    expect(ok.code).toHaveLength(6)
  })

  it('จองเกินจำนวนที่นั่งไม่ได้', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    await expect(
      mockBookingAdapter.create({
        customerName: 'ก', phone: '081-111-2222', partySize: t.seatMax + 5,
        startAt, durationMinutes: 120, tableIds: [t.id],
      }),
    ).rejects.toThrow(/นั่งได้/)
  })

  it('ข้อมูลไม่ครบจองไม่ได้', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const base = { partySize: 2, startAt, durationMinutes: 120, tableIds: [t.id] }
    await expect(
      mockBookingAdapter.create({ ...base, customerName: '', phone: '0811112222' }),
    ).rejects.toThrow(/ชื่อ/)
    await expect(
      mockBookingAdapter.create({ ...base, customerName: 'ก', phone: '123' }),
    ).rejects.toThrow(/เบอร/)
    await expect(
      mockBookingAdapter.create({ ...base, customerName: 'ก', phone: '0811112222', tableIds: [] }),
    ).rejects.toThrow(/โต๊ะ/)
  })

  it('เปิดดูต้องใช้ทั้งรหัสและเบอร์ — รหัสอย่างเดียวไม่พอ', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const r = await mockBookingAdapter.create({
      customerName: 'คุณเทส', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })

    const found = await mockBookingAdapter.lookup(r.code, '0811112222')
    expect(found.customerName).toBe('คุณเทส')

    await expect(mockBookingAdapter.lookup(r.code, '099-999-9999')).rejects.toThrow()
  })

  it('ยกเลิกเองได้ แล้วโต๊ะกลับมาว่าง', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const r = await mockBookingAdapter.create({
      customerName: 'ก', phone: '081-111-2222', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    await mockBookingAdapter.cancel(r.code, '081-111-2222')

    const after = await mockBookingAdapter.availableTables(startAt, 120)
    expect(after.find((x) => x.id === t.id)!.available).toBe(true)
    await expect(mockBookingAdapter.cancel(r.code, '081-111-2222')).rejects.toThrow()
  })
})

// เคยเป็นบั๊ก: หน้าจอง hardcode 11:00–23:00 ไว้ ไม่ได้อ่าน shop_hours
// พอเจ้าของแก้เวลาทำการ หน้าจองยังเสนอเวลาเดิมที่เซิร์ฟเวอร์จะปฏิเสธ
describe('หน้าจองต้องเคารพเวลาทำการที่เจ้าของตั้งไว้', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  it('เวลาทำการที่เจ้าของบันทึก ต้องเป็นชุดเดียวกับที่หน้าจองอ่าน', async () => {
    await mockAdminAdapter.saveShopHours({
      weekday: 3, openTime: '14:00', closeTime: '22:00', closed: false,
      kitchenCloseTime: null,
    })
    const hours = await mockBookingAdapter.hours()
    expect(hours.find((h) => h.weekday === 3)).toEqual({
      weekday: 3, openTime: '14:00', closeTime: '22:00', closed: false,
      kitchenCloseTime: null,
    })
  })

  it('จองก่อนเวลาเปิดของวันนั้นไม่ได้', async () => {
    const target = new Date(Date.now() + 3 * 24 * 3600_000 + 7 * 3600_000)
    const weekday = target.getUTCDay()
    const day = target.toISOString().slice(0, 10)

    await mockAdminAdapter.saveShopHours({
      weekday, openTime: '16:00', closeTime: '23:00', closed: false,
      kitchenCloseTime: null,
    })

    const early = new Date(`${day}T12:00:00+07:00`).toISOString()
    const t = await freeTable(early)
    await expect(
      mockBookingAdapter.create({
        customerName: 'ก', phone: '081-111-2222', partySize: 2,
        startAt: early, durationMinutes: 120, tableIds: [t.id],
      }),
    ).rejects.toThrow(/16:00/)

    // หลังเวลาเปิดแล้วจองได้
    const ok = new Date(`${day}T17:00:00+07:00`).toISOString()
    const t2 = await freeTable(ok)
    const r = await mockBookingAdapter.create({
      customerName: 'ข', phone: '082-222-3333', partySize: 2,
      startAt: ok, durationMinutes: 120, tableIds: [t2.id],
    })
    expect(r.code).toHaveLength(6)
  })

  it('วันที่ร้านปิด จองไม่ได้', async () => {
    const target = new Date(Date.now() + 4 * 24 * 3600_000 + 7 * 3600_000)
    const weekday = target.getUTCDay()
    const day = target.toISOString().slice(0, 10)

    await mockAdminAdapter.saveShopHours({
      weekday, openTime: '11:00', closeTime: '23:00', closed: true,
      kitchenCloseTime: null,
    })

    const when = new Date(`${day}T18:00:00+07:00`).toISOString()
    const t = await freeTable(when)
    await expect(
      mockBookingAdapter.create({
        customerName: 'ก', phone: '081-111-2222', partySize: 2,
        startAt: when, durationMinutes: 120, tableIds: [t.id],
      }),
    ).rejects.toThrow(/ร้านปิด/)
  })

  it('ต้องเล่นจบก่อนร้านปิด', async () => {
    const target = new Date(Date.now() + 5 * 24 * 3600_000 + 7 * 3600_000)
    const weekday = target.getUTCDay()
    const day = target.toISOString().slice(0, 10)

    await mockAdminAdapter.saveShopHours({
      weekday, openTime: '11:00', closeTime: '20:00', closed: false,
      kitchenCloseTime: null,
    })

    const when = new Date(`${day}T19:00:00+07:00`).toISOString()
    const t = await freeTable(when)
    await expect(
      mockBookingAdapter.create({
        customerName: 'ก', phone: '081-111-2222', partySize: 2,
        startAt: when, durationMinutes: 180, tableIds: [t.id],
      }),
    ).rejects.toThrow(/20:00/)
  })
})

describe('พนักงานจัดการคิวจอง', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  it('ยืนยันแล้วสถานะเปลี่ยน และยืนยันซ้ำไม่ได้', async () => {
    await mockAdapter.confirmReservation('r-2') // seed: pending
    const snap = await mockAdapter.getSnapshot()
    expect(snap.reservations.find((r) => r.id === 'r-2')!.status).toBe('confirmed')
    await expect(mockAdapter.confirmReservation('r-2')).rejects.toThrow()
  })

  it('เช็คอินแล้วเปิด visit จากโต๊ะที่จองไว้', async () => {
    const snap0 = await mockAdapter.getSnapshot()
    const plan = snap0.ratePlans[0]!.id
    const visit = await mockAdapter.seatReservation('r-1', [
      { name: 'แขก1', ratePlanId: plan },
      { name: 'แขก2', ratePlanId: plan },
    ])

    const snap = await mockAdapter.getSnapshot()
    const r = snap.reservations.find((x) => x.id === 'r-1')!
    expect(r.status).toBe('seated')
    expect(r.visitId).toBe(visit.id)
    expect(snap.visits.find((v) => v.id === visit.id)!.source).toBe('reservation')
    expect(snap.passes.filter((p) => p.visitId === visit.id)).toHaveLength(2)
    // C1 คือโต๊ะที่ r-1 จองไว้
    expect(snap.tables.find((t) => t.code === 'C1')!.status).toBe('occupied')
  })

  it('โต๊ะที่จองไว้ยังมีคนนั่ง ต้องบอกว่าโต๊ะไหนติด ไม่ใช่ error ดิบ', async () => {
    const snap0 = await mockAdapter.getSnapshot()
    const plan = snap0.ratePlans[0]!.id
    // r-2 จองโต๊ะ B2 — จับให้ไม่ว่างก่อน
    await mockAdapter.openVisit({ tableIds: ['t-b2'], guests: [{ name: 'กลุ่มก่อน', ratePlanId: plan }] })

    await expect(
      mockAdapter.seatReservation('r-2', [{ name: 'x', ratePlanId: plan }]),
    ).rejects.toThrow(/B2 ยังมีลูกค้าอยู่/)
  })

  it('ย้ายไปโต๊ะอื่นตอนเช็คอินได้', async () => {
    const snap0 = await mockAdapter.getSnapshot()
    const plan = snap0.ratePlans[0]!.id
    await mockAdapter.openVisit({ tableIds: ['t-b2'], guests: [{ name: 'กลุ่มก่อน', ratePlanId: plan }] })

    const visit = await mockAdapter.seatReservation(
      'r-2', [{ name: 'y', ratePlanId: plan }], ['t-a3'],
    )
    const snap = await mockAdapter.getSnapshot()
    expect(snap.tables.find((t) => t.code === 'A3')!.status).toBe('occupied')
    // บันทึกโต๊ะที่นั่งจริง ไม่ใช่โต๊ะที่จองไว้ตอนแรก
    expect(snap.reservations.find((r) => r.id === 'r-2')!.tableIds).toEqual(['t-a3'])
    expect(snap.visits.find((v) => v.id === visit.id)).toBeTruthy()
  })
})

describe('หน้าจองของลูกค้า', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('เปิดได้โดยไม่ต้องล็อกอิน และเห็นผังโต๊ะให้เลือก', async () => {
    window.location.hash = '#/book'
    render(<App />)

    expect(await screen.findByText('⚜ จองโต๊ะ')).toBeTruthy()
    expect(screen.queryByText(/เข้าสู่ระบบพนักงาน/)).toBeNull()
    await waitFor(() => expect(screen.getByText('เลือกโต๊ะ')).toBeTruthy())
    expect(await screen.findByText('A1')).toBeTruthy()
  })

  it('ยังไม่กรอกชื่อ/เบอร์/โต๊ะ ปุ่มส่งยังกดไม่ได้', async () => {
    window.location.hash = '#/book'
    render(<App />)
    const btn = (await screen.findByText('ส่งคำขอจอง')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('ค้นหาด้วยรหัสผิด ขึ้นข้อความบอก ไม่ใช่หน้าว่าง', async () => {
    window.location.hash = '#/book?m=find'
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('เช่น K7M2XQ'), {
      target: { value: 'ZZZZZZ' },
    })
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '0811112222' },
    })
    fireEvent.click(screen.getByText('ค้นหา'))

    expect(await screen.findByText(/ไม่พบรายการจอง/)).toBeTruthy()
  })

  it('ค้นหาด้วยรหัสที่ถูกต้อง เห็นรายการของตัวเอง', async () => {
    window.location.hash = '#/book?m=find'
    render(<App />)

    fireEvent.change(await screen.findByPlaceholderText('เช่น K7M2XQ'), {
      target: { value: 'K7M2XQ' },
    })
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '081-234-5678' },
    })
    fireEvent.click(screen.getByText('ค้นหา'))

    expect(await screen.findByText('คุณแนน')).toBeTruthy()
    expect(screen.getByText('ยืนยันแล้ว')).toBeTruthy()
  })
})

/**
 * จำการจองไว้บนเครื่องที่กดจอง
 *
 * ลูกค้าบ่นว่าจองเสร็จแล้วยังต้องกรอกรหัส + เบอร์โทรใหม่เพื่อกลับมาดู
 * ทั้งที่เพิ่งจองจากเครื่องนี้เอง — จำให้เฉพาะเครื่องที่จอง เครื่องอื่น
 * ยังต้องกรอกเหมือนเดิม จึงไม่ได้ลดความปลอดภัยลง
 */
describe('จำการจองไว้บนเครื่องนี้', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('หน้าจองไม่มีช่องเลือกจำนวนชั่วโมงแล้ว', async () => {
    window.location.hash = '#/book'
    render(<App />)
    await screen.findByText(/กี่คน/)
    expect(screen.queryByText('เล่นกี่ชั่วโมง')).toBeNull()
  })

  /*
    ร้านไม่รู้จริง ๆ ว่าลูกค้าจะเล่นถึงกี่โมง สิ่งที่รู้แน่คือเวลาเริ่ม
    ใบจองจึงบอกแค่เวลาเริ่ม ไม่โฆษณาเวลาจบที่ไม่ได้บังคับจริง
    (ระบบยังกันโต๊ะตามรอบมาตรฐานอยู่เบื้องหลัง เพื่อไม่ให้จองทับกัน)
  */
  it('ใบจองบอกแค่เวลาเริ่ม ไม่มีทั้งระยะเวลาและเวลาจบ', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const made = await mockBookingAdapter.create({
      customerName: 'คุณช่วงเวลา', phone: '081-777-0000', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    rememberBooking({ code: made.code, phone: '081-777-0000', startAt: made.startAt })

    window.location.hash = '#/book?m=find'
    render(<App />)
    fireEvent.click(await screen.findByText(made.code))

    await screen.findByText('คุณช่วงเวลา')
    expect(screen.queryByText('ระยะเวลา')).toBeNull()
    expect(screen.queryByText(/–20:00/)).toBeNull()
    expect(screen.getAllByText(/18:00/).length).toBeGreaterThan(0)
  })

  it('ยังไม่เคยจอง ต้องเห็นฟอร์มกรอกรหัสตามเดิม', async () => {
    window.location.hash = '#/book?m=find'
    render(<App />)

    expect(await screen.findByText(/กรอกรหัสจองและเบอร์โทร/)).toBeTruthy()
    expect(screen.queryByText('การจองที่ทำจากเครื่องนี้')).toBeNull()
  })

  // เคยเป็นบั๊ก: เปิดหน้าจองตอนค่ำ ยังเห็นรอบเช้าของวันนี้ให้กด แล้วโดนปฏิเสธตอนส่ง
  it('เปิดตอนดึก ไม่มีรอบที่เลยเวลาของวันนี้ให้เลือก และบอกให้เลือกวันอื่น', async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T22:00:00+07:00`))

    window.location.hash = '#/book'
    render(<App />)

    expect(await screen.findByText(/วันนี้เลยเวลารับจองแล้ว/)).toBeTruthy()
    expect(screen.queryByText('11:00')).toBeNull()
    expect(((await screen.findByText('ส่งคำขอจอง')) as HTMLButtonElement).disabled).toBe(true)
  })

  // ★ ต้องจองผ่านหน้าจอจริง ไม่ใช่เรียก rememberBooking เอง ไม่งั้นเทสต์จะ
  // ผ่านแม้หน้าจองลืมเรียกมัน
  it('จองผ่านหน้าจอแล้วถูกจำไว้เอง', async () => {
    // ฟอร์มเริ่มที่วันนี้ ถ้ารันตอนค่ำรอบของวันนี้หมดแล้วจะจองไม่ได้ — เคยทำ CI แดง
    // ตรึงเวลาเป็น 10:00 น. (เฉพาะ Date ตัวจับเวลาของ React Query ยังเป็นของจริง)
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T10:00:00+07:00`))

    window.location.hash = '#/book'
    render(<App />)

    fireEvent.click(await screen.findByText('A1'))
    fireEvent.change(screen.getByPlaceholderText('ชื่อ-นามสกุล หรือชื่อเล่น'), {
      target: { value: 'คุณจองจากเครื่องนี้' },
    })
    fireEvent.change(screen.getByPlaceholderText('08x-xxx-xxxx'), {
      target: { value: '081-555-0000' },
    })

    const send = (await screen.findByText('ส่งคำขอจอง')) as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)

    const codeEl = await screen.findByText(/^[A-Z0-9]{6}$/)
    await waitFor(() => {
      expect(myBookings().map((b) => b.code)).toContain(codeEl.textContent)
    })
  })

  it('จองแล้วเปิดดูได้โดยไม่ต้องกรอกอะไรเลย', async () => {
    const startAt = tomorrowAt('18:00')
    const t = await freeTable(startAt)
    const made = await mockBookingAdapter.create({
      customerName: 'คุณจำได้', phone: '081-999-0000', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    rememberBooking({ code: made.code, phone: '081-999-0000', startAt: made.startAt })

    window.location.hash = '#/book?m=find'
    render(<App />)

    fireEvent.click(await screen.findByText(made.code))

    expect(await screen.findByText('คุณจำได้')).toBeTruthy()
  })

  it('ยกเลิกแล้วต้องเลิกจำ', async () => {
    const startAt = tomorrowAt('19:00')
    const t = await freeTable(startAt)
    const made = await mockBookingAdapter.create({
      customerName: 'คุณยกเลิก', phone: '081-888-0000', partySize: 2,
      startAt, durationMinutes: 120, tableIds: [t.id],
    })
    rememberBooking({ code: made.code, phone: '081-888-0000', startAt: made.startAt })

    await mockBookingAdapter.cancel(made.code, '081-888-0000')
    forgetBooking(made.code)

    expect(myBookings().map((b) => b.code)).not.toContain(made.code)
  })

  it('ของเก่าเกินไปหลุดออกจากรายการเอง', () => {
    const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString()
    rememberBooking({ code: 'OLD123', phone: '081-000-0000', startAt: old })
    rememberBooking({ code: 'NEW123', phone: '081-000-0000', startAt: tomorrowAt('18:00') })

    const codes = myBookings().map((b) => b.code)
    expect(codes).toContain('NEW123')
    expect(codes).not.toContain('OLD123')
  })

  it('จำได้สูงสุด 5 รายการ อันเก่าสุดหลุดก่อน', () => {
    for (let i = 0; i < 7; i++) {
      rememberBooking({ code: `C0000${i}`, phone: '081', startAt: tomorrowAt('18:00') })
    }
    expect(myBookings()).toHaveLength(5)
  })

  it('localStorage ใช้ไม่ได้ก็ต้องไม่พัง', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() =>
        rememberBooking({ code: 'X00001', phone: '081', startAt: tomorrowAt('18:00') }),
      ).not.toThrow()
    } finally {
      Storage.prototype.setItem = real
    }
  })
})
