import { useMemo, useState } from 'react'
import { db } from '../data'
import { formatBaht, splitByOwner } from '../domain/pricing'
import type { BillPreview, GuestPass, PaymentInput, PaymentMethod } from '../domain/types'
import { Button, Card } from '../components/ui'

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  transfer: 'โอน / พร้อมเพย์',
}

type Mode = 'together' | 'by_owner' | 'evenly'

const MODE_LABEL: Record<Mode, string> = {
  together: 'จ่ายรวม',
  by_owner: 'แยกตามคนสั่ง',
  evenly: 'หารเท่ากัน',
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

export default function PaymentDialog({
  visitCode,
  bill,
  passes,
  onClose,
  onPaid,
}: {
  visitCode: string
  bill: BillPreview
  passes: GuestPass[]
  onClose: () => void
  onPaid: () => void
}) {
  const [mode, setMode] = useState<Mode>('together')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [received, setReceived] = useState('')
  const [settled, setSettled] = useState<Record<string, PaymentMethod>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const billable = passes.filter((p) => p.status !== 'billed')

  /** ยอดที่แต่ละคนต้องจ่าย ตามโหมดที่เลือก */
  const shares = useMemo(() => {
    if (mode === 'by_owner') {
      return splitByOwner(bill, billable).map((s) => ({
        passId: s.pass.id,
        name: s.pass.displayName,
        amount: s.total,
      }))
    }
    if (mode === 'evenly') {
      const each = billable.length > 0 ? round2(bill.total / billable.length) : 0
      // เศษสตางค์ตกกับคนแรก เพื่อให้ผลรวมตรงกับยอดบิลเสมอ
      const remainder = round2(bill.total - each * billable.length)
      return billable.map((p, i) => ({
        passId: p.id,
        name: p.displayName,
        amount: i === 0 ? round2(each + remainder) : each,
      }))
    }
    return []
  }, [mode, bill, billable])

  const splitTotal = shares.reduce((s, x) => s + x.amount, 0)
  const paidTotal = shares.filter((s) => settled[s.passId]).reduce((s, x) => s + x.amount, 0)
  const outstanding = round2(bill.total - paidTotal)

  const cash = Number(received.replace(/[^0-9.]/g, '')) || 0
  const change = cash > 0 ? round2(cash - bill.total) : 0

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const payments: PaymentInput[] =
        mode === 'together'
          ? [{ method, amount: bill.total }]
          : shares
              .filter((s) => settled[s.passId])
              .map((s) => ({
                method: settled[s.passId]!,
                amount: s.amount,
                paidFor: [s.passId],
              }))

      await db.closeVisit(bill.visitId, payments)
      onPaid()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ปิดบิลไม่สำเร็จ')
      setBusy(false)
    }
  }

  const everyoneSettled = mode === 'together' || shares.every((s) => settled[s.passId])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-slate-800 bg-slate-900 sm:rounded-2xl">
        <div className="border-b border-slate-800 p-5">
          <h3 className="text-lg font-bold">รับชำระเงิน · {visitCode}</h3>
          <div className="tabular mt-1 text-3xl font-bold text-emerald-400">
            ฿{formatBaht(bill.total)}
          </div>

          <div className="mt-3 flex flex-wrap gap-1">
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <Button
                key={m}
                variant={mode === m ? 'subtle' : 'ghost'}
                onClick={() => {
                  setMode(m)
                  setSettled({})
                }}
              >
                {MODE_LABEL[m]}
              </Button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {mode === 'together' ? (
            <>
              <div className="flex gap-1">
                {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
                  <Button
                    key={m}
                    className="flex-1"
                    variant={method === m ? 'primary' : 'ghost'}
                    onClick={() => setMethod(m)}
                  >
                    {METHOD_LABEL[m]}
                  </Button>
                ))}
              </div>

              {method === 'cash' && (
                <div className="mt-4">
                  <label className="text-sm text-slate-400">รับเงินมา</label>
                  <input
                    inputMode="decimal"
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                    placeholder="0.00"
                    className="tabular mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-right text-lg outline-none focus:border-emerald-600"
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {[100, 500, 1000].map((n) => (
                      <Button key={n} onClick={() => setReceived(String(n))}>
                        ฿{n}
                      </Button>
                    ))}
                    <Button onClick={() => setReceived(String(bill.total))}>พอดี</Button>
                  </div>
                  {cash > 0 && (
                    <div
                      className={`tabular mt-3 flex justify-between rounded-lg p-3 text-lg font-bold ${
                        change < 0 ? 'bg-rose-950/40 text-rose-300' : 'bg-emerald-950/40 text-emerald-300'
                      }`}
                    >
                      <span>{change < 0 ? 'ยังขาด' : 'เงินทอน'}</span>
                      <span>฿{formatBaht(Math.abs(change))}</span>
                    </div>
                  )}
                </div>
              )}

              {method === 'transfer' && (
                <p className="mt-4 rounded-lg bg-slate-800/60 p-3 text-sm text-slate-400">
                  ตรวจสลิปให้ตรงยอด ฿{formatBaht(bill.total)} ก่อนกดยืนยัน
                </p>
              )}
            </>
          ) : (
            <div className="space-y-2">
              {shares.map((s) => {
                const paid = settled[s.passId]
                return (
                  <Card key={s.passId} className={paid ? 'border-emerald-800/70' : ''}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{s.name}</span>
                      <span className="tabular font-bold">฿{formatBaht(s.amount)}</span>
                    </div>
                    <div className="mt-2 flex gap-1">
                      {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
                        <Button
                          key={m}
                          className="flex-1"
                          variant={paid === m ? 'primary' : 'ghost'}
                          onClick={() =>
                            setSettled((prev) => {
                              const next = { ...prev }
                              if (next[s.passId] === m) delete next[s.passId]
                              else next[s.passId] = m
                              return next
                            })
                          }
                        >
                          {METHOD_LABEL[m]}
                        </Button>
                      ))}
                    </div>
                  </Card>
                )
              })}

              <div className="tabular flex justify-between border-t border-slate-800 pt-3 text-sm">
                <span className="text-slate-400">รับแล้ว ฿{formatBaht(paidTotal)}</span>
                <span className={outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                  คงเหลือ ฿{formatBaht(Math.max(0, outstanding))}
                </span>
              </div>

              {Math.abs(splitTotal - bill.total) > 0.01 && (
                <p className="text-xs text-rose-400">
                  ผลรวมบิลย่อย ฿{formatBaht(splitTotal)} ไม่ตรงกับยอดบิล ฿{formatBaht(bill.total)}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 p-5">
          {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose} disabled={busy}>
              ยกเลิก
            </Button>
            <Button
              className="flex-1"
              variant="primary"
              onClick={submit}
              disabled={busy || !everyoneSettled || (mode === 'together' && method === 'cash' && change < 0)}
            >
              {busy ? 'กำลังปิดบิล…' : 'ยืนยันรับเงิน'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
