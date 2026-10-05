import { useEffect, useState } from 'react'
import { db } from '../data'
import { formatBaht } from '../domain/pricing'
import type { GuestPass, PassSettlement, PaymentMethod } from '../domain/types'
import { Button, Modal } from '../components/ui'

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  transfer: 'โอน / พร้อมเพย์',
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * เก็บเงินคนที่กลับก่อน
 *
 * ยอดมาจากเซิร์ฟเวอร์เสมอ (pass_settlement) ไม่คิดเองที่นี่ เพราะการหาร
 * ของกลางต้องรู้ว่าตอนนี้เหลือกี่คนและจ่ายไปแล้วเท่าไร ซึ่งเป็นสถานะที่
 * เปลี่ยนได้ตลอดจากเครื่องอื่น
 */
export default function SettleDialog({
  pass,
  onClose,
  onSettled,
}: {
  pass: GuestPass
  onClose: () => void
  onSettled: (name: string) => void
}) {
  const [calc, setCalc] = useState<PassSettlement | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [received, setReceived] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    db.passSettlement(pass.id)
      .then((c) => alive && setCalc(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'คิดยอดไม่สำเร็จ'))
    return () => {
      alive = false
    }
  }, [pass.id])

  const total = calc?.total ?? 0
  const cash = Number(received.replace(/[^0-9.]/g, '')) || 0
  const change = cash > 0 ? round2(cash - total) : 0

  async function submit() {
    if (!calc) return
    setBusy(true)
    setError(null)
    try {
      await db.settlePass(pass.id, [{ method, amount: calc.total, paidFor: [pass.id] }])
      onSettled(pass.displayName)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เก็บเงินไม่สำเร็จ')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`เก็บเงิน · ${pass.displayName}`}
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
              disabled={busy || !calc || (method === 'cash' && cash > 0 && change < 0)}
            >
              {busy ? 'กำลังเก็บเงิน…' : 'รับเงินแล้วให้กลับได้'}
            </Button>
          </div>
        </>
      }
    >
      {!calc ? (
        <p className="py-6 text-center text-sm text-ink-faint">กำลังคิดยอด…</p>
      ) : (
        <>
          <div className="text-center">
            <div className="text-xs tracking-[0.2em] text-ink-faint uppercase">ยอดของคนนี้</div>
            <div className="tabular mt-1 text-4xl font-bold text-gold-deep">
              ฿{formatBaht(calc.total)}
            </div>
          </div>

          <div className="mt-4 space-y-1 rounded-lg bg-parchment-deep/60 p-3 text-sm">
            {calc.ownLines.map((l) => (
              <div key={l.id} className="flex justify-between gap-2">
                <span className="min-w-0 truncate">
                  {l.label}
                  {l.qty > 1 && <span className="text-ink-faint"> ×{l.qty}</span>}
                </span>
                <span className="tabular shrink-0">฿{formatBaht(l.amount)}</span>
              </div>
            ))}
            {calc.sharedShare !== 0 && (
              <div className="flex justify-between gap-2">
                <span>ส่วนแบ่งของที่หารกัน ({calc.headcount} คน)</span>
                <span className="tabular shrink-0">฿{formatBaht(calc.sharedShare)}</span>
              </div>
            )}
            {calc.ownLines.length === 0 && calc.sharedShare === 0 && (
              <p className="text-ink-faint">ไม่มียอดต้องชำระ</p>
            )}
          </div>

          <p className="mt-3 text-xs text-ink-faint">
            คนที่เหลืออีก {Math.max(0, calc.headcount - 1)} คนยังเล่นต่อได้ ของที่สั่งหลังจากนี้
            จะหารเฉพาะคนที่ยังอยู่
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                onClick={() => setMethod(m)}
                className="pick w-full px-3 py-3 text-sm font-medium"
              >
                {METHOD_LABEL[m]}
              </button>
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
                <button type="button" className="chip" onClick={() => setReceived(String(calc.total))}>
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
        </>
      )}
    </Modal>
  )
}
