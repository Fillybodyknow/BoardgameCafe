// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import App from '../App'
import { adminDb } from '../data'
import { mockAdapter } from '../data/mock/mockAdapter'
import { CAPABILITIES } from '../data/mock/adminAdapter'
import type { Capability, StaffRole } from '../domain/types'

/** ชื่อเมนูซ้ำกับหัวหน้าเพจได้ จึงต้องค้นเฉพาะในแถบเมนู ไม่ใช่ทั้งหน้า */
async function nav() {
  const el = await screen.findByRole('navigation')
  // รายการเมนูขึ้นหลังโหลดสิทธิ์เสร็จ ถ้าไม่รอจะเจอแถบเมนูที่ยังว่าง
  await within(el).findAllByRole('link')
  return within(el)
}

/**
 * ซ่อนเมนูตามสิทธิ์
 *
 * ย้ำว่านี่เป็นเรื่องความสะดวก ไม่ใช่ความปลอดภัย — ต่อให้พิมพ์ URL เข้ามาได้
 * ทุก RPC ก็ยังตรวจสิทธิ์ฝั่งฐานข้อมูลอยู่ดี (ทดสอบไว้ใน 80_capability_test.sql)
 * ที่นี่ตรวจว่าคนที่ไม่มีสิทธิ์ไม่ต้องเจอเมนูที่กดไปก็โดนปฏิเสธ
 */
function loginAs(role: StaffRole) {
  vi.spyOn(adminDb, 'myCapabilities').mockResolvedValue(CAPABILITIES[role])
  vi.spyOn(adminDb, 'myRole').mockResolvedValue(role)
}

describe('ชุดสิทธิ์ของแต่ละระดับ', () => {
  it('ระดับเดิมทั้งสามได้สิทธิ์เท่าเดิม ไม่มีใครถูกตัด', () => {
    expect(CAPABILITIES.staff).toEqual(['floor', 'kitchen'])
    expect(CAPABILITIES.manager).toEqual(['floor', 'kitchen', 'settings'])
    expect(CAPABILITIES.owner).toEqual(['floor', 'kitchen', 'settings', 'accounts'])
  })

  it('ระดับใหม่มีสิทธิ์เดียวตามชื่อ', () => {
    expect(CAPABILITIES.floor).toEqual(['floor'])
    expect(CAPABILITIES.kitchen).toEqual(['kitchen'])
  })

  it('ทุกระดับมีอย่างน้อยหนึ่งสิทธิ์ — ไม่มีระดับที่ทำอะไรไม่ได้เลย', () => {
    for (const [role, caps] of Object.entries(CAPABILITIES)) {
      expect(caps.length, role).toBeGreaterThan(0)
    }
  })
})

describe('เมนูที่เห็นในแต่ละระดับ', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('ระดับหน้าร้าน เห็นโต๊ะ/จอง/เกม/QR แต่ไม่เห็นครัวและตั้งค่า', async () => {
    loginAs('floor')
    render(<App />)
    const menu = await nav()

    expect(menu.getByText('ผังโต๊ะ')).toBeTruthy()
    expect(menu.getByText('การจอง')).toBeTruthy()
    expect(menu.getByText('คลังเกม')).toBeTruthy()
    expect(menu.queryByText('ครัว')).toBeNull()
    expect(menu.queryByText('ตั้งค่า')).toBeNull()
  })

  it('ระดับครัว เห็นเฉพาะครัว', async () => {
    loginAs('kitchen')
    render(<App />)
    const menu = await nav()

    expect(menu.getByText('ครัว')).toBeTruthy()
    expect(menu.queryByText('ผังโต๊ะ')).toBeNull()
    expect(menu.queryByText('การจอง')).toBeNull()
    expect(menu.queryByText('ตั้งค่า')).toBeNull()
  })

  it('ระดับพนักงานทั่วไป เห็นทั้งหน้าร้านและครัว แต่ไม่เห็นตั้งค่า', async () => {
    loginAs('staff')
    render(<App />)
    const menu = await nav()

    expect(menu.getByText('ผังโต๊ะ')).toBeTruthy()
    expect(menu.getByText('ครัว')).toBeTruthy()
    expect(menu.queryByText('ตั้งค่า')).toBeNull()
  })

  it('ผู้จัดการเห็นตั้งค่าด้วย', async () => {
    loginAs('manager')
    render(<App />)
    const menu = await nav()
    expect(menu.getByText('ตั้งค่า')).toBeTruthy()
  })
})

describe('พิมพ์ URL เข้าหน้าที่ไม่มีสิทธิ์', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('คนครัวเปิดผังโต๊ะตรง ๆ ไม่ได้', async () => {
    loginAs('kitchen')
    window.location.hash = '#/'
    render(<App />)
    expect(await screen.findByText(/ไม่มีสิทธิ์เข้าหน้านี้/)).toBeTruthy()
  })

  it('คนหน้าร้านเปิดจอครัวตรง ๆ ไม่ได้', async () => {
    loginAs('floor')
    window.location.hash = '#/kitchen'
    render(<App />)
    expect(await screen.findByText(/ไม่มีสิทธิ์เข้าหน้านี้/)).toBeTruthy()
  })

  it('พนักงานทั่วไปเปิดหน้าตั้งค่าตรง ๆ ไม่ได้', async () => {
    loginAs('staff')
    window.location.hash = '#/owner'
    render(<App />)
    expect(await screen.findByText(/ไม่มีสิทธิ์เข้าหน้านี้/)).toBeTruthy()
  })

  it('คนที่มีสิทธิ์เปิดได้ตามปกติ', async () => {
    loginAs('kitchen')
    window.location.hash = '#/kitchen'
    render(<App />)
    // จอครัวว่างก็ยังถือว่าเข้าถึงได้ ขอแค่ไม่ใช่หน้าปฏิเสธสิทธิ์
    const menu = await nav()
    expect(menu.getByText('ครัว')).toBeTruthy()
    expect(screen.queryByText(/ไม่มีสิทธิ์เข้าหน้านี้/)).toBeNull()
  })
})

describe('แท็บจัดการบัญชีแยกจากการตั้งค่าร้าน', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('ผู้จัดการเข้าหน้าตั้งค่าได้ แต่ไม่เห็นแท็บพนักงาน', async () => {
    loginAs('manager')
    window.location.hash = '#/owner'
    render(<App />)

    expect(await screen.findByText('ตั้งค่าร้าน')).toBeTruthy()
    expect(screen.getByText('เมนู')).toBeTruthy()
    expect(screen.queryByText('พนักงาน')).toBeNull()
  })

  it('เจ้าของร้านเห็นแท็บพนักงาน', async () => {
    loginAs('owner')
    window.location.hash = '#/owner'
    render(<App />)

    expect(await screen.findByText('ตั้งค่าร้าน')).toBeTruthy()
    expect(await screen.findByText('พนักงาน')).toBeTruthy()
  })
})

describe('สิทธิ์ที่ใช้จริงต้องเป็นชนิดที่รู้จัก', () => {
  it('ไม่มีสิทธิ์แปลกปลอมหลุดเข้ามาในตาราง', () => {
    const known: Capability[] = ['floor', 'kitchen', 'settings', 'accounts']
    for (const caps of Object.values(CAPABILITIES)) {
      for (const c of caps) expect(known).toContain(c)
    }
  })
})
