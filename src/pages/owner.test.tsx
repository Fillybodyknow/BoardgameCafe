// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App, { qc } from '../App'
import { mockAdapter } from '../data/mock/mockAdapter'
import { mockAdminAdapter } from '../data/mock/adminAdapter'
import { computeBill } from '../domain/pricing'

describe('ตั้งค่าร้าน (ระดับ adapter)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  // ★ เหตุผลหลักที่ต้องมี snapshot เรต — ไม่งั้นหน้านี้ทำบิลเพี้ยนย้อนหลัง
  it('ขึ้นราคาค่าเล่นแล้ว บิลของคนที่กำลังนั่งอยู่ต้องไม่เปลี่ยน', async () => {
    const plans = await mockAdminAdapter.allRatePlans()
    const plan = plans[0]!

    const visit = await mockAdapter.openVisit({
      tableIds: ['t-a3'],
      guests: [{ name: 'กำลังนั่ง', ratePlanId: plan.id }],
    })
    const before = await mockAdapter.previewBill(visit.id)

    await mockAdminAdapter.saveRatePlan({
      id: plan.id,
      name: plan.name,
      pricePerHour: plan.pricePerHour * 2,
      roundToMinutes: plan.roundToMinutes,
      minimumMinutes: plan.minimumMinutes,
      dayPassCap: null,
      active: true,
      sortOrder: 0,
    })

    const after = await mockAdapter.previewBill(visit.id)
    expect(after.total).toBe(before.total)

    // แต่คนที่เข้ามาใหม่ต้องได้ราคาใหม่
    await mockAdapter.addPass(visit.id, { name: 'มาทีหลัง', ratePlanId: plan.id })
    const snap = await mockAdapter.getSnapshot()
    const newcomer = snap.passes.find((p) => p.displayName === 'มาทีหลัง')!
    expect(newcomer.rate.pricePerHour).toBe(plan.pricePerHour * 2)
  })

  it('แก้ราคาเมนูไม่กระทบออเดอร์ที่สั่งไปแล้ว', async () => {
    const snap0 = await mockAdapter.getSnapshot()
    const item = snap0.menu[0]!
    const pass = snap0.passes.find((p) => p.visitId === 'v-1' && p.status === 'active')!

    await mockAdapter.placeOrder({
      idempotencyKey: 'price-test',
      visitId: 'v-1',
      orderedByPassId: pass.id,
      splitMode: 'owner',
      placedBy: 'staff',
      items: [{ menuItemId: item.id, qty: 1 }],
    })

    await mockAdminAdapter.saveMenuItem({
      id: item.id, sku: item.sku, name: item.name,
      category: item.category, price: 9999, available: true, sortOrder: 0,
    })

    const snap = await mockAdapter.getSnapshot()
    const order = snap.orders.find((o) => o.id !== 'ord-1' && o.visitId === 'v-1' &&
      o.lines.some((l) => l.menuItemId === item.id))!
    expect(order.lines[0]!.unitPriceSnapshot).toBe(item.price)

    const bill = computeBill({
      visitId: 'v-1',
      passes: snap.passes.filter((p) => p.visitId === 'v-1'),
      orders: snap.orders.filter((o) => o.visitId === 'v-1'),
      now: new Date(),
    })
    expect(bill.lines.some((l) => l.amount === 9999)).toBe(false)
  })

  it('เก็บเมนูเข้ากรุแล้วหายจากหน้าร้าน แต่ข้อมูลยังอยู่', async () => {
    const item = (await mockAdminAdapter.allMenuItems())[0]!
    await mockAdminAdapter.archiveMenuItem(item.id, true)

    const snap = await mockAdapter.getSnapshot()
    expect(snap.menu.some((m) => m.id === item.id)).toBe(false)

    const all = await mockAdminAdapter.allMenuItems()
    expect(all.find((m) => m.id === item.id)?.archived).toBe(true)
    // เก็บเข้ากรุแล้วต้องไม่ค้างสถานะพร้อมขาย
    expect(all.find((m) => m.id === item.id)?.available).toBe(false)

    await mockAdminAdapter.archiveMenuItem(item.id, false)
    expect((await mockAdapter.getSnapshot()).menu.some((m) => m.id === item.id)).toBe(true)
  })

  it('โต๊ะที่มีลูกค้านั่งอยู่ เก็บเข้ากรุไม่ได้', async () => {
    const snap = await mockAdapter.getSnapshot()
    const occupied = snap.occupancies.find((o) => o.toAt === null)!
    await expect(mockAdminAdapter.archiveTable(occupied.tableId, true)).rejects.toThrow(
      /มีลูกค้านั่งอยู่/,
    )
  })

  it('โต๊ะที่มีคิวจองค้าง เก็บเข้ากรุไม่ได้', async () => {
    // seed: r-1 จอง t-c1 สถานะ confirmed
    await expect(mockAdminAdapter.archiveTable('t-c1', true)).rejects.toThrow(/คิวจอง/)
  })

  it('เปลี่ยนการนั่งร่วมตอนมีลูกค้าอยู่ไม่ได้', async () => {
    const snap = await mockAdapter.getSnapshot()
    const occ = snap.occupancies.find((o) => o.toAt === null)!
    const table = snap.tables.find((t) => t.id === occ.tableId)!

    await expect(
      mockAdminAdapter.saveTable({
        id: table.id, code: table.code, zone: table.zone,
        seatMin: table.seatMin, seatMax: table.seatMax,
        allowShare: !table.allowShare, sortOrder: 0,
      }),
    ).rejects.toThrow(/นั่งร่วม/)
  })

  it('เพิ่มโต๊ะใหม่แล้วโผล่ในผังโต๊ะทันที', async () => {
    await mockAdminAdapter.saveTable({
      id: null, code: 'z1', zone: 'โซนใหม่',
      seatMin: 2, seatMax: 4, allowShare: false, sortOrder: 99,
    })
    const snap = await mockAdapter.getSnapshot()
    const added = snap.tables.find((t) => t.code === 'Z1')
    expect(added).toBeTruthy()
    expect(added!.status).toBe('free')
    expect(added!.qrToken).toBeTruthy() // ต้องมี QR ให้พิมพ์ได้เลย
  })

  it('ข้อมูลไม่ถูกต้องถูกปฏิเสธเหมือนฝั่ง SQL', async () => {
    await expect(
      mockAdminAdapter.saveMenuItem({
        id: null, sku: 'X', name: '', category: 'drink',
        price: 10, available: true, sortOrder: 0,
      }),
    ).rejects.toThrow(/ชื่อเมนู/)

    await expect(
      mockAdminAdapter.saveTable({
        id: null, code: 'X1', zone: 'z', seatMin: 5, seatMax: 2,
        allowShare: false, sortOrder: 0,
      }),
    ).rejects.toThrow(/ที่นั่ง/)

    await expect(
      mockAdminAdapter.saveShopHours({
        weekday: 1, openTime: '20:00', closeTime: '02:00', closed: false,
      kitchenCloseTime: null,
      }),
    ).rejects.toThrow(/ข้ามวัน/)

    await expect(
      mockAdminAdapter.saveTaxConfig({ serviceChargeRate: 0, vatRate: 1.5, vatIncluded: true }),
    ).rejects.toThrow(/0 ถึง 1/)
  })

  it('ผูกรูปกับเมนูแล้วเห็นทั้งหน้าตั้งค่าและหน้าร้าน', async () => {
    const item = (await mockAdminAdapter.allMenuItems())[0]!
    const dataUrl = 'data:image/jpeg;base64,AAAA'

    await mockAdminAdapter.uploadMenuImage(item.id, {
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      dataUrl,
    })

    expect((await mockAdminAdapter.allMenuItems()).find((m) => m.id === item.id)!.imagePath)
      .toBe(dataUrl)
    // หน้าร้าน (snapshot) ต้องเห็นด้วย ไม่ใช่เห็นแค่หน้าตั้งค่า
    const snap = await mockAdapter.getSnapshot()
    expect(snap.menu.find((m) => m.id === item.id)!.imagePath).toBe(dataUrl)

    await mockAdminAdapter.removeMenuImage(item.id)
    expect((await mockAdminAdapter.allMenuItems()).find((m) => m.id === item.id)!.imagePath)
      .toBe(null)
  })

  it('บันทึกเวลาทำการแล้วอ่านกลับได้', async () => {
    await mockAdminAdapter.saveShopHours({
      weekday: 2, openTime: '12:00', closeTime: '22:00', closed: false,
      kitchenCloseTime: null,
    })
    const hours = await mockAdminAdapter.shopHours()
    expect(hours.find((h) => h.weekday === 2)!.openTime).toBe('12:00')
    // วันอื่นไม่ถูกแตะ
    expect(hours.find((h) => h.weekday === 3)!.openTime).toBe('11:00')
  })
})

