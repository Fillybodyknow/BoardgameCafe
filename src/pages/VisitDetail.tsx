import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import {
  billableMinutes, computeBill, formatBaht, formatDuration, playTimeCharge, splitByOwner,
} from '../domain/pricing'
import type { GuestPass, Order, RatePlan } from '../domain/types'
import { Badge, Button, Card, Empty, SectionTitle } from '../components/ui'
import type { Tone } from '../components/ui'
import OrderDialog from './OrderDialog'

const PASS_TONE: Record<GuestPass['status'], Tone> = {
  active: 'emerald',
  paused: 'amber',
  checked_out: 'slate',
  billed: 'slate',
}

const PASS_LABEL: Record<GuestPass['status'], string> = {
  active: 'กำลังเล่น',
  paused: 'ออกไปข้างนอก',
  checked_out: 'กลับแล้ว',
  billed: 'ปิดบิลแล้ว',
}

const ORDER_TONE: Record<Order['status'], Tone> = {
  placed: 'sky', accepted: 'sky', preparing: 'amber', ready: 'violet',
  served: 'emerald', rejected: 'rose', cancelled: 'slate',
}

const ORDER_LABEL: Record<Order['status'], string> = {
  placed: 'สั่งแล้ว', accepted: 'ครัวรับแล้ว', preparing: 'กำลังทำ', ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว', rejected: 'ของหมด', cancelled: 'ยกเลิก',
}

