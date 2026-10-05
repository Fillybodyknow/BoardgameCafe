// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App, { qc } from '../App'
import { mockAdapter } from '../data/mock/mockAdapter'
import { mockAdminAdapter } from '../data/mock/adminAdapter'

/**
 * ชื่อร้านและโลโก้ — เจ้าของร้านแก้ได้ ผู้จัดการไม่เห็นแท็บ
 * ฝั่ง SQL ตรวจสิทธิ์จริงไว้ใน supabase/tests/99_shop_profile_test.sql
 */
describe('ชื่อร้านและโลโก้', () => {
  beforeEach(() => {
    cleanup()
    qc.clear()
    localStorage.clear()
    mockAdapter.reset()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('เจ้าของร้านเปลี่ยนชื่อร้าน แล้วแถบเมนูเปลี่ยนตามทันที', async () => {
    window.location.hash = '#/owner'
    render(<App />)

    fireEvent.click(await screen.findByText('ชื่อร้าน & โลโก้'))
    fireEvent.change(await screen.findByPlaceholderText('เช่น ร้านเกมป้าแดง'), {
      target: { value: 'ร้านเกมป้าแดง' },
    })
    fireEvent.click(screen.getByText('บันทึกชื่อร้าน'))

    expect(await screen.findByText(/บันทึกชื่อร้านแล้ว/)).toBeTruthy()
    // แถบเมนู + ตัวอย่างในแท็บ (หัวใบ QR ในตัวอย่างอยู่คนละ element กับ ⚜)
    await waitFor(() => expect(screen.getAllByText('ร้านเกมป้าแดง').length).toBeGreaterThanOrEqual(2))
    expect(document.title).toBe('ร้านเกมป้าแดง')
  })

  it('หน้าจองของลูกค้าแสดงชื่อร้านที่ตั้งไว้', async () => {
    await mockAdminAdapter.saveShopProfile({ name: 'ร้านลูกเต๋าทอง', tagline: '' })
    window.location.hash = '#/book'
    render(<App />)
    expect(await screen.findByText('ร้านลูกเต๋าทอง')).toBeTruthy()
  })

  it('ชื่อร้านว่างหรือยาวเกินบันทึกไม่ได้', async () => {
    await expect(mockAdminAdapter.saveShopProfile({ name: '   ', tagline: '' })).rejects.toThrow()
    await expect(
      mockAdminAdapter.saveShopProfile({ name: 'ก'.repeat(61), tagline: '' }),
    ).rejects.toThrow()
  })

  it('ผู้จัดการไม่เห็นแท็บชื่อร้าน & โลโก้', async () => {
    vi.spyOn(mockAdminAdapter, 'myCapabilities').mockResolvedValue(['floor', 'kitchen', 'settings'])
    vi.spyOn(mockAdminAdapter, 'myRole').mockResolvedValue('manager')
    window.location.hash = '#/owner'
    render(<App />)

    expect(await screen.findByText('เวลาทำการ')).toBeTruthy()
    expect(screen.queryByText('ชื่อร้าน & โลโก้')).toBeNull()
  })
})
