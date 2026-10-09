import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import {
  billableMinutes,
  computeBill,
  formatBaht,
  formatDuration,
  playTimeCharge,
  splitByOwner,
} from '../domain/pricing'
import type { GuestPass, Order, RatePlan } from '../domain/types'
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  INPUT,
  Modal,
  SectionTitle,
  Segmented,
  celebrate,
} from '../components/ui'
import type { Tone } from '../components/ui'
import OrderDialog from './OrderDialog'
import PaymentDialog from './PaymentDialog'
import SettleDialog from './SettleDialog'
import SlipDialog from './SlipDialog'

const PASS_TONE: Record<GuestPass['status'], Tone> = {
  active: 'forest',
  paused: 'ember',
  // ค้างชำระต้องสะดุดตา ไม่งั้นตอนปิดโต๊ะจะมีคนหลุด
  checked_out: 'ember',
  billed: 'neutral',
}

const PASS_LABEL: Record<GuestPass['status'], string> = {
  active: 'กำลังเล่น',
  paused: 'ออกไปข้างนอก',
  checked_out: 'ค้างชำระ',
  billed: 'จ่ายแล้ว',
}

const ORDER_TONE: Record<Order['status'], Tone> = {
  placed: 'lapis',
  accepted: 'lapis',
  preparing: 'ember',
  ready: 'royal',
  served: 'forest',
  rejected: 'crimson',
  cancelled: 'neutral',
}

const ORDER_LABEL: Record<Order['status'], string> = {
  placed: 'สั่งแล้ว',
  accepted: 'ครัวรับแล้ว',
  preparing: 'กำลังทำ',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
  rejected: 'ของหมด',
  cancelled: 'ยกเลิก',
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })

