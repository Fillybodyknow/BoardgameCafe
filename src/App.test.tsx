// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'
import { mockAdapter } from './data'
import { seed } from './data/mock/seed'

/**
 * Smoke test — จับ crash ตอน render ที่ TypeScript มองไม่เห็น
 * ไม่ได้ทดสอบ UX แค่ยืนยันว่าทุกหน้าเปิดได้และเลขบนจอมาจากโดเมนจริง
 */
describe('แอปเปิดได้', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('ผังโต๊ะแสดงโต๊ะและสถิติหัวจอ', async () => {
    render(<App />)
    expect(await screen.findByText('A1')).toBeTruthy()
    expect(await screen.findByText('BAR')).toBeTruthy()
    expect(await screen.findByText('โซนเงียบ')).toBeTruthy()
    // ข้อมูลเดโมมี 8 โต๊ะ มีลูกค้าอยู่ 3 (A2, B1, BAR)
    expect(await screen.findByText('3/8')).toBeTruthy()
  })

  it('โต๊ะที่มีลูกค้าลิงก์ไปหน้า visit', async () => {
    render(<App />)
    await screen.findByText('A1')
    const links = document.querySelectorAll('a[href*="/visit/"]')
    expect(links.length).toBeGreaterThan(0)
  })

  it('หน้าครัวแสดงออเดอร์ที่ยังไม่เสิร์ฟ', async () => {
    window.location.hash = '#/kitchen'
    render(<App />)
    expect(await screen.findByText(/เข้าใหม่/)).toBeTruthy()
    expect(await screen.findByText(/เฟรนช์ฟรายส์/)).toBeTruthy()
    // ออเดอร์ที่เสิร์ฟไปแล้วต้องไม่โผล่ในจอครัว
    expect(screen.queryByText(/อเมริกาโน่เย็น/)).toBeNull()
  })

  it('หน้ารายละเอียด visit แสดงผู้เล่นครบทุกสถานะ', async () => {
    window.location.hash = '#/visit/v-1'
    render(<App />)
    expect(await screen.findByText('ต้น')).toBeTruthy()
    expect(await screen.findByText('บอส')).toBeTruthy()
    expect(await screen.findByText('ค้างชำระ')).toBeTruthy()
    expect(await screen.findByText('ออกไปข้างนอก')).toBeTruthy()
    // v-1 ย้ายโต๊ะมาแล้ว 1 ครั้ง — ต้องขึ้นเตือน
    expect(await screen.findByText(/ย้ายโต๊ะมาแล้ว 1 ครั้ง/)).toBeTruthy()
  })

  // เคยพังจริง: หน้าจอ hardcode 'rp-std' ไว้ ซึ่งมีแค่ในข้อมูลจำลอง
  // พอต่อฐานข้อมูลจริงที่ใช้ UUID จึงได้ 22P02 ตอนกดเปิดโต๊ะ
  //
  // ต้องทดสอบผ่านการกดปุ่มจริง ไม่ใช่อ่านค่าจาก <select> เพราะเบราว์เซอร์
  // คืน option แรกให้เองเมื่อ value ไม่ตรงกับ option ไหนเลย — บั๊กจึงถูกกลบ
  it('เปิดโต๊ะแล้วส่งรหัสเรตราคาที่มีอยู่จริง', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('A3'))
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดโต๊ะ' }))

    await waitFor(async () => {
      const snap = await mockAdapter.getSnapshot()
      const known = new Set(snap.ratePlans.map((p) => p.id))
      const created = snap.passes.filter((p) => !seed().passes.some((s) => s.id === p.id))
      expect(created.length).toBeGreaterThan(0)
      for (const pass of created) {
        expect(known.has(pass.ratePlanId)).toBe(true)
      }
    })
  })

  // เคยเป็นบั๊ก: ปิดบิลแล้วโต๊ะติดสถานะ 'cleaning' ค้างถาวร เพราะไม่มีโค้ดไหน
  // ตั้งกลับเป็น 'free' เลย ทำให้เปิดโต๊ะนั้นใหม่ไม่ได้อีก
  it('ปิดบิลแล้วโต๊ะกลับมาว่าง และเปิดใหม่ได้ทันที', async () => {
    const before = await mockAdapter.getSnapshot()
    const visit = before.visits.find((v) => v.status === 'open')!
    const tableId = before.occupancies.find((o) => o.visitId === visit.id && o.toAt === null)!.tableId

    await mockAdapter.closeVisit(visit.id)

    const after = await mockAdapter.getSnapshot()
    expect(after.tables.find((t) => t.id === tableId)!.status).toBe('free')
    expect(after.tables.some((t) => t.status === 'cleaning')).toBe(false)

    // เปิดโต๊ะเดิมใหม่ได้เลย ไม่ต้องรอใครกดเก็บโต๊ะ
    const plan = after.ratePlans[0]!.id
    const reopened = await mockAdapter.openVisit({
      tableIds: [tableId],
      guests: [{ name: 'กลุ่มใหม่', ratePlanId: plan }],
    })
    expect(reopened.id).toBeTruthy()
  })

  it('ย้ายโต๊ะแล้วโต๊ะเดิมกลับมาว่าง', async () => {
    const before = await mockAdapter.getSnapshot()
    const visit = before.visits.find((v) => v.status === 'open')!
    const from = before.occupancies.find((o) => o.visitId === visit.id && o.toAt === null)!.tableId
    const to = before.tables.find((t) => t.status === 'free' && !t.allowShare)!.id

    await mockAdapter.moveVisitToTables(visit.id, [to])

    const after = await mockAdapter.getSnapshot()
    expect(after.tables.find((t) => t.id === from)!.status).toBe('free')
    expect(after.tables.find((t) => t.id === to)!.status).toBe('occupied')
  })

  it('หน้าการจองเตือนเมื่อลูกค้าเลยเวลานัด', async () => {
    window.location.hash = '#/reservations'
    render(<App />)
    const card = (await screen.findByText('คุณแนน')).closest('div')
    expect(card).toBeTruthy()
    expect(within(card!).getByText('ยืนยันแล้ว')).toBeTruthy()
  })
})
