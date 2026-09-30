// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { mockAdapter, mockBookingAdapter } from '../data/mock/mockAdapter'

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

    expect(await screen.findByText('🎲 จองโต๊ะ')).toBeTruthy()
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
