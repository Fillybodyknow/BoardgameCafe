import { useMemo, useState } from 'react'
import { db } from '../data'
import { formatBaht, splitByOwner } from '../domain/pricing'
import type { BillPreview, GuestPass, PaymentInput, PaymentMethod } from '../domain/types'
import { Button, Card, Modal, Segmented } from '../components/ui'

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  transfer: 'โอน / พร้อมเพย์',
}

const METHOD_ICON: Record<PaymentMethod, string> = {
  cash: '🪙',
  transfer: '📜',
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

/*
  หมายเหตุสำหรับคนแก้หน้านี้: เทสต์นับยอดรายคนจาก `.tabular.font-bold`
  ในโหมดแยกบิล — อย่าใส่สองคลาสนี้คู่กันกับตัวเลขอื่นที่น้อยกว่ายอดบิล
*/
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
    <Modal
      title={`รับชำระเงิน · ${visitCode}`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          {error && <p className="mb-2 animate-shake text-sm text-crimson">{error}</p>}
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
        </>
      }
    >
      <div className="text-center">
        <div className="text-xs tracking-[0.2em] text-ink-faint uppercase">ยอดที่ต้องชำระ</div>
        <div className="tabular mt-1 text-4xl font-bold text-gold-deep">฿{formatBaht(bill.total)}</div>
      </div>

      <Segmented
        className="mt-4 w-full"
        value={mode}
        onChange={(m) => {
          setMode(m)
          setSettled({})
        }}
        options={(Object.keys(MODE_LABEL) as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
      />

      <div key={mode} className="mt-5 animate-page">
        {mode === 'together' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
                <div key={m} className="relative">
                  <span className="pointer-events-none absolute top-2 left-3 text-lg" aria-hidden>
                    {METHOD_ICON[m]}
                  </span>
                  <button
                    type="button"
                    aria-pressed={method === m}
                    onClick={() => setMethod(m)}
                    className="pick w-full px-3 pt-8 pb-3 text-left text-sm font-medium"
                  >
                    {METHOD_LABEL[m]}
                  </button>
                </div>
              ))}
            </div>

            {method === 'cash' && (
              <div className="mt-4">
                <label className="text-xs font-medium text-ink-soft">รับเงินมา</label>
                <input
                  inputMode="decimal"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                  placeholder="0.00"
                  className="field tabular mt-1 !py-3 text-right !text-2xl"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[100, 500, 1000].map((n) => (
                    <button key={n} type="button" className="chip" onClick={() => setReceived(String(n))}>
                      ฿{n}
                    </button>
                  ))}
                  <button type="button" className="chip" onClick={() => setReceived(String(bill.total))}>
                    พอดี
                  </button>
                </div>
                {cash > 0 && (
                  <div
                    className={`tabular mt-4 flex items-baseline justify-between rounded-lg border p-3 text-lg font-bold ${
                      change < 0
                        ? 'animate-shake border-crimson/30 bg-crimson/10 text-crimson-deep'
                        : 'border-forest/30 bg-forest/10 text-forest-deep'
                    }`}
                  >
                    <span>{change < 0 ? 'ยังขาด' : 'เงินทอน'}</span>
                    <span>฿{formatBaht(Math.abs(change))}</span>
                  </div>
                )}
              </div>
            )}

            {method === 'transfer' && (
              <p className="mt-4 rounded-lg border border-lapis/25 bg-lapis/5 p-3 text-sm text-lapis-deep">
                ตรวจสลิปให้ตรงยอด ฿{formatBaht(bill.total)} ก่อนกดยืนยัน
              </p>
            )}
          </>
        ) : (
          <div className="space-y-2">
            {shares.map((s) => {
              const paid = settled[s.passId]
              return (
                <Card key={s.passId} className={`transition ${paid ? '!border-forest/50 !bg-forest/5' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-semibold">
                      {paid && (
                        <span className="wax-seal seal-stamp h-6 w-6 text-[0.6rem]" aria-hidden>
                          ✓
                        </span>
                      )}
                      {s.name}
                    </span>
                    <span className="tabular font-bold">฿{formatBaht(s.amount)}</span>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
                      <Button
                        key={m}
                        className="flex-1"
                        variant={paid === m ? 'forest' : 'ghost'}
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

            {/* แถบความคืบหน้าการรับเงิน */}
            <div className="pt-2">
              <div className="h-2 overflow-hidden rounded-full bg-parchment-deep">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-gold to-gold-light transition-all duration-500"
                  style={{ width: `${bill.total > 0 ? Math.min(100, (paidTotal / bill.total) * 100) : 0}%` }}
                />
              </div>
              <div className="tabular mt-2 flex justify-between text-sm">
                <span className="text-ink-faint">รับแล้ว ฿{formatBaht(paidTotal)}</span>
                <span className={outstanding > 0 ? 'text-ember-deep' : 'text-forest-deep'}>
                  คงเหลือ ฿{formatBaht(Math.max(0, outstanding))}
                </span>
              </div>
            </div>

            {Math.abs(splitTotal - bill.total) > 0.01 && (
              <p className="text-xs text-crimson">
                ผลรวมบิลย่อย ฿{formatBaht(splitTotal)} ไม่ตรงกับยอดบิล ฿{formatBaht(bill.total)}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