describe('หน้าตั้งค่าร้าน', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('เปิดแท็บเมนูแล้วเห็นรายการจริง', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    expect(await screen.findByText('ตั้งค่าร้าน')).toBeTruthy()
    expect(await screen.findByText('อเมริกาโน่เย็น')).toBeTruthy()
  })

  it('สลับไปแท็บเรตราคาแล้วเห็นคำเตือนว่าไม่กระทบคนที่นั่งอยู่', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เรตราคา'))
    expect(await screen.findByText(/ไม่กระทบลูกค้าที่กำลังนั่งอยู่/)).toBeTruthy()
    expect(screen.getByText('สมาชิก')).toBeTruthy()
  })

  it('แก้ราคาเมนูผ่านหน้าจอแล้วบันทึกจริง', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    await screen.findByText('อเมริกาโน่เย็น')

    fireEvent.click(screen.getAllByText('แก้ไข')[0]!)
    const price = await screen.findByDisplayValue('65')
    fireEvent.change(price, { target: { value: '75' } })
    fireEvent.click(screen.getByText('บันทึก'))

    await waitFor(async () => {
      const menu = await mockAdminAdapter.allMenuItems()
      expect(menu.find((m) => m.name === 'อเมริกาโน่เย็น')!.price).toBe(75)
    })
  })

  it('แท็บเวลาทำการแสดงครบ 7 วัน', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เวลาทำการ'))
    for (const d of ['อาทิตย์', 'จันทร์', 'เสาร์']) {
      expect(await screen.findByText(d)).toBeTruthy()
    }
  })

  /*
    ★ เกิดขึ้นจริง: ตั้งเวลาปิดครัวไม่ได้เลย

    ของเดิมบันทึกทุกครั้งที่ค่าในช่องเปลี่ยน แต่ <input type="time"> คืนค่าว่าง
    ระหว่างที่ยังกรอกไม่ครบ พอบันทึกค่าว่างแล้วโหลดกลับมา ตัวเลขที่พิมพ์ค้างไว้
    ก็ถูกเขียนทับ วนแบบนี้จนกรอกให้ครบไม่ได้

    เทสต์จำลองการพิมพ์ที่ผ่านค่าว่างระหว่างทาง แล้วตรวจว่าไม่มีการบันทึก
    จนกว่าจะออกจากช่อง
  */
  it('ตั้งเวลาปิดครัวได้ แม้ระหว่างพิมพ์จะผ่านค่าว่าง', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เวลาทำการ'))

    const field = (await screen.findByLabelText('เวลาปิดครัว จันทร์')) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe(''))

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.change(field, { target: { value: '22:00' } })

    // เปิดโอกาสให้ mutation ได้ทำงานก่อน ไม่งั้นจะผ่านเพราะยังไม่ทันบันทึก
    // ไม่ใช่เพราะไม่บันทึก
    await new Promise((r) => setTimeout(r, 60))

    // ยังไม่ออกจากช่อง → ต้องยังไม่บันทึก และค่าที่พิมพ์ต้องไม่ถูกล้าง
    expect(field.value).toBe('22:00')
    expect((await mockAdminAdapter.shopHours()).find((h) => h.weekday === 1)!.kitchenCloseTime)
      .toBeNull()

    fireEvent.blur(field)

    await waitFor(async () => {
      const hours = await mockAdminAdapter.shopHours()
      expect(hours.find((h) => h.weekday === 1)!.kitchenCloseTime).toBe('22:00')
    })
  })

  // ★ อาการที่เจอหน้างาน: กรอกวันหนึ่งเสร็จ ไปกรอกอีกวัน
  // แล้ววันแรกกลับเป็นค่าว่าง
  it('กรอกหลายวันต่อกัน ค่าของวันก่อนหน้าต้องไม่หาย', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เวลาทำการ'))

    const mon = (await screen.findByLabelText('เวลาปิดครัว จันทร์')) as HTMLInputElement
    // react-query คืนค่าที่แคชไว้จากเทสต์ก่อนหน้าก่อนจะดึงใหม่ ต้องรอให้นิ่ง
    // ไม่งั้นจะพิมพ์ค่าเดิมทับค่าเดิม แล้วไม่เกิดการบันทึก
    await waitFor(() => expect(mon.value).toBe(''))

    fireEvent.focus(mon)
    fireEvent.change(mon, { target: { value: '22:00' } })
    fireEvent.blur(mon)

    await waitFor(async () => {
      const hours = await mockAdminAdapter.shopHours()
      expect(hours.find((h) => h.weekday === 1)!.kitchenCloseTime).toBe('22:00')
    })

    const tue = (await screen.findByLabelText('เวลาปิดครัว อังคาร')) as HTMLInputElement
    fireEvent.focus(tue)
    fireEvent.change(tue, { target: { value: '21:00' } })
    fireEvent.blur(tue)

    await waitFor(async () => {
      const hours = await mockAdminAdapter.shopHours()
      expect(hours.find((h) => h.weekday === 2)!.kitchenCloseTime).toBe('21:00')
    })

    // วันจันทร์ต้องยังอยู่ ทั้งในฐานข้อมูลและบนหน้าจอ
    const hours = await mockAdminAdapter.shopHours()
    expect(hours.find((h) => h.weekday === 1)!.kitchenCloseTime).toBe('22:00')
    await waitFor(() => expect(mon.value).toBe('22:00'))
  })

  it('ล้างช่องเวลาปิดครัวแล้วกลับไปปิดพร้อมร้าน', async () => {
    await mockAdminAdapter.saveShopHours({
      weekday: 1, openTime: '11:00', closeTime: '23:00', closed: false, kitchenCloseTime: '22:00',
    })

    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เวลาทำการ'))

    const field = (await screen.findByLabelText('เวลาปิดครัว จันทร์')) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('22:00'))

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)

    await waitFor(async () => {
      const hours = await mockAdminAdapter.shopHours()
      expect(hours.find((h) => h.weekday === 1)!.kitchenCloseTime).toBeNull()
    })
  })
})

