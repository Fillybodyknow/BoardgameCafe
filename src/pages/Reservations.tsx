import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import { Badge, Button, Card, Empty, SectionTitle } from '../components/ui'
import type { CafeTable, Reservation, ReservationStatus } from '../domain/types'
import type { Tone } from '../components/ui'

/** เลยเวลานัดเกินนี้แล้วยังไม่มา → เตือนพนักงานให้ปล่อยโต๊ะ */
const GRACE_MINUTES = 20

const TONE: Record<ReservationStatus, Tone> = {
  pending: 'amber', confirmed: 'sky', seated: 'emerald', no_show: 'rose', cancelled: 'slate',
}
const LABEL: Record<ReservationStatus, string> = {
  pending: 'รอยืนยัน', confirmed: 'ยืนยันแล้ว', seated: 'เช็คอินแล้ว',
  no_show: 'ไม่มา', cancelled: 'ยกเลิก',
}

type Filter = 'active' | 'all'

export default function Reservations() {
  const { data } = useSnapshot()
  const now = useNow(30_000)
  const [filter, setFilter] = useState<Filter>('active')
  const [seating, setSeating] = useState<Reservation | null>(null)

  const sorted = useMemo(() => {
    const list = [...(data?.reservations ?? [])]
    return list.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
  }, [data])

  if (!data) return null

  const shown = filter === 'active'
    ? sorted.filter((r) => r.status === 'pending' || r.status === 'confirmed')
    : sorted

  const pendingCount = sorted.filter((r) => r.status === 'pending').length

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          <div className="flex gap-1">
            <Button
              variant={filter === 'active' ? 'subtle' : 'ghost'}
              onClick={() => setFilter('active')}
            >
              ที่ยังไม่จบ
            </Button>
            <Button variant={filter === 'all' ? 'subtle' : 'ghost'} onClick={() => setFilter('all')}>
              ทั้งหมด
            </Button>
          </div>
        }
      >
        คิวจอง {pendingCount > 0 && <span className="text-amber-400">· รอยืนยัน {pendingCount}</span>}
      </SectionTitle>

      {shown.length === 0 ? (
        <Empty>{filter === 'active' ? 'ไม่มีคิวจองค้างอยู่' : 'ยังไม่มีการจอง'}</Empty>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            <ReservationCard
              key={r.id}
              reservation={r}
              tables={data.tables}
              now={now}
              onSeat={() => setSeating(r)}
            />
          ))}
        </div>
      )}

      {seating && <SeatDialog reservation={seating} onClose={() => setSeating(null)} />}
    </div>
  )
}

function ReservationCard({
  reservation: r,
  tables,
  now,
  onSeat,
}: {
  reservation: Reservation
  tables: CafeTable[]
  now: Date
  onSeat: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = new Date(r.startAt)
  const lateBy = Math.floor((now.getTime() - start.getTime()) / 60_000)
  const open = r.status === 'pending' || r.status === 'confirmed'
  const overdue = open && lateBy > GRACE_MINUTES
  const codes = r.tableIds.map((id) => tables.find((t) => t.id === id)?.code).filter(Boolean)

  // โต๊ะที่จองไว้ยังมีกลุ่มก่อนหน้านั่งอยู่ไหม — เตือนก่อนพนักงานกดเช็คอิน
  const busyTables = r.tableIds
    .map((id) => tables.find((t) => t.id === id))
    .filter((t) => t && !t.allowShare && t.status === 'occupied')
    .map((t) => t!.code)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={overdue ? 'border-rose-700/70 bg-rose-950/20' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{r.customerName}</span>
            <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
            {r.source === 'online' && <Badge tone="violet">จองออนไลน์</Badge>}
            {overdue && <Badge tone="rose">เลยเวลา {lateBy} นาที</Badge>}
          </div>
          <div className="tabular mt-1 text-sm text-slate-400">
            {r.partySize} คน · {r.durationMinutes / 60} ชม. · {r.phone}
            {codes.length > 0 && <> · โต๊ะ {codes.join(', ')}</>}
            {r.code && <> · รหัส {r.code}</>}
          </div>
          {r.note && <div className="mt-1 text-sm text-amber-400/90">📝 {r.note}</div>}
        </div>

        <div className="tabular text-right">
          <div className="text-lg font-bold">
            {start.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div className="text-xs text-slate-500">
            {start.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}
            {' · '}
            {lateBy < 0 ? `อีก ${-lateBy} นาที` : `ผ่านมา ${lateBy} นาที`}
          </div>
        </div>
      </div>

      {busyTables.length > 0 && open && (
        <p className="mt-2 rounded-lg bg-amber-950/40 p-2 text-xs text-amber-300">
          โต๊ะ {busyTables.join(', ')} ยังมีลูกค้าอยู่ — ปิดบิลโต๊ะเดิมก่อน หรือเลือกโต๊ะอื่นตอนเช็คอิน
        </p>
      )}

      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}

      {open && (
        <div className="mt-3 flex flex-wrap gap-1">
          {r.status === 'pending' && (
            <Button variant="primary" disabled={busy} onClick={() => act(() => db.confirmReservation(r.id))}>
              ยืนยัน
            </Button>
          )}
          <Button variant="subtle" disabled={busy} onClick={onSeat}>
            เช็คอิน
          </Button>
          <Button disabled={busy} onClick={() => act(() => db.markNoShow(r.id))}>
            ไม่มา
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const reason = prompt('เหตุผลที่ปฏิเสธ (ไม่ใส่ก็ได้)') ?? undefined
                await db.rejectReservation(r.id, reason)
              })
            }
          >
            ปฏิเสธ
          </Button>
        </div>
      )}
    </Card>
  )
}