export default function VisitDetail() {
  const { visitId = '' } = useParams()
  const { data } = useSnapshot()
  const now = useNow(1000)
  const navigate = useNavigate()

  const [showOrder, setShowOrder] = useState(false)
  const [showAddPass, setShowAddPass] = useState(false)
  const [showMove, setShowMove] = useState(false)
  const [splitMode, setSplitMode] = useState<'together' | 'by_owner'>('together')

  const ratePlans = useMemo<Record<string, RatePlan>>(
    () => Object.fromEntries((data?.ratePlans ?? []).map((p) => [p.id, p])),
    [data],
  )

  if (!data) return null

  const visit = data.visits.find((v) => v.id === visitId)
  if (!visit) return <Empty>ไม่พบ visit นี้ — อาจถูกปิดไปแล้ว</Empty>

  const passes = data.passes.filter((p) => p.visitId === visit.id)
  const orders = data.orders.filter((o) => o.visitId === visit.id)
  const tables = data.occupancies
    .filter((o) => o.visitId === visit.id && o.toAt === null)
    .map((o) => data.tables.find((t) => t.id === o.tableId))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))

  const history = data.occupancies.filter((o) => o.visitId === visit.id && o.toAt !== null)
  const bill = computeBill({ visitId: visit.id, passes, orders, ratePlans, now })
  const billable = passes.filter((p) => p.status !== 'billed')
  const split = splitByOwner(bill, billable)

  return (
    <div className="space-y-6">
      {/* หัวบิล */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{visit.code}</h1>
              <Badge tone={visit.status === 'open' ? 'emerald' : 'slate'}>
                {visit.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}
              </Badge>
              {visit.source === 'reservation' && <Badge tone="sky">จองล่วงหน้า</Badge>}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              โต๊ะ {tables.map((t) => t.code).join(' + ') || '—'} · เปิด{' '}
              {new Date(visit.openedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
              {history.length > 0 && (
                <span className="ml-1 text-amber-400">
                  · ย้ายโต๊ะมาแล้ว {history.length} ครั้ง
                </span>
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">ยอดปัจจุบัน</div>
            <div className="tabular text-2xl font-bold text-emerald-400">
              ฿{formatBaht(bill.total)}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setShowOrder(true)} disabled={visit.status !== 'open'}>
            + รับออเดอร์
          </Button>
          <Button onClick={() => setShowAddPass(true)} disabled={visit.status !== 'open'}>
            + เพิ่มคน
          </Button>
          <Button onClick={() => setShowMove(true)} disabled={visit.status !== 'open'}>
            ย้าย / เพิ่มโต๊ะ
          </Button>
          <Button
            variant="danger"
            disabled={visit.status !== 'open'}
            onClick={async () => {
              if (!confirm(`ปิดบิล ${visit.code} ยอด ฿${formatBaht(bill.total)} ?`)) return
              await db.closeVisit(visit.id)
              navigate('/')
            }}
          >
            ปิดบิล
          </Button>
        </div>
      </Card>

      {/* ผู้เล่น — หัวใจของระบบ */}
      <section>
        <SectionTitle>ผู้เล่น ({passes.length})</SectionTitle>
        <div className="space-y-2">
          {passes.map((pass) => {
            const plan = ratePlans[pass.ratePlanId]
            const mins = billableMinutes(pass, now)
            const charge = plan ? playTimeCharge(mins, plan) : 0
            const live = pass.status === 'active'
            return (
              <Card key={pass.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{pass.displayName}</span>
                    <Badge tone={PASS_TONE[pass.status]}>{PASS_LABEL[pass.status]}</Badge>
                  </div>
                  <div className="tabular mt-1 text-sm text-slate-400">
                    {plan?.name ?? '—'} · เข้า{' '}
                    {new Date(pass.checkedInAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                    {pass.checkedOutAt && (
                      <> → ออก {new Date(pass.checkedOutAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</>
                    )}
                    {pass.pausedMinutes > 0 && (
                      <span className="ml-1 text-amber-400">· หักพัก {pass.pausedMinutes} นาที</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className={`tabular text-sm ${live ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {formatDuration(mins)}
                    </div>
                    <div className="tabular text-sm font-semibold">฿{formatBaht(charge)}</div>
                  </div>

                  <div className="flex gap-1">
                    {pass.status === 'active' && (
                      <Button onClick={() => db.pausePass(pass.id)}>พัก</Button>
                    )}
                    {pass.status === 'paused' && (
                      <Button variant="subtle" onClick={() => db.resumePass(pass.id)}>
                        กลับมาแล้ว
                      </Button>
                    )}
                    {(pass.status === 'active' || pass.status === 'paused') && (
                      <Button variant="danger" onClick={() => db.checkOutPass(pass.id)}>
                        กลับก่อน
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      {/* ออเดอร์ */}
      <section>
        <SectionTitle>ออเดอร์ ({orders.length})</SectionTitle>
        {orders.length === 0 ? (
          <Empty>ยังไม่มีออเดอร์</Empty>
        ) : (
          <div className="space-y-2">
            {orders.map((order) => {
              const owner = order.orderedByPassId
                ? passes.find((p) => p.id === order.orderedByPassId)?.displayName
                : null
              const total = order.lines.reduce((s, l) => s + l.unitPriceSnapshot * l.qty, 0)
              return (
                <Card key={order.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge tone={ORDER_TONE[order.status]}>{ORDER_LABEL[order.status]}</Badge>
                      <span className="text-slate-400">
                        {order.splitMode === 'shared' ? 'แชร์ทั้งโต๊ะ' : (owner ?? 'ไม่ระบุ')}
                        {order.placedBy === 'guest' && ' · ลูกค้าสั่งเอง'}
                      </span>
                    </div>
                    <span className="tabular text-sm font-semibold">฿{formatBaht(total)}</span>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-sm text-slate-300">
                    {order.lines.map((line) => (
                      <li key={line.id} className="flex justify-between">
                        <span>
                          {line.nameSnapshot} × {line.qty}
                          {line.note && <span className="ml-1 text-xs text-amber-400">({line.note})</span>}
                        </span>
                        <span className="tabular text-slate-400">
                          ฿{formatBaht(line.unitPriceSnapshot * line.qty)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* บิล */}
      <section>
        <SectionTitle
          action={
            <div className="flex gap-1">
              <Button
                variant={splitMode === 'together' ? 'subtle' : 'ghost'}
                onClick={() => setSplitMode('together')}
              >
                จ่ายรวม
              </Button>
              <Button
                variant={splitMode === 'by_owner' ? 'subtle' : 'ghost'}
                onClick={() => setSplitMode('by_owner')}
              >
                แยกตามคนสั่ง
              </Button>
            </div>
          }
        >
          บิล
        </SectionTitle>

        {splitMode === 'together' ? (
          <Card>
            <ul className="space-y-1 text-sm">
              {bill.lines.map((line) => (
                <li key={line.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-300">{line.label}</span>
                  <span className="tabular shrink-0">฿{formatBaht(line.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-1 border-t border-slate-800 pt-3 text-sm">
              <Row label="รวม" value={bill.subtotal} />
              <Row label="VAT 7% (รวมในราคาแล้ว)" value={bill.vat} muted />
              <div className="mt-2 flex justify-between text-lg font-bold">
                <span>ยอดสุทธิ</span>
                <span className="tabular text-emerald-400">฿{formatBaht(bill.total)}</span>
              </div>
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {split.map((part) => (
              <Card key={part.pass.id}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{part.pass.displayName}</span>
                  <span className="tabular font-bold text-emerald-400">
                    ฿{formatBaht(part.total)}
                  </span>
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-slate-400">
                  {part.ownLines.map((line) => (
                    <li key={line.id} className="flex justify-between">
                      <span className="truncate">{line.label}</span>
                      <span className="tabular">฿{formatBaht(line.amount)}</span>
                    </li>
                  ))}
                  {part.sharedShare > 0 && (
                    <li className="flex justify-between text-amber-400/80">
                      <span>ส่วนแบ่งของแชร์ทั้งโต๊ะ</span>
                      <span className="tabular">฿{formatBaht(part.sharedShare)}</span>
                    </li>
                  )}
                </ul>
              </Card>
            ))}
            <p className="text-xs text-slate-500">
              คนที่กลับไปแล้วยังอยู่ในรายการจนกว่าจะปิดบิล — จ่ายแยกก่อนได้
            </p>
          </div>
        )}
      </section>

      <Link to="/" className="inline-block text-sm text-slate-400 hover:text-slate-200">
        ← กลับผังโต๊ะ
      </Link>

      {showOrder && <OrderDialog visitId={visit.id} passes={passes} onClose={() => setShowOrder(false)} />}
      {showAddPass && <AddPassDialog visitId={visit.id} onClose={() => setShowAddPass(false)} />}
      {showMove && <MoveTableDialog visitId={visit.id} onClose={() => setShowMove(false)} />}
    </div>
  )
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? 'text-slate-500' : ''}`}>
      <span>{label}</span>
      <span className="tabular">฿{formatBaht(value)}</span>
    </div>
  )
}

function Dialog({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-2xl border border-slate-800 bg-slate-900 p-5 sm:rounded-2xl">
        <h3 className="text-lg font-bold">{title}</h3>
        {hint && <p className="mt-1 text-sm text-slate-400">{hint}</p>}
        {children}
      </div>
    </div>
  )
}

function AddPassDialog({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const { data } = useSnapshot()
  const [name, setName] = useState('')
  // เช่นเดียวกับ SeatDialog — รหัสเรตมาจากฐานข้อมูล hardcode ไม่ได้
  const [ratePlanId, setRatePlanId] = useState('')
  const defaultPlanId = data?.ratePlans[0]?.id ?? ''

  return (
    <Dialog title="เพิ่มคนเข้ากลุ่ม" hint="นาฬิกาของคนนี้เริ่มนับตอนนี้ ไม่กระทบคนที่มาก่อน">
      <div className="mt-4 space-y-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ชื่อเล่น"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
        />
        <select
          value={ratePlanId || defaultPlanId}
          onChange={(e) => setRatePlanId(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
        >
          {(data?.ratePlans ?? []).map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} · ฿{plan.pricePerHour}/ชม.
            </option>
          ))}
        </select>
      </div>
      <div className="mt-5 flex gap-2">
        <Button className="flex-1" onClick={onClose}>ยกเลิก</Button>
        <Button
          className="flex-1"
          variant="primary"
          onClick={async () => {
            await db.addPass(visitId, {
              name: name.trim() || 'ผู้เล่นใหม่',
              ratePlanId: ratePlanId || defaultPlanId,
            })
            onClose()
          }}
        >
          เพิ่ม
        </Button>
      </div>
    </Dialog>
  )
}

function MoveTableDialog({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const { data } = useSnapshot()
  const [picked, setPicked] = useState<string[]>([])

  const available = (data?.tables ?? []).filter((t) => t.status === 'free' || t.allowShare)

  return (
    <Dialog
      title="ย้าย / เพิ่มโต๊ะ"
      hint="เลือกได้หลายโต๊ะ (กลุ่มใหญ่รวมโต๊ะ) — ประวัติโต๊ะเดิมถูกเก็บไว้ บิลไม่กระทบ"
    >
      <div className="mt-4 grid grid-cols-3 gap-2">
        {available.map((table) => {
          const on = picked.includes(table.id)
          return (
            <button
              key={table.id}
              onClick={() => setPicked((p) => (on ? p.filter((id) => id !== table.id) : [...p, table.id]))}
              className={`rounded-lg border px-2 py-3 text-sm transition ${
                on ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700 hover:border-slate-500'
              }`}
            >
              <div className="font-bold">{table.code}</div>
              <div className="text-xs text-slate-500">{table.seatMax} ที่</div>
            </button>
          )
        })}
      </div>
      <div className="mt-5 flex gap-2">
        <Button className="flex-1" onClick={onClose}>ยกเลิก</Button>
        <Button
          className="flex-1"
          variant="primary"
          disabled={picked.length === 0}
          onClick={async () => {
            await db.moveVisitToTables(visitId, picked)
            onClose()
          }}
        >
          ย้ายไป {picked.length} โต๊ะ
        </Button>
      </div>
    </Dialog>
  )
}
