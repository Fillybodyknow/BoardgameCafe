import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSnapshot, useNow } from '../hooks/useData'
import { db } from '../data'
import { billableMinutes, computeBill, formatBaht, formatDuration } from '../domain/pricing'
import type { CafeTable, RatePlan, TableStatus } from '../domain/types'
import { Badge, Button, Card, SectionTitle } from '../components/ui'
import type { Tone } from '../components/ui'

const STATUS_STYLE: Record<TableStatus, { ring: string; label: string; tone: Tone }> = {
  free: { ring: 'border-slate-700 hover:border-emerald-600', label: 'ว่าง', tone: 'slate' },
  reserved: { ring: 'border-sky-700/70 bg-sky-950/30', label: 'จองไว้', tone: 'sky' },
  occupied: { ring: 'border-emerald-700/70 bg-emerald-950/25', label: 'มีลูกค้า', tone: 'emerald' },
  cleaning: { ring: 'border-amber-700/70 bg-amber-950/25', label: 'กำลังเก็บ', tone: 'amber' },
}

export default function FloorMap() {
  const { data } = useSnapshot()
  const now = useNow(5000)
  const [seating, setSeating] = useState<CafeTable | null>(null)

  const zones = useMemo(() => {
    if (!data) return []
    const byZone = new Map<string, CafeTable[]>()
    for (const table of data.tables) {
      const list = byZone.get(table.zone) ?? []
      list.push(table)
      byZone.set(table.zone, list)
    }
    return [...byZone.entries()]
  }, [data])

  if (!data) return null

  const ratePlans: Record<string, RatePlan> = Object.fromEntries(
    data.ratePlans.map((p) => [p.id, p]),
  )

  /** โต๊ะนี้ถูกครองโดย visit ไหนอยู่ (occupancy ที่ยังไม่ปิด) */
  function visitAt(tableId: string) {
    const occ = data!.occupancies.find((o) => o.tableId === tableId && o.toAt === null)
    if (!occ) return null
    const visit = data!.visits.find((v) => v.id === occ.visitId && v.status === 'open')
    if (!visit) return null

    const passes = data!.passes.filter((p) => p.visitId === visit.id)
    const active = passes.filter((p) => p.status === 'active' || p.status === 'paused')
    const bill = computeBill({
      visitId: visit.id,
      passes,
      orders: data!.orders.filter((o) => o.visitId === visit.id),
      ratePlans,
      now,
    })
    const longest = Math.max(0, ...active.map((p) => billableMinutes(p, now)))
    return { visit, passes, active, bill, longest }
  }

  const openVisits = data.visits.filter((v) => v.status === 'open')
  const runningTotal = openVisits.reduce((sum, v) => {
    const bill = computeBill({
      visitId: v.id,
      passes: data.passes.filter((p) => p.visitId === v.id),
      orders: data.orders.filter((o) => o.visitId === v.id),
      ratePlans,
      now,
    })
    return sum + bill.total
  }, 0)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="โต๊ะที่ใช้อยู่" value={`${data.tables.filter((t) => t.status === 'occupied').length}/${data.tables.length}`} />
        <Stat label="ลูกค้าในร้าน" value={String(data.passes.filter((p) => p.status === 'active' || p.status === 'paused').length)} />
        <Stat label="ออเดอร์ค้างครัว" value={String(data.orders.filter((o) => ['placed', 'accepted', 'preparing'].includes(o.status)).length)} />
        <Stat label="ยอดค้างบิล" value={`฿${formatBaht(runningTotal)}`} />
      </div>

      {zones.map(([zone, tables]) => (
        <section key={zone}>
          <SectionTitle>{zone}</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {tables.map((table) => {
              const style = STATUS_STYLE[table.status]
              const occupied = visitAt(table.id)

              const body = (
                <div className={`h-full rounded-xl border p-3 text-left transition ${style.ring}`}>
                  <div className="flex items-start justify-between">
                    <span className="text-lg font-bold">{table.code}</span>
                    <Badge tone={style.tone}>{style.label}</Badge>
                  </div>

                  {occupied ? (
                    <div className="mt-2 space-y-1 text-sm">
                      <div className="text-slate-400">
                        {occupied.visit.code} · {occupied.active.length} คน
                      </div>
                      <div className="tabular text-slate-300">
                        ⏱ {formatDuration(occupied.longest)}
                      </div>
                      <div className="tabular font-semibold text-emerald-400">
                        ฿{formatBaht(occupied.bill.total)}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-slate-500">
                      {table.seatMin}–{table.seatMax} ที่นั่ง
                      {table.allowShare && <span className="ml-1 text-xs">· นั่งร่วมได้</span>}
                    </div>
                  )}
                </div>
              )

              if (occupied) {
                return (
                  <Link key={table.id} to={`/visit/${occupied.visit.id}`} className="block">
                    {body}
                  </Link>
                )
              }
              return (
                <button
                  key={table.id}
                  onClick={() => table.status === 'free' && setSeating(table)}
                  disabled={table.status !== 'free'}
                  className="block text-left disabled:opacity-60"
                >
                  {body}
                </button>
              )
            })}
          </div>
        </section>
      ))}

      {seating && <SeatDialog table={seating} onClose={() => setSeating(null)} />}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="tabular mt-1 text-xl font-bold">{value}</div>
    </Card>
  )
}

