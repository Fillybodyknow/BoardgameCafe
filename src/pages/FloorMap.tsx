import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSnapshot, useNow } from '../hooks/useData'
import { db } from '../data'
import { billableMinutes, computeBill, formatBaht, formatDuration } from '../domain/pricing'
import type { CafeTable, RatePlan, TableStatus, Visit } from '../domain/types'
import { Badge, Button, Dot, Icon, INPUT, Modal, PageHeader, SectionTitle } from '../components/ui'
import type { IconName, Tone } from '../components/ui'
import SlipDialog from './SlipDialog'

const STATUS_STYLE: Record<TableStatus, { ribbon: string; tile: string; label: string; tone: Tone }> = {
  free: { ribbon: 'bg-line-strong', tile: 'hover:border-gold', label: 'ว่าง', tone: 'neutral' },
  reserved: { ribbon: 'bg-lapis', tile: 'border-lapis/40 bg-lapis/5', label: 'จองไว้', tone: 'lapis' },
  occupied: { ribbon: 'bg-forest', tile: 'border-forest/40', label: 'มีลูกค้า', tone: 'forest' },
  cleaning: { ribbon: 'bg-ember', tile: 'border-ember/40 bg-ember/5', label: 'กำลังเก็บ', tone: 'ember' },
}

export default function FloorMap() {
  const { data } = useSnapshot()
  const now = useNow(5000)
  const [seating, setSeating] = useState<CafeTable | null>(null)
  // เปิดโต๊ะเสร็จ → ใบ QR ของรอบนี้ให้พิมพ์ยื่นลูกค้า
  const [slip, setSlip] = useState<{ visit: Visit; table: CafeTable } | null>(null)

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
      sharedSettled: visit.sharedSettled,
      tax: data!.tax,
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
      sharedSettled: v.sharedSettled,
      tax: data.tax,
      now,
    })
    return sum + bill.total
  }, 0)

  const occupiedCount = data.tables.filter((t) => t.status === 'occupied').length
  const guestsIn = data.passes.filter((p) => p.status === 'active' || p.status === 'paused').length
  const kitchenQueue = data.orders.filter((o) => ['placed', 'accepted', 'preparing'].includes(o.status)).length

  return (
    <div>
      <PageHeader
        eyebrow="ห้องโถงใหญ่"
        title="ผังโต๊ะ"
        subtitle={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {(['free', 'reserved', 'occupied'] as TableStatus[]).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <Dot tone={STATUS_STYLE[s].tone} />
                {STATUS_STYLE[s].label}
              </span>
            ))}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon="table" label="โต๊ะที่ใช้อยู่" value={`${occupiedCount}/${data.tables.length}`} />
        <Stat icon="users" label="ลูกค้าในร้าน" value={String(guestsIn)} />
        <Stat icon="cauldron" label="ออเดอร์ค้างครัว" value={String(kitchenQueue)} alert={kitchenQueue > 0} />
        <Stat icon="coins" label="ยอดค้างบิล" value={`฿${formatBaht(runningTotal)}`} gold />
      </div>

      <div className="mt-8 space-y-8">
        {zones.map(([zone, tables]) => {
          const free = tables.filter((t) => t.status === 'free').length
          return (
            <section key={zone}>
              <SectionTitle
                action={
                  <span className="text-xs text-ink-faint">
                    ว่าง {free} จาก {tables.length}
                  </span>
                }
              >
                {zone}
              </SectionTitle>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {tables.map((table) => (
                  <TableTile
                    key={table.id}
                    table={table}
                    occupied={visitAt(table.id)}
                    onSeat={() => setSeating(table)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {seating && (
        <SeatDialog
          table={seating}
          onClose={() => setSeating(null)}
          onOpened={(visit) => {
            setSlip({ visit, table: seating })
            setSeating(null)
          }}
        />
      )}
      {slip && (
        <SlipDialog
          visit={slip.visit}
          tableCode={slip.table.code}
          zone={slip.table.zone}
          justOpened
          onClose={() => setSlip(null)}
        />
      )}
    </div>
  )
}

function TableTile({
  table,
  occupied,
  onSeat,
}: {
  table: CafeTable
  occupied: {
    visit: { id: string; code: string }
    active: unknown[]
    bill: { total: number }
    longest: number
  } | null
  onSeat: () => void
}) {
  const style = STATUS_STYLE[table.status]
  const filled = occupied ? Math.min(occupied.active.length, table.seatMax) : 0

  const body = (
    <div
      className={`panel lift group flex h-full flex-col overflow-hidden rounded-xl text-left ${style.tile}`}
    >
      <div className={`h-1.5 ${style.ribbon}`} />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl tracking-wide leading-none font-bold">{table.code}</span>
            {occupied && <span className="flame" aria-hidden />}
          </div>
          <Badge tone={style.tone}>{style.label}</Badge>
        </div>

        {/* จุดที่นั่ง — ทึบ = มีคนนั่ง */}
        <div className="mt-3 flex flex-wrap gap-1" aria-hidden>
          {Array.from({ length: table.seatMax }, (_, i) => (
            <span
              key={i}
              className={`h-2 w-2 rounded-full ${
                i < filled ? 'bg-forest' : 'border border-line-strong bg-transparent'
              }`}
            />
          ))}
        </div>

        {occupied ? (
          <div className="mt-3 space-y-1 text-sm">
            <div className="text-ink-faint">
              {occupied.visit.code} · {occupied.active.length} คน
            </div>
            <div className="tabular flex items-center gap-1.5 text-ink-soft">
              <Icon name="hourglass" className="h-4 w-4" />
              {formatDuration(occupied.longest)}
            </div>
            <div className="tabular pt-1 text-lg font-bold text-gold-deep">
              ฿{formatBaht(occupied.bill.total)}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-1 flex-col justify-between text-sm text-ink-faint">
            <span>
              {table.seatMin}–{table.seatMax} ที่นั่ง
              {table.allowShare && <span className="ml-1 text-xs">· นั่งร่วมได้</span>}
            </span>
            {table.status === 'free' && (
              <span className="mt-2 text-xs text-gold-deep opacity-0 transition group-hover:opacity-100">
                แตะเพื่อรับแขก →
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )

  if (occupied) {
    return (
      <Link to={`/visit/${occupied.visit.id}`} className="block rounded-xl">
        {body}
      </Link>
    )
  }
  return (
    <button
      onClick={() => table.status === 'free' && onSeat()}
      disabled={table.status !== 'free'}
      className="block rounded-xl text-left disabled:opacity-70"
    >
      {body}
    </button>
  )
}

function Stat({
  icon,
  label,
  value,
  gold,
  alert,
}: {
  icon: IconName
  label: string
  value: string
  gold?: boolean
  alert?: boolean
}) {
  return (
    <div className="panel flex items-center gap-3 rounded-xl p-4">
      <div
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border ${
          gold
            ? 'border-gold/50 bg-gold/15 text-gold-deep'
            : alert
              ? 'border-ember/40 bg-ember/10 text-ember-deep'
              : 'border-line-strong bg-parchment-deep text-ink-soft'
        }`}
      >
        <Icon name={icon} />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-ink-faint">{label}</div>
        {/* key ตามค่า ให้ตัวเลขเด้งทุกครั้งที่เปลี่ยน */}
        <div
          key={value}
          className={`tabular animate-bump truncate text-xl font-bold ${gold ? 'text-gold-deep' : ''}`}
        >
          {value}
        </div>
      </div>
    </div>
  )
}

/** เปิด visit ใหม่ — รองรับตั้งแต่ลูกค้าคนเดียวจนถึงกลุ่มใหญ่ */
function SeatDialog({
  table,
  onClose,
  onOpened,
}: {
  table: CafeTable
  onClose: () => void
  onOpened: (visit: Visit) => void
}) {
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
      const visit = await db.openVisit({
        tableIds: [table.id],
        guests: guests.map((g, i) => ({
          name: g.name.trim() || `ผู้เล่น ${i + 1}`,
          ratePlanId: g.ratePlanId || defaultPlanId,
        })),
      })
      onOpened(visit)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`เปิดโต๊ะ ${table.code}`}
      hint="นาฬิกาเริ่มนับแยกรายคน — เพิ่มคนทีหลังได้ตลอด"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button className="flex-1" variant="primary" onClick={submit} disabled={busy}>
            เปิดโต๊ะ
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        {guests.map((guest, i) => (
          <div key={i} className="flex animate-page items-center gap-2">
            <span className="shield h-8 w-7 shrink-0 bg-wine text-xs text-gold-light">{i + 1}</span>
            <input
              value={guest.name}
              onChange={(e) =>
                setGuests((prev) => prev.map((g, j) => (j === i ? { ...g, name: e.target.value } : g)))
              }
              placeholder={`ชื่อเล่นคนที่ ${i + 1}`}
              className={`${INPUT} min-w-0 flex-1`}
            />
            <select
              value={guest.ratePlanId || defaultPlanId}
              onChange={(e) =>
                setGuests((prev) =>
                  prev.map((g, j) => (j === i ? { ...g, ratePlanId: e.target.value } : g)),
                )
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
        onClick={() => setGuests((p) => [...p, { name: '', ratePlanId: defaultPlanId }])}
        disabled={guests.length >= table.seatMax}
      >
        + เพิ่มคน (สูงสุด {table.seatMax})
      </Button>
    </Modal>
  )
}
