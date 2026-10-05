import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import { placeholderName } from '../lib/placeholderName'
import { Badge, Button, Card, Empty, INPUT, Modal, PageHeader, Segmented } from '../components/ui'
import type { CafeTable, Reservation, ReservationStatus } from '../domain/types'
import type { Tone } from '../components/ui'

/** เลยเวลานัดเกินนี้แล้วยังไม่มา → เตือนพนักงานให้ปล่อยโต๊ะ */
const GRACE_MINUTES = 20

const TONE: Record<ReservationStatus, Tone> = {
  pending: 'ember', confirmed: 'lapis', seated: 'forest', no_show: 'crimson', cancelled: 'neutral',
}
const LABEL: Record<ReservationStatus, string> = {
  pending: 'รอยืนยัน', confirmed: 'ยืนยันแล้ว', seated: 'เช็คอินแล้ว',
  no_show: 'ไม่มา', cancelled: 'ยกเลิก',
}
// สีเส้นเวลาด้านซ้ายของการ์ด
const RAIL: Record<ReservationStatus, string> = {
  pending: 'bg-ember', confirmed: 'bg-lapis', seated: 'bg-forest', no_show: 'bg-crimson', cancelled: 'bg-line-strong',
}

type Filter = 'active' | 'all'

/** หัวกลุ่มวัน: วันนี้ / พรุ่งนี้ / เมื่อวาน / วันที่ */
function dayLabel(d: Date, now: Date) {
  const key = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  const diff = Math.round((new Date(key(d)).getTime() - new Date(key(now)).getTime()) / 86_400_000)
  const date = d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })
  if (diff === 0) return { title: 'วันนี้', date }
  if (diff === 1) return { title: 'พรุ่งนี้', date }
  if (diff === -1) return { title: 'เมื่อวาน', date }
  return { title: date, date: '' }
}

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

  // จัดกลุ่มตามวัน (เรียงเวลาอยู่แล้ว กลุ่มจึงเรียงตามไปด้วย)
  const days: { title: string; date: string; items: Reservation[] }[] = []
  for (const r of shown) {
    const label = dayLabel(new Date(r.startAt), now)
    const last = days[days.length - 1]
    if (last && last.title === label.title) last.items.push(r)
    else days.push({ ...label, items: [r] })
  }

  return (
    <div>
      <PageHeader
        eyebrow="สมุดนัดหมาย"
        title="คิวจอง"
        subtitle={
          pendingCount > 0 ? (
            <span className="text-ember-deep">มีคำขอรอยืนยัน {pendingCount} รายการ</span>
          ) : (
            'ไม่มีคำขอค้างยืนยัน'
          )
        }
        actions={
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'active', label: 'ที่ยังไม่จบ' },
              { value: 'all', label: 'ทั้งหมด' },
            ]}
          />
        }
      />

      {shown.length === 0 ? (
        <Empty icon="📜">{filter === 'active' ? 'ไม่มีคิวจองค้างอยู่' : 'ยังไม่มีการจอง'}</Empty>
      ) : (
        <div className="space-y-8">
          {days.map((day) => (
            <section key={day.title}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="font-display text-lg font-bold text-gold-deep">{day.title}</h2>
                {day.date && <span className="text-sm text-ink-faint">{day.date}</span>}
                <span className="h-px flex-1 bg-line-strong/60" />
              </div>
              <div className="space-y-3">
                {day.items.map((r) => (
                  <ReservationCard
                    key={r.id}
                    reservation={r}
                    tables={data.tables}
                    now={now}
                    onSeat={() => setSeating(r)}
                  />
                ))}
              </div>
            </section>
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
    <Card
      className={`flex gap-4 overflow-hidden !p-0 ${overdue ? 'animate-ember-pulse !border-crimson/50' : ''} ${
        open ? '' : 'opacity-70'
      }`}
    >
      <div className={`w-1.5 shrink-0 ${RAIL[r.status]}`} />

      {/* เวลานัด */}
      <div className="tabular flex w-20 shrink-0 flex-col items-center justify-center border-r border-dashed border-line py-4 text-center">
        <div className="text-xl leading-none font-bold">
          {start.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className={`mt-1 text-[0.7rem] ${overdue ? 'text-crimson' : 'text-ink-faint'}`}>
          {lateBy < 0 ? `อีก ${-lateBy} นาที` : `ผ่านมา ${lateBy} นาที`}
        </div>
      </div>

      <div className="min-w-0 flex-1 py-4 pr-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{r.customerName}</span>
          <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
          {r.source === 'online' && <Badge tone="royal">จองออนไลน์</Badge>}
          {overdue && <Badge tone="crimson">เลยเวลา {lateBy} นาที</Badge>}
        </div>
        <div className="tabular mt-1 flex flex-wrap gap-x-3 text-sm text-ink-soft">
          <span>{r.partySize} คน · {r.durationMinutes / 60} ชม.</span>
          <span>☎ {r.phone}</span>
          {codes.length > 0 && <span>โต๊ะ {codes.join(', ')}</span>}
          {r.code && <span className="text-ink-faint">รหัส {r.code}</span>}
        </div>
        {r.note && <div className="mt-1.5 text-sm text-ember-deep italic">“{r.note}”</div>}

        {busyTables.length > 0 && open && (
          <p className="mt-2 rounded-lg border border-ember/30 bg-ember/10 p-2 text-xs text-ember-deep">
            โต๊ะ {busyTables.join(', ')} ยังมีลูกค้าอยู่ — ปิดบิลโต๊ะเดิมก่อน หรือเลือกโต๊ะอื่นตอนเช็คอิน
          </p>
        )}

        {error && <p className="mt-2 animate-shake text-sm text-crimson">{error}</p>}

        {open && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {r.status === 'pending' && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => db.confirmReservation(r.id))}>
                ยืนยัน
              </Button>
            )}
            <Button variant="forest" disabled={busy} onClick={onSeat}>
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
      </div>
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
          name: g.name.trim() || placeholderName(i + 1),
          ratePlanId: g.ratePlanId || defaultPlanId,
        })),
        tableIds,
      )
      navigate(`/visit/${visit.id}`, { state: { slip: true } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เช็คอินไม่สำเร็จ')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`เช็คอิน · ${r.customerName}`}
      hint={`จอง ${r.partySize} คน · ${r.durationMinutes / 60} ชม.`}
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
              disabled={busy || tableIds.length === 0 || guests.length === 0}
              onClick={submit}
            >
              เปิดโต๊ะ
            </Button>
          </div>
        </>
      }
    >
      <h4 className="flourish mb-2 text-xs font-semibold">โต๊ะ</h4>
      <div className="grid grid-cols-4 gap-2">
        {selectable.map((t) => {
          const on = tableIds.includes(t.id)
          return (
            <button
              key={t.id}
              aria-pressed={on}
              onClick={() => setTableIds((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))}
              className="pick px-2 py-2 text-sm"
            >
              <div className="tracking-wide font-bold">{t.code}</div>
              {t.status === 'occupied' && !t.allowShare && <div className="text-xs text-crimson">ไม่ว่าง</div>}
            </button>
          )
        })}
      </div>

      <h4 className="flourish mt-5 mb-2 text-xs font-semibold">ผู้เล่น</h4>
      <div className="space-y-2">
        {guests.map((g, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={g.name}
              onChange={(e) => setGuests((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              placeholder={`ชื่อเล่นคนที่ ${i + 1}`}
              className={`${INPUT} min-w-0 flex-1`}
            />
            <select
              value={g.ratePlanId || defaultPlanId}
              onChange={(e) =>
                setGuests((p) => p.map((x, j) => (j === i ? { ...x, ratePlanId: e.target.value } : x)))
              }
              className={`${INPUT} !w-auto`}
            >
              {data.ratePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
            {guests.length > 1 && (
              <Button
                variant="danger"
                aria-label={`ลบคนที่ ${i + 1}`}
                className="!px-2.5"
                onClick={() => setGuests((p) => p.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            )}
          </div>
        ))}
      </div>
      <Button
        className="mt-3 w-full border-dashed"
        onClick={() => setGuests((p) => [...p, { name: '', ratePlanId: '' }])}
      >
        + เพิ่มคน (มาเกินที่จองไว้)
      </Button>
    </Modal>
  )
}