/**
 * จำนวนวันที่จองล่วงหน้าได้
 *
 * ค่านี้มีในฐานข้อมูลและถูกใช้จริงมาตั้งแต่แรก แต่ไม่มีทางแก้จากหน้าจอ
 * ต้องเข้าไปแก้ในฐานข้อมูลเอง ซึ่งเจ้าของร้านทำไม่ได้
 */
describe('ตั้งจำนวนวันจองล่วงหน้า', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    qc.clear()
    window.location.hash = ''
  })

  it('แก้จากหน้าจอแล้วบันทึกจริง', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('เวลาทำการ'))

    const field = (await screen.findByLabelText(
      'จำนวนวันที่จองล่วงหน้าได้',
    )) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('30'))

    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '7' } })
    fireEvent.blur(field)

    await waitFor(async () => {
      expect((await mockAdminAdapter.bookingConfig()).maxAdvanceDays).toBe(7)
    })
  })

  // ★ ถ้าแก้แล้วหน้าจองไม่เปลี่ยนตาม ก็เท่ากับไม่ได้ทำ
  it('หน้าจองจำกัดวันที่เลือกได้ตามค่าที่ตั้งไว้', async () => {
    await mockAdminAdapter.saveMaxAdvanceDays(2)

    window.location.hash = '#/book'
    render(<App />)
    await screen.findByText('⚜ จองโต๊ะ')

    // คิดแบบเดียวกับหน้าจอง: วันนี้ + จำนวนวันที่ตั้งไว้ (เผื่อ 7 ชม. ให้โซนเวลาไทย)
    const expected = new Date(Date.now() + (2 * 24 + 7) * 3600_000).toISOString().slice(0, 10)

    await waitFor(() => {
      const date = document.querySelector('input[type="date"]') as HTMLInputElement
      expect(date.getAttribute('max')).toBe(expected)
    })
  })

  it('ค่าที่เป็นไปไม่ได้ถูกปฏิเสธ', async () => {
    await expect(mockAdminAdapter.saveMaxAdvanceDays(0)).rejects.toThrow(/1 ถึง 365/)
    await expect(mockAdminAdapter.saveMaxAdvanceDays(400)).rejects.toThrow(/1 ถึง 365/)
  })
})
