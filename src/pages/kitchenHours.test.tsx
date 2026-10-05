// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { adminDb, db, guestDb, mockAdapter } from '../data'
import { rememberMyPass } from '../lib/myPass'

/**
 * เวลาปิดครัว — เส้นทางเต็มผ่าน adapter จริง (โหมดจำลอง)
 *
 * บังคับให้ "ตอนนี้" อยู่หลังครัวปิดด้วยการตั้งเวลาปิดครัวเป็น 00:01 แทนที่
 * จะไป mock นาฬิกา เพราะอยากทดสอบเส้นทางเดียวกับที่ใช้จริงทั้งเส้น
 *
 * กติกาที่ต้องเหมือนกับ supabase/tests/96_kitchen_hours_test.sql:
 *   - ลูกค้าสั่งของที่ต้องเข้าครัวไม่ได้เลย แต่เครื่องดื่มยังสั่งได้
 *   - พนักงานสั่งได้ถ้ายืนยัน
 */

const FOOD = 'm-8' // สปาเก็ตตี้คาโบนาร่า
const DRINK = 'm-1' // อเมริกาโน่เย็น

/** ปิดครัวตั้งแต่เปิดร้าน = ตอนนี้ครัวปิดแน่นอน ไม่ว่าจะรันเทสต์ตอนไหน */
async function closeKitchenNow() {
  for (let weekday = 0; weekday < 7; weekday++) {
    await adminDb.saveShopHours({
      weekday,
      openTime: '00:00',
      closeTime: '23:59',
      closed: false,
      kitchenCloseTime: '00:01',
    })
  }
}

async function openKitchenNow() {
  for (let weekday = 0; weekday < 7; weekday++) {
    await adminDb.saveShopHours({
      weekday,
      openTime: '00:00',
      closeTime: '23:59',
      closed: false,
      kitchenCloseTime: null,
    })
  }
}

/** กด + ของเมนูชื่อนั้นในหน้าต่างรับออเดอร์ */
function addToCart(dialog: HTMLElement, name: string) {
  const row = within(dialog)
    .getAllByText(name, { exact: false })[0]!
    .closest('div.flex.items-center.justify-between') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'เพิ่ม' }))
}