/** เปิด visit ใหม่ — รองรับตั้งแต่ลูกค้าคนเดียวจนถึงกลุ่มใหญ่ */
function SeatDialog({ table, onClose }: { table: CafeTable; onClose: () => void }) {
  const { data } = useSnapshot()
  // ว่างไว้ก่อน แล้วค่อยใช้เรตแรกที่ร้านตั้งไว้ — รหัสเรตต่างกันในแต่ละฐานข้อมูล
  // จึง hardcode ไม่ได้
  const [guests, setGuests] = useState<{ name: string; ratePlanId: string }[]>([
    { name: '', ratePlanId: '' },
  ])
  const [busy, setBusy] = useState(false)

  if (!data) return null

  const defaultPlanId = data.ratePlans[0]?.id ?? ''

  async function submit() {
    setBusy(true)
    try {
      await db.openVisit({
        tableIds: [table.id],
        guests: guests.map((g, i) => ({
          name: g.name.trim() || `ผู้เล่น ${i + 1}`,
          ratePlanId: g.ratePlanId || defaultPlanId,
        })),
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-2xl border border-slate-800 bg-slate-900 p-5 sm:rounded-2xl">
        <h3 className="text-lg font-bold">เปิดโต๊ะ {table.code}</h3>
        <p className="mt-1 text-sm text-slate-400">
          นาฬิกาเริ่มนับแยกรายคน — เพิ่มคนทีหลังได้ตลอด
        </p>

        <div className="mt-4 space-y-2">
          {guests.map((guest, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={guest.name}
                onChange={(e) =>
                  setGuests((prev) => prev.map((g, j) => (j === i ? { ...g, name: e.target.value } : g)))
                }
                placeholder={`ชื่อเล่นคนที่ ${i + 1}`}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
              />
              <select
                value={guest.ratePlanId || defaultPlanId}
                onChange={(e) =>
                  setGuests((prev) =>
                    prev.map((g, j) => (j === i ? { ...g, ratePlanId: e.target.value } : g)),
                  )
                }
                className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm outline-none focus:border-emerald-600"
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
          className="mt-2 w-full"
          variant="subtle"
          onClick={() => setGuests((p) => [...p, { name: '', ratePlanId: defaultPlanId }])}
          disabled={guests.length >= table.seatMax}
        >
          + เพิ่มคน (สูงสุด {table.seatMax})
        </Button>

        <div className="mt-5 flex gap-2">
          <Button className="flex-1" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button className="flex-1" variant="primary" onClick={submit} disabled={busy}>
            เปิดโต๊ะ
          </Button>
        </div>
      </div>
    </div>
  )
}
