// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { mockAdapter } from '../data'

/**
 * รับออเดอร์ฝั่งพนักงาน — ถามว่าใครสั่งตอนกดส่ง
 *
 * ของเดิมเป็น dropdown ลอยอยู่หัวรายการเมนู ซึ่งไม่มีเทสต์ครอบเลย และมี
 * บั๊กซ่อนอยู่: ค่าเริ่มต้นคือ passes[0] ซึ่งอาจเป็นคนที่กลับไปแล้ว ทำให้
 * ส่งออเดอร์ไปลงชื่อคนที่ไม่ได้อยู่ในโต๊ะ
 */
describe('รับออเดอร์ (พนักงาน)', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = '#/visit/v-1'
  })

  async function openOrderDialog() {
    render(<App />)
    fireEvent.click(await screen.findByText('+ รับออเดอร์'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'เพิ่ม' })[0]!)
    return dialog
  }

  /** หน้าต่างบนสุด — ชื่อคนปรากฏทั้งในการ์ดผู้เล่นด้านหลังและในหน้าต่างนี้ */
  async function picker() {
    await screen.findByText('ใครเป็นคนสั่ง')
    const all = screen.getAllByRole('dialog')
    return all[all.length - 1]!
  }

  it('กดส่งเข้าครัวแล้วถามก่อนว่าใครสั่ง ยังไม่ส่งทันที', async () => {
    const before = (await mockAdapter.getSnapshot()).orders.length
    const dialog = await openOrderDialog()

    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))

    expect(await screen.findByText('ใครเป็นคนสั่ง')).toBeTruthy()
    expect((await mockAdapter.getSnapshot()).orders.length).toBe(before)
  })

  it('เลือกชื่อแล้วออเดอร์ลงชื่อคนนั้น', async () => {
    const snap = await mockAdapter.getSnapshot()
    const inRoom = snap.passes.filter(
      (p) => p.visitId === 'v-1' && (p.status === 'active' || p.status === 'paused'),
    )
    const pick = inRoom[inRoom.length - 1]!

    const dialog = await openOrderDialog()
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))
    fireEvent.click(within(await picker()).getByText(pick.displayName))

    await waitFor(async () => {
      const after = await mockAdapter.getSnapshot()
      const created = after.orders[after.orders.length - 1]!
      expect(created.orderedByPassId).toBe(pick.id)
      expect(created.splitMode).toBe('owner')
      expect(created.placedBy).toBe('staff')
    })
  })

  it('เลือกแชร์ทั้งโต๊ะแล้วไม่ผูกกับใคร', async () => {
    const dialog = await openOrderDialog()
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))
    fireEvent.click(within(await picker()).getByText('แชร์ทั้งโต๊ะ'))

    await waitFor(async () => {
      const after = await mockAdapter.getSnapshot()
      const created = after.orders[after.orders.length - 1]!
      expect(created.orderedByPassId).toBeNull()
      expect(created.splitMode).toBe('shared')
    })
  })

  // ★ บั๊กเดิม: ค่าเริ่มต้นเป็น passes[0] ซึ่งอาจเป็นคนที่กลับไปแล้ว
  it('คนที่กลับไปแล้วต้องไม่อยู่ในรายการให้เลือก', async () => {
    const snap = await mockAdapter.getSnapshot()
    const gone = snap.passes.find(
      (p) => p.visitId === 'v-1' && (p.status === 'checked_out' || p.status === 'billed'),
    )
    expect(gone).toBeTruthy()

    const dialog = await openOrderDialog()
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))

    expect(within(await picker()).queryByText(gone!.displayName)).toBeNull()
  })

  // ★ หน้าต่างซ้อนกันสองชั้น — Escape ต้องปิดแค่ใบบนสุด ไม่ใช่ปิดรวดเดียวหมด
  it('กด Escape ปิดแค่หน้าต่างเลือกคน ไม่ปิดรายการอาหารไปด้วย', async () => {
    const dialog = await openOrderDialog()
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))
    await picker()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByText('ใครเป็นคนสั่ง')).toBeNull())
    expect(screen.getByText('ส่งเข้าครัว')).toBeTruthy()
  })

  it('ย้อนกลับไปแก้รายการได้ ตะกร้าไม่หาย', async () => {
    const dialog = await openOrderDialog()
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))

    fireEvent.click(await screen.findByText('ย้อนกลับไปแก้รายการ'))

    await waitFor(() => expect(screen.queryByText('ใครเป็นคนสั่ง')).toBeNull())
    expect(within(dialog).getByText('1 รายการ')).toBeTruthy()
  })
})
