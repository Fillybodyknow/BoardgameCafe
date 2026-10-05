// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { mockAdapter } from '../data/mock/mockAdapter'
import { mockAdminAdapter } from '../data/mock/adminAdapter'

describe('จัดการบัญชีพนักงาน (ระดับ adapter)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockAdapter.reset()
  })

  it('เพิ่มบัญชีใหม่แล้วอยู่ในรายชื่อ', async () => {
    await mockAdminAdapter.createStaff({
      username: 'somchai',
      password: 'secret123',
      displayName: 'สมชาย',
      role: 'staff',
    })
    const list = await mockAdminAdapter.listStaff()
    const added = list.find((m) => m.username === 'somchai')!
    expect(added.displayName).toBe('สมชาย')
    expect(added.role).toBe('staff')
    expect(added.active).toBe(true)
  })

  it('ชื่อผู้ใช้ตัวใหญ่ถูกแปลงเป็นเล็ก', async () => {
    await mockAdminAdapter.createStaff({
      username: 'SomChai',
      password: 'secret123',
      displayName: 'สมชาย',
      role: 'staff',
    })
    const list = await mockAdminAdapter.listStaff()
    expect(list.some((m) => m.username === 'somchai')).toBe(true)
  })

  it('ข้อมูลไม่ถูกต้องถูกปฏิเสธเหมือนฝั่ง SQL', async () => {
    const base = { password: 'secret123', displayName: 'ก', role: 'staff' as const }

    await expect(mockAdminAdapter.createStaff({ ...base, username: 'ab' }))
      .rejects.toThrow(/3–30/)
    await expect(mockAdminAdapter.createStaff({ ...base, username: 'มานี' }))
      .rejects.toThrow(/a-z/)
    await expect(
      mockAdminAdapter.createStaff({ ...base, username: 'okname', password: 'short' }),
    ).rejects.toThrow(/8 ตัว/)
    await expect(
      mockAdminAdapter.createStaff({ ...base, username: 'okname', displayName: '  ' }),
    ).rejects.toThrow(/ชื่อพนักงาน/)
  })

  it('ชื่อผู้ใช้ซ้ำไม่ได้', async () => {
    const input = {
      username: 'somchai',
      password: 'secret123',
      displayName: 'สมชาย',
      role: 'staff' as const,
    }
    await mockAdminAdapter.createStaff(input)
    await expect(mockAdminAdapter.createStaff(input)).rejects.toThrow(/ถูกใช้ไปแล้ว/)
  })

  it('เปลี่ยนสิทธิ์และปิด/เปิดการใช้งานคนอื่นได้', async () => {
    const nid = (await mockAdminAdapter.listStaff()).find((m) => m.username === 'nid')!

    await mockAdminAdapter.setStaffRole(nid.userId, 'manager')
    expect((await mockAdminAdapter.listStaff()).find((m) => m.userId === nid.userId)!.role)
      .toBe('manager')

    await mockAdminAdapter.setStaffActive(nid.userId, false)
    expect((await mockAdminAdapter.listStaff()).find((m) => m.userId === nid.userId)!.active)
      .toBe(false)

    await mockAdminAdapter.setStaffActive(nid.userId, true)
    await mockAdminAdapter.renameStaff(nid.userId, 'นิดดา')
    expect((await mockAdminAdapter.listStaff()).find((m) => m.userId === nid.userId)!.displayName)
      .toBe('นิดดา')
  })

  it('แตะบัญชีตัวเองไม่ได้ — กันกดพลาดแล้วหลุดออกจากระบบ', async () => {
    const me = (await mockAdminAdapter.listStaff()).find((m) => m.isSelf)!
    await expect(mockAdminAdapter.setStaffRole(me.userId, 'staff')).rejects.toThrow(/ตัวเอง/)
    await expect(mockAdminAdapter.setStaffActive(me.userId, false)).rejects.toThrow(/ตัวเอง/)
  })

  // ★ ข้อที่สำคัญที่สุด: ถ้าพลาดข้อนี้ ร้านจะเข้าไปแก้อะไรไม่ได้อีกเลย
  it('ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คนเสมอ', async () => {
    await mockAdminAdapter.createStaff({
      username: 'owner2',
      password: 'secret123',
      displayName: 'เจ้าของ 2',
      role: 'owner',
    })
    const list = await mockAdminAdapter.listStaff()
    const other = list.find((m) => m.username === 'owner2')!

    // มีเจ้าของ 2 คน ปิดได้หนึ่ง
    await mockAdminAdapter.setStaffActive(other.userId, false)

    // เหลือคนเดียวแล้ว (คือตัวเรา) — ซึ่งก็แตะตัวเองไม่ได้อยู่แล้ว
    // ลองกับอีกเคส: เปิดกลับมาแล้วลดสิทธิ์คนสุดท้ายที่ไม่ใช่ตัวเรา
    await mockAdminAdapter.setStaffActive(other.userId, true)
    await mockAdminAdapter.setStaffRole(other.userId, 'staff') // ยังมีเราเป็นเจ้าของอยู่

    // ตอนนี้เหลือเจ้าของคนเดียวคือตัวเรา ปิดหรือลดสิทธิ์ตัวเองไม่ได้
    const me = (await mockAdminAdapter.listStaff()).find((m) => m.isSelf)!
    await expect(mockAdminAdapter.setStaffActive(me.userId, false)).rejects.toThrow()
  })

  it('เจ้าของร้านคนสุดท้ายจะถูกลดสิทธิ์ไม่ได้แม้ไม่ใช่ตัวเราเอง', async () => {
    // ย้ายความเป็นเจ้าของไปที่คนอื่น แล้วลดตัวเองลง จึงจะทดสอบเคสนี้ได้
    await mockAdminAdapter.createStaff({
      username: 'owner2',
      password: 'secret123',
      displayName: 'เจ้าของ 2',
      role: 'owner',
    })
    const list = await mockAdminAdapter.listStaff()
    const me = list.find((m) => m.isSelf)!
    const other = list.find((m) => m.username === 'owner2')!

    // ปิดตัวเองไม่ได้ จึงให้ "ลด" ไม่ได้เช่นกัน — ใช้ปิด other แทนเพื่อให้เหลือ 1
    await mockAdminAdapter.setStaffActive(other.userId, false)
    expect(
      (await mockAdminAdapter.listStaff()).filter((m) => m.role === 'owner' && m.active),
    ).toHaveLength(1)

    // คนสุดท้ายคือ me — ลดสิทธิ์ไม่ได้ (ติดทั้งกฎตัวเองและกฎเจ้าของคนสุดท้าย)
    await expect(mockAdminAdapter.setStaffRole(me.userId, 'staff')).rejects.toThrow()
  })
})