/** เช็คอิน: ใส่ชื่อผู้เล่นและเลือกโต๊ะจริง (อาจต่างจากที่จองไว้) */
function SeatDialog({ reservation: r, onClose }: { reservation: Reservation; onClose: () => void }) {
  const { data } = useSnapshot()
  const navigate = useNavigate()
  const [guests, setGuests] = useState<{ name: string; ratePlanId: string }[]>(() =>
    Array.from({ length: r.partySize }, () => ({ name: '', ratePlanId: '' })),
  )
  const [tableIds, setTableIds] = useState<string[]>(r.tableIds)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!data) return null

  const defaultPlanId = data.ratePlans[0]?.id ?? ''
  const selectable = data.tables.filter(
    (t) => t.status === 'free' || t.allowShare || r.tableIds.includes(t.id),
  )

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const visit = await db.seatReservation(
        r.id,
        guests.map((g, i) => ({
          name: g.name.trim() || `ผู้เล่น ${i + 1}`,
          ratePlanId: g.ratePlanId || defaultPlanId,
        })),
        tableIds,
      )
      navigate(`/visit/${visit.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เช็คอินไม่สำเร็จ')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-slate-800 bg-slate-900 sm:rounded-2xl">
        <div className="border-b border-slate-800 p-5">
          <h3 className="text-lg font-bold">เช็คอิน · {r.customerName}</h3>
          <p className="mt-1 text-sm text-slate-400">
            จอง {r.partySize} คน · {r.durationMinutes / 60} ชม.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              โต๊ะ
            </h4>
            <div className="grid grid-cols-4 gap-2">
              {selectable.map((t) => {
                const on = tableIds.includes(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() =>
                      setTableIds((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))
                    }
                    className={`rounded-lg border px-2 py-2 text-sm transition ${
                      on ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700'
                    }`}
                  >
                    <div className="font-bold">{t.code}</div>
                    {t.status === 'occupied' && !t.allowShare && (
                      <div className="text-xs text-rose-400">ไม่ว่าง</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              ผู้เล่น
            </h4>
            <div className="space-y-2">
              {guests.map((g, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={g.name}
                    onChange={(e) =>
                      setGuests((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                    placeholder={`ชื่อเล่นคนที่ ${i + 1}`}
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
                  />
                  <select
                    value={g.ratePlanId || defaultPlanId}
                    onChange={(e) =>
                      setGuests((p) =>
                        p.map((x, j) => (j === i ? { ...x, ratePlanId: e.target.value } : x)),
                      )
                    }
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm outline-none"
                  >
                    {data.ratePlans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name}
                      </option>
                    ))}
                  </select>
                  {guests.length > 1 && (
                    <Button variant="danger" onClick={() => setGuests((p) => p.filter((_, j) => j !== i))}>
                      ✕
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <Button
              variant="subtle"
              className="mt-2 w-full"
              onClick={() => setGuests((p) => [...p, { name: '', ratePlanId: '' }])}
            >
              + เพิ่มคน (มาเกินที่จองไว้)
            </Button>
          </div>
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
              disabled={busy || tableIds.length === 0 || guests.length === 0}
              onClick={submit}
            >
              เปิดโต๊ะ
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