describe('ลูกค้าสแกน QR หลังครัวปิด', () => {
  beforeEach(async () => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
    await closeKitchenNow()
  })

  it('สั่งอาหารไม่ได้', async () => {
    await expect(
      guestDb.placeOrder({
        token: 'qr-v1',
        idempotencyKey: 'kh-food',
        orderedByPassId: null,
        splitMode: 'shared',
        items: [{ menuItemId: FOOD, qty: 1 }],
      }),
    ).rejects.toThrow(/ครัวปิด/)
  })

  it('แต่เครื่องดื่มยังสั่งได้', async () => {
    const res = await guestDb.placeOrder({
      token: 'qr-v1',
      idempotencyKey: 'kh-drink',
      orderedByPassId: null,
      splitMode: 'shared',
      items: [{ menuItemId: DRINK, qty: 1 }],
    })
    expect(res.status).toBe('placed')
  })

  it('ปนกันในตะกร้าเดียวก็ถูกปฏิเสธทั้งออเดอร์', async () => {
    await expect(
      guestDb.placeOrder({
        token: 'qr-v1',
        idempotencyKey: 'kh-mixed',
        orderedByPassId: null,
        splitMode: 'shared',
        items: [
          { menuItemId: DRINK, qty: 1 },
          { menuItemId: FOOD, qty: 1 },
        ],
      }),
    ).rejects.toThrow(/ครัวปิด/)
  })

  it('หน้าเมนูบอกตั้งแต่แรกว่าครัวปิด และกดเพิ่มอาหารไม่ได้', async () => {
    rememberMyPass('qr-v1', await guestDb.register('qr-v1', 'คุณครัวปิด'))
    window.location.hash = '#/t/qr-v1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')

    expect(await screen.findByText(/สั่งได้เฉพาะเครื่องดื่มและของกินเล่น/)).toBeTruthy()

    const row = screen.getByText('สปาเก็ตตี้คาโบนาร่า').closest('.panel') as HTMLElement
    expect(within(row).getByText('ครัวปิดแล้ว')).toBeTruthy()
    expect((within(row).getByRole('button', { name: 'เพิ่ม' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    const drinkRow = screen.getByText('อเมริกาโน่เย็น').closest('.panel') as HTMLElement
    expect(
      (within(drinkRow).getByRole('button', { name: 'เพิ่ม' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('ครัวเปิดอยู่ ไม่ต้องขึ้นแถบเตือน', async () => {
    await openKitchenNow()
    rememberMyPass('qr-v1', await guestDb.register('qr-v1', 'คุณครัวเปิด'))
    window.location.hash = '#/t/qr-v1'
    render(<App />)
    await screen.findByText('โต๊ะ B1')

    // react-query คืนค่าที่แคชไว้ก่อนแล้วค่อยดึงใหม่ จึงต้องรอให้นิ่ง
    await waitFor(() =>
      expect(screen.queryByText(/สั่งได้เฉพาะเครื่องดื่มและของกินเล่น/)).toBeNull(),
    )
  })
})

describe('พนักงานสั่งแทนหลังครัวปิด', () => {
  beforeEach(async () => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = '#/visit/v-1'
    await closeKitchenNow()
  })

  it('ไม่ยืนยันแล้วส่งไม่ผ่าน', async () => {
    await expect(
      db.placeOrder({
        idempotencyKey: 'kh-staff',
        visitId: 'v-1',
        orderedByPassId: null,
        splitMode: 'shared',
        placedBy: 'staff',
        items: [{ menuItemId: FOOD, qty: 1 }],
      }),
    ).rejects.toThrow(/ครัวปิด/)
  })

  it('ยืนยันแล้วส่งได้', async () => {
    const order = await db.placeOrder({
      idempotencyKey: 'kh-staff-ok',
      visitId: 'v-1',
      orderedByPassId: null,
      splitMode: 'shared',
      placedBy: 'staff',
      items: [{ menuItemId: FOOD, qty: 1 }],
      allowClosedKitchen: true,
    })
    expect(order.status).toBe('placed')
  })

  // ★ ต้องเป็นการตัดสินใจ ไม่ใช่กดผ่านโดยไม่รู้ตัว
  it('หน้าสั่งของขอให้ติ๊กยืนยันก่อน ถึงจะกดส่งได้', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('+ รับออเดอร์'))

    const dialog = await screen.findByRole('dialog')
    addToCart(dialog, 'สปาเก็ตตี้คาโบนาร่า')
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))

    await screen.findByText('ใครเป็นคนสั่ง')
    const all = screen.getAllByRole('dialog')
    const picker = all[all.length - 1]!

    expect(within(picker).getByText(/ครัวปิดแล้ว/)).toBeTruthy()

    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: 'shared' } })
    const confirm = within(picker).getByText('ยืนยันส่งเข้าครัว') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.click(within(picker).getByRole('checkbox'))
    expect(confirm.disabled).toBe(false)
  })

  it('ตะกร้าที่มีแต่เครื่องดื่มไม่ต้องยืนยันอะไร', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('+ รับออเดอร์'))

    const dialog = await screen.findByRole('dialog')
    addToCart(dialog, 'อเมริกาโน่เย็น')
    fireEvent.click(within(dialog).getByText('ส่งเข้าครัว'))

    await screen.findByText('ใครเป็นคนสั่ง')
    const all = screen.getAllByRole('dialog')
    const picker = all[all.length - 1]!

    expect(within(picker).queryByRole('checkbox')).toBeNull()
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: 'shared' } })
    expect((within(picker).getByText('ยืนยันส่งเข้าครัว') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('ตั้งค่าเวลาปิดครัว', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
  })

  it('บันทึกแล้วอ่านกลับได้', async () => {
    await adminDb.saveShopHours({
      weekday: 1,
      openTime: '11:00',
      closeTime: '23:00',
      closed: false,
      kitchenCloseTime: '22:00',
    })
    const hours = await adminDb.shopHours()
    expect(hours.find((h) => h.weekday === 1)!.kitchenCloseTime).toBe('22:00')
  })

  // กติกาเดียวกับ upsert_shop_hours() ฝั่ง SQL
  it('ตั้งเวลาปิดครัวหลังร้านปิดไม่ได้', async () => {
    await expect(
      adminDb.saveShopHours({
        weekday: 1,
        openTime: '11:00',
        closeTime: '23:00',
        closed: false,
        kitchenCloseTime: '23:30',
      }),
    ).rejects.toThrow(/เวลาปิดครัว/)
  })

  it('ตั้งเวลาปิดครัวก่อนร้านเปิดไม่ได้', async () => {
    await expect(
      adminDb.saveShopHours({
        weekday: 1,
        openTime: '11:00',
        closeTime: '23:00',
        closed: false,
        kitchenCloseTime: '10:00',
      }),
    ).rejects.toThrow(/เวลาปิดครัว/)
  })
})
