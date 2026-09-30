// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import PaymentDialog from './PaymentDialog'
import { mockAdapter } from '../data/mock/mockAdapter'
import { db } from '../data'
import { computeBill } from '../domain/pricing'
import type { BillPreview, GuestPass, RatePlan } from '../domain/types'

const NOW = new Date('2026-09-30T18:00:00Z')
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

const plan: RatePlan = {
  id: 'rp', name: 'ทั่วไป', pricePerHour: 60,
  roundToMinutes: 30, minimumMinutes: 60, dayPassCap: null,
}

const passes: GuestPass[] = ['A', 'B', 'C'].map((n) => ({
  id: `p-${n}`, visitId: 'v-1', displayName: n, ratePlanId: 'rp',
  status: 'active', checkedInAt: ago(60), checkedOutAt: null,
  pausedMinutes: 0, pausedAt: null,
}))

function buildBill(): BillPreview {
  return computeBill({
    visitId: 'v-1',
    passes,
    orders: [{
      id: 'o1', visitId: 'v-1', orderedByPassId: 'p-A', placedBy: 'guest',
      splitMode: 'owner', tableIdSnapshot: null, status: 'served', placedAt: ago(30),
      lines: [{ id: 'l1', menuItemId: 'm', nameSnapshot: 'กาแฟ', unitPriceSnapshot: 65, qty: 1 }],
    }],
    ratePlans: { rp: plan },
    now: NOW,
  })
}

function open(bill: BillPreview, onPaid = () => {}) {
  return render(
    <MemoryRouter>
      <PaymentDialog
        visitCode="V-001"
        bill={bill}
        passes={passes}
        onClose={() => {}}
        onPaid={onPaid}
      />
    </MemoryRouter>,
  )
}

describe('หน้ารับชำระเงิน', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    mockAdapter.reset()
    vi.restoreAllMocks()
  })

  it('แสดงยอดสุทธิจากบิล', () => {
    const bill = buildBill()
    expect(bill.total).toBe(245) // 60*3 + 65
    open(bill)
    expect(screen.getByText('฿245.00')).toBeTruthy()
  })

  it('คำนวณเงินทอนถูกต้อง', () => {
    open(buildBill())
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    expect(screen.getByText('เงินทอน')).toBeTruthy()
    expect(screen.getByText('฿255.00')).toBeTruthy()
  })

  it('รับเงินไม่พอ ยืนยันไม่ได้', () => {
    open(buildBill())
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100' } })
    expect(screen.getByText('ยังขาด')).toBeTruthy()
    expect(screen.getByText('฿145.00')).toBeTruthy()
    expect((screen.getByText('ยืนยันรับเงิน') as HTMLButtonElement).disabled).toBe(true)
  })

  it('หารเท่ากันแล้วผลรวมต้องตรงกับยอดบิลพอดี (ไม่ทำเศษสตางค์หาย)', () => {
    const bill = buildBill()
    open(bill)
    fireEvent.click(screen.getByText('หารเท่ากัน'))

    // 245 / 3 = 81.666… → 81.67 + 81.67 + 81.66 ต้องได้ 245 พอดี
    const amounts = [...document.querySelectorAll('.tabular.font-bold')]
      .map((el) => Number(el.textContent!.replace(/[฿,]/g, '')))
      .filter((n) => n > 0 && n < bill.total)
    expect(amounts).toHaveLength(3)
    expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(bill.total, 2)
  })

  it('แยกบิลแล้วต้องกดรับเงินครบทุกคนก่อนจึงยืนยันได้', async () => {
    const bill = buildBill()
    open(bill)
    fireEvent.click(screen.getByText('แยกตามคนสั่ง'))

    const confirm = screen.getByText('ยืนยันรับเงิน') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    for (const btn of screen.getAllByText('เงินสด')) fireEvent.click(btn)
    await waitFor(() => {
      expect((screen.getByText('ยืนยันรับเงิน') as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('ส่งยอดและวิธีจ่ายไปให้ closeVisit ครบถ้วน', async () => {
    const bill = buildBill()
    const spy = vi.spyOn(db, 'closeVisit').mockResolvedValue(undefined)
    const onPaid = vi.fn()

    open(bill, onPaid)
    fireEvent.click(screen.getByText('โอน / พร้อมเพย์'))
    fireEvent.click(screen.getByText('ยืนยันรับเงิน'))

    await waitFor(() => expect(onPaid).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledWith('v-1', [{ method: 'transfer', amount: 245 }])
  })

  it('แยกบิลแล้วส่งไปทีละคนพร้อมระบุว่าจ่ายแทนใคร', async () => {
    const bill = buildBill()
    const spy = vi.spyOn(db, 'closeVisit').mockResolvedValue(undefined)

    open(bill)
    fireEvent.click(screen.getByText('หารเท่ากัน'))
    for (const btn of screen.getAllByText('เงินสด')) fireEvent.click(btn)
    fireEvent.click(screen.getByText('ยืนยันรับเงิน'))

    await waitFor(() => expect(spy).toHaveBeenCalled())
    const payments = spy.mock.calls[0]![1]!
    expect(payments).toHaveLength(3)
    expect(payments.every((p) => p.paidFor?.length === 1)).toBe(true)
    const sum = payments.reduce((s, p) => s + p.amount, 0)
    expect(sum).toBeCloseTo(bill.total, 2)
  })
})