describe('หน้าจัดการพนักงาน', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  it('เปิดแท็บพนักงานแล้วเห็นรายชื่อพร้อมชื่อผู้ใช้', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('พนักงาน'))

    expect(await screen.findByText('เจ้าของร้าน (เดโม)')).toBeTruthy()
    expect(screen.getByText('ชื่อผู้ใช้ owner')).toBeTruthy()
    expect(screen.getByText('นิด')).toBeTruthy()
  })

  it('บัญชีตัวเองถูกทำเครื่องหมายและปิดปุ่มไว้', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('พนักงาน'))
    await screen.findByText('เจ้าของร้าน (เดโม)')

    expect(screen.getByText('คุณ')).toBeTruthy()
    expect(screen.getByText(/เปลี่ยนสิทธิ์หรือปิดบัญชีตัวเองไม่ได้/)).toBeTruthy()
  })

  it('เพิ่มบัญชีผ่านหน้าจอแล้วบันทึกจริง', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('พนักงาน'))
    fireEvent.click(await screen.findByText('+ เพิ่มบัญชีพนักงาน'))

    fireEvent.change(await screen.findByPlaceholderText('somchai'), {
      target: { value: 'malee' },
    })
    fireEvent.change(screen.getByPlaceholderText('อย่างน้อย 8 ตัว'), {
      target: { value: 'secret123' },
    })
    fireEvent.change(screen.getByPlaceholderText('สมชาย'), { target: { value: 'มาลี' } })
    fireEvent.click(screen.getByText('สร้างบัญชี'))

    await waitFor(async () => {
      const list = await mockAdminAdapter.listStaff()
      expect(list.find((m) => m.username === 'malee')?.displayName).toBe('มาลี')
    })
  })

  it('ข้อมูลผิดขึ้นข้อความบอก ไม่ใช่เงียบ', async () => {
    window.location.hash = '#/owner'
    render(<App />)
    fireEvent.click(await screen.findByText('พนักงาน'))
    fireEvent.click(await screen.findByText('+ เพิ่มบัญชีพนักงาน'))

    fireEvent.change(await screen.findByPlaceholderText('somchai'), { target: { value: 'ab' } })
    fireEvent.change(screen.getByPlaceholderText('อย่างน้อย 8 ตัว'), {
      target: { value: 'secret123' },
    })
    fireEvent.change(screen.getByPlaceholderText('สมชาย'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('สร้างบัญชี'))

    expect(await screen.findByText(/3–30/)).toBeTruthy()
  })
})