export default function VisitDetail() {
  const { visitId = '' } = useParams()
  const { data } = useSnapshot()
  const now = useNow(1000)
  const navigate = useNavigate()
  const location = useLocation()

  // มาจากการเช็คอินคิวจอง → เปิดใบ QR ให้พิมพ์ทันที
  const fromSeat = Boolean((location.state as { slip?: boolean } | null)?.slip)

  const [showOrder, setShowOrder] = useState(false)
  const [showAddPass, setShowAddPass] = useState(false)
  const [showMove, setShowMove] = useState(false)
  const [showQR, setShowQR] = useState(fromSeat)
  const [justOpened, setJustOpened] = useState(fromSeat)
  const [splitMode, setSplitMode] = useState<'together' | 'by_owner'>('together')
  const [showPayment, setShowPayment] = useState(false)

  // ล้าง state ทิ้ง ไม่งั้นกดรีเฟรชแล้วใบ QR เด้งขึ้นมาอีก
  useEffect(() => {
    if (fromSeat) navigate(location.pathname, { replace: true, state: null })
  }, [])

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
  // ต้องส่ง tax กับ sharedSettled เข้าไป ไม่งั้นตัวเลขบนจอจะไม่ตรงกับยอดที่
  // ฐานข้อมูลคิดตอนปิดบิล — หน้าจอรับเงินก็อ่านยอดจากตรงนี้
  const bill = computeBill({
    visitId: visit.id,
    passes,
    orders,
    ratePlans,
    sharedSettled: visit.sharedSettled,
    tax: data.tax,
    now,
  })
  const billable = passes.filter((p) => p.status !== 'billed')
  const split = splitByOwner(bill, billable)
  const isOpen = visit.status === 'open'

  return (
    <div>
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-faint transition hover:text-ink"
      >
        <Icon name="arrowLeft" className="h-4 w-4" /> กลับผังโต๊ะ
      </Link>

      {/* หัวบิล */}
      <Card ornate className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-5">
          <div className="shield h-20 w-16 shrink-0 bg-wine text-lg text-gold-light shadow-lg">
            {tables.map((t) => t.code).join('+') || '—'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">{visit.code}</h1>
              <Badge tone={isOpen ? 'forest' : 'neutral'}>{isOpen ? 'เปิดอยู่' : 'ปิดแล้ว'}</Badge>
              {visit.source === 'reservation' && <Badge tone="lapis">จองล่วงหน้า</Badge>}
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              โต๊ะ {tables.map((t) => t.code).join(' + ') || '—'} · เปิด {time(visit.openedAt)}
              {history.length > 0 && (
                <span className="ml-1 text-ember-deep">
                  · ย้ายโต๊ะมาแล้ว {history.length} ครั้ง
                </span>
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs tracking-wide text-ink-faint">ยอดปัจจุบัน</div>
            <div className="tabular text-3xl font-bold text-gold-deep">
              ฿{formatBaht(bill.total)}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="primary" onClick={() => setShowOrder(true)} disabled={!isOpen}>
            + รับออเดอร์
          </Button>
          <Button onClick={() => setShowAddPass(true)} disabled={!isOpen}>
            + เพิ่มคน
          </Button>
          <Button onClick={() => setShowQR(true)} disabled={!isOpen}>
            พิมพ์ QR ให้ลูกค้า
          </Button>
          <Button onClick={() => setShowMove(true)} disabled={!isOpen}>
            ย้ายโต๊ะ
          </Button>
          <Button
            variant="forest"
            className="sm:ml-auto"
            disabled={!isOpen}
            onClick={() => setShowPayment(true)}
          >
            เช็คบิล
          </Button>
        </div>
      </Card>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-8">
          {/* ผู้เล่น — หัวใจของระบบ */}
          <section>
            <SectionTitle>ผู้เล่น ({passes.length})</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {passes.map((pass) => (
                <PassCard
                  key={pass.id}
                  pass={pass}
                  plan={ratePlans[pass.ratePlanId]}
                  now={now}
                  // ลบได้เฉพาะคนที่ยังไม่ผูกกับเงิน — ถ้าสั่งของไปแล้วต้องใช้ "กลับก่อน"
                  canRemove={
                    passes.length > 1 && !orders.some((o) => o.orderedByPassId === pass.id)
                  }
                />
              ))}
            </div>
          </section>

          {/* ออเดอร์ */}
          <section>
            <SectionTitle>ออเดอร์ ({orders.length})</SectionTitle>
            {orders.length === 0 ? (
              <Empty icon="🍺">ยังไม่มีออเดอร์</Empty>
            ) : (
              <div className="space-y-2">
                {orders.map((order) => {
                  const owner = order.orderedByPassId
                    ? passes.find((p) => p.id === order.orderedByPassId)?.displayName
                    : null
                  const total = order.lines.reduce((s, l) => s + l.unitPriceSnapshot * l.qty, 0)
                  return (
                    <Card key={order.id} className="!p-0">
                      <div className="flex items-center justify-between gap-2 border-b border-dashed border-line px-4 py-2.5">
                        <div className="flex items-center gap-2 text-sm">
                          <Badge tone={ORDER_TONE[order.status]}>{ORDER_LABEL[order.status]}</Badge>
                          <span className="text-ink-faint">
                            {order.splitMode === 'shared'
                              ? 'แชร์ทั้งโต๊ะ'
                              : `สั่งโดย ${owner ?? 'ไม่ระบุ'}`}
                            {order.placedBy === 'guest' && ' · ลูกค้าสั่งเอง'}
                          </span>
                        </div>
                        <span className="tabular text-sm font-semibold">฿{formatBaht(total)}</span>
                      </div>
                      <ul className="space-y-1 px-4 py-3 text-sm">
                        {order.lines.map((line) => (
                          <li key={line.id} className="flex justify-between gap-3">
                            <span>
                              <span className="tabular mr-1.5 font-semibold text-gold-deep">
                                {line.qty}×
                              </span>
                              {line.nameSnapshot}
                              {line.note && (
                                <span className="ml-1 text-xs text-ember-deep">({line.note})</span>
                              )}
                            </span>
                            <span className="tabular text-ink-faint">
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
        </div>

        {/* บิล — ติดอยู่ด้านข้างบนจอใหญ่ */}
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <SectionTitle>สมุดบัญชี</SectionTitle>
          <Segmented
            className="mb-3 w-full"
            value={splitMode}
            onChange={setSplitMode}
            options={[
              { value: 'together', label: 'จ่ายรวม' },
              { value: 'by_owner', label: 'แยกตามคนสั่ง' },
            ]}
          />

          {splitMode === 'together' ? (
            <Card className="animate-page">
              <ul className="space-y-1.5 text-sm">
                {bill.lines.map((line) => (
                  <li key={line.id} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-ink-soft">{line.label}</span>
                    <span className="tabular shrink-0">฿{formatBaht(line.amount)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 space-y-1 border-t border-double border-line-strong pt-3 text-sm">
                <Row label="รวม" value={bill.subtotal} />
                {data.tax.serviceChargeRate > 0 && (
                  <Row
                    label={`ค่าบริการ ${round1(data.tax.serviceChargeRate * 100)}%`}
                    value={bill.serviceCharge}
                    muted
                  />
                )}
                <Row
                  label={`VAT ${round1(data.tax.vatRate * 100)}%${
                    data.tax.vatIncluded ? ' (รวมในราคาแล้ว)' : ''
                  }`}
                  value={bill.vat}
                  muted
                />
                <div className="mt-2 flex items-baseline justify-between text-lg font-bold">
                  <span className="font-display">ยอดสุทธิ</span>
                  <span className="tabular text-gold-deep">฿{formatBaht(bill.total)}</span>
                </div>
              </div>
            </Card>
          ) : (
            <div className="animate-page space-y-2">
              {split.map((part) => (
                <Card key={part.pass.id}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{part.pass.displayName}</span>
                    <span className="tabular font-bold text-gold-deep">
                      ฿{formatBaht(part.total)}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-sm text-ink-faint">
                    {part.ownLines.map((line) => (
                      <li key={line.id} className="flex justify-between gap-2">
                        <span className="truncate">{line.label}</span>
                        <span className="tabular">฿{formatBaht(line.amount)}</span>
                      </li>
                    ))}
                    {part.sharedShare > 0 && (
                      <li className="flex justify-between text-ember-deep">
                        <span>ส่วนแบ่งของแชร์ทั้งโต๊ะ</span>
                        <span className="tabular">฿{formatBaht(part.sharedShare)}</span>
                      </li>
                    )}
                  </ul>
                </Card>
              ))}
              <p className="text-xs text-ink-faint">
                คนที่กลับไปแล้วยังอยู่ในรายการจนกว่าจะปิดบิล — จ่ายแยกก่อนได้
              </p>
            </div>
          )}
        </aside>
      </div>

      {showOrder && (
        <OrderDialog visitId={visit.id} passes={passes} onClose={() => setShowOrder(false)} />
      )}
      {showAddPass && <AddPassDialog visitId={visit.id} onClose={() => setShowAddPass(false)} />}
      {showMove && <MoveTableDialog visitId={visit.id} onClose={() => setShowMove(false)} />}
      {showQR && (
        <SlipDialog
          visit={visit}
          tableCode={tables.map((t) => t.code).join('+') || '—'}
          zone={tables[0]?.zone ?? ''}
          justOpened={justOpened}
          onClose={() => {
            setShowQR(false)
            setJustOpened(false)
          }}
        />
      )}
      {showPayment && (
        <PaymentDialog
          visitCode={visit.code}
          bill={bill}
          passes={passes}
          onClose={() => setShowPayment(false)}
          onPaid={() => {
            celebrate(`ปิดบิล ${visit.code} เรียบร้อย`)
            navigate('/')
          }}
        />
      )}
    </div>
  )
}

function PassCard({
  pass,
  plan,
  now,
  canRemove,
}: {
  pass: GuestPass
  plan?: RatePlan
  now: Date
  canRemove: boolean
}) {
  const [settling, setSettling] = useState(false)
  const [removing, setRemoving] = useState(false)
  const mins = billableMinutes(pass, now)
  const charge = plan ? playTimeCharge(mins, plan) : 0
  const live = pass.status === 'active'
  const gone = pass.status === 'checked_out' || pass.status === 'billed'

  return (
    <Card className={`flex flex-col gap-3 ${gone ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div
          className={`shield h-11 w-9 shrink-0 text-base ${
            live
              ? 'bg-forest text-vellum'
              : pass.status === 'paused'
                ? 'bg-ember text-vellum'
                : 'bg-line text-ink-soft'
          }`}
          aria-hidden
        >
          {initialOf(pass.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{pass.displayName}</span>
            <Badge tone={PASS_TONE[pass.status]}>{PASS_LABEL[pass.status]}</Badge>
          </div>
          <div className="tabular mt-0.5 text-xs text-ink-faint">
            {plan?.name ?? '—'} · เข้า {time(pass.checkedInAt)}
            {pass.checkedOutAt && <> → ออก {time(pass.checkedOutAt)}</>}
            {pass.pausedMinutes > 0 && (
              <span className="ml-1 text-ember-deep">· หักพัก {pass.pausedMinutes} นาที</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-2 rounded-lg bg-parchment-deep/60 px-3 py-2">
        <div
          className={`tabular flex items-center gap-1.5 text-sm ${live ? 'text-forest-deep' : 'text-ink-faint'}`}
        >
          <Icon name="hourglass" className={`h-4 w-4 ${live ? 'animate-pulse' : ''}`} />
          {formatDuration(mins)}
        </div>
        <div className="tabular text-base font-semibold">฿{formatBaht(charge)}</div>
      </div>

      {pass.status !== 'billed' && (
        <div className="flex flex-wrap gap-1.5">
          {pass.status === 'active' && (
            <Button className="flex-1" onClick={() => db.pausePass(pass.id)}>
              พัก
            </Button>
          )}
          {pass.status === 'paused' && (
            <Button className="flex-1" variant="subtle" onClick={() => db.resumePass(pass.id)}>
              กลับมาแล้ว
            </Button>
          )}
          {pass.status !== 'checked_out' && (
            <Button className="flex-1" variant="danger" onClick={() => db.checkOutPass(pass.id)}>
              กลับก่อน
            </Button>
          )}
          {/* เก็บเงินทีละคนได้โดยไม่ต้องปิดทั้งโต๊ะ คนที่เหลือยังเล่นต่อ */}
          <Button className="flex-1" variant="primary" onClick={() => setSettling(true)}>
            จ่ายแล้วกลับ
          </Button>
          {canRemove && (
            <Button
              className="flex-1"
              variant="ghost"
              disabled={removing}
              onClick={() => {
                if (!confirm(`ลบ ${pass.displayName} ออกจากโต๊ะ? ใช้เมื่อลงชื่อผิดเท่านั้น`)) return
                setRemoving(true)
                void db.voidPass(pass.id).finally(() => setRemoving(false))
              }}
            >
              ลบคนนี้
            </Button>
          )}
        </div>
      )}

      {settling && (
        <SettleDialog
          pass={pass}
          onClose={() => setSettling(false)}
          onSettled={(name) => {
            setSettling(false)
            celebrate(`เก็บเงิน ${name} เรียบร้อย`)
          }}
        />
      )}
    </Card>
  )
}

/** ตัดทศนิยมให้เหลือหลักเดียวเมื่อจำเป็น — 7 ไม่ใช่ 7.0 แต่ 7.5 ต้องไม่กลายเป็น 8 */
function round1(n: number) {
  return Number(n.toFixed(1))
}

/** อักษรแรกของชื่อสำหรับโล่ — ข้ามสระหน้า (เ แ โ ใ ไ) ไม่งั้น "เมย์" ได้ "เ" */
function initialOf(name: string) {
  return [...name].find((ch) => !'เแโใไ'.includes(ch)) ?? name.slice(0, 1)
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? 'text-ink-faint' : ''}`}>
      <span>{label}</span>
      <span className="tabular">฿{formatBaht(value)}</span>
    </div>
  )
}

function Actions({
  onCancel,
  onOk,
  okLabel,
  disabled,
}: {
  onCancel: () => void
  onOk: () => void
  okLabel: string
  disabled?: boolean
}) {
  return (
    <div className="flex gap-2">
      <Button className="flex-1" onClick={onCancel}>
        ยกเลิก
      </Button>
      <Button className="flex-1" variant="primary" disabled={disabled} onClick={onOk}>
        {okLabel}
      </Button>
    </div>
  )
}

function AddPassDialog({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const { data } = useSnapshot()
  const [name, setName] = useState('')
  // เช่นเดียวกับ SeatDialog — รหัสเรตมาจากฐานข้อมูล hardcode ไม่ได้
  const [ratePlanId, setRatePlanId] = useState('')
  const defaultPlanId = data?.ratePlans[0]?.id ?? ''

  async function add() {
    await db.addPass(visitId, {
      name: name.trim() || 'ผู้เล่นใหม่',
      ratePlanId: ratePlanId || defaultPlanId,
    })
    onClose()
  }

  return (
    <Modal
      title="เพิ่มคนเข้ากลุ่ม"
      hint="นาฬิกาของคนนี้เริ่มนับตอนนี้ ไม่กระทบคนที่มาก่อน"
      onClose={onClose}
      footer={<Actions onCancel={onClose} onOk={add} okLabel="เพิ่ม" />}
    >
      <div className="space-y-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ชื่อเล่น"
          className={INPUT}
        />
        <select
          value={ratePlanId || defaultPlanId}
          onChange={(e) => setRatePlanId(e.target.value)}
          className={INPUT}
        >
          {(data?.ratePlans ?? []).map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} · ฿{plan.pricePerHour}/ชม.
            </option>
          ))}
        </select>
      </div>
    </Modal>
  )
}

function MoveTableDialog({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const { data } = useSnapshot()
  const [picked, setPicked] = useState<string | null>(null)

  const available = (data?.tables ?? []).filter((t) => t.status === 'free' || t.allowShare)
  const pickedCode = available.find((t) => t.id === picked)?.code

  return (
    <Modal
      title="ย้ายโต๊ะ"
      hint="เลือกได้ครั้งละ 1 โต๊ะ — ประวัติโต๊ะเดิมถูกเก็บไว้ บิลไม่กระทบ"
      onClose={onClose}
      footer={
        <Actions
          onCancel={onClose}
          disabled={picked === null}
          okLabel={pickedCode ? `ย้ายไปโต๊ะ ${pickedCode}` : 'ย้ายโต๊ะ'}
          onOk={async () => {
            if (!picked) return
            await db.moveVisitToTables(visitId, [picked])
            onClose()
          }}
        />
      }
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {available.map((table) => {
          const on = picked === table.id
          return (
            <button
              key={table.id}
              aria-pressed={on}
              onClick={() => setPicked(on ? null : table.id)}
              className="pick px-2 py-3 text-sm"
            >
              <div className="text-lg tracking-wide font-bold">{table.code}</div>
              <div className="text-xs text-ink-faint">{table.seatMax} ที่</div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
