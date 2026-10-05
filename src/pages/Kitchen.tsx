import { useEffect, useRef, useState } from 'react'
import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import type { Order, OrderStatus } from '../domain/types'
import { Badge, Button, Empty, Icon, PageHeader } from '../components/ui'
import {
  disableSound,
  enableSound,
  playNewOrderChime,
  setTabBadge,
  soundEnabled,
  soundSupported,
} from '../lib/alert'
import { PUSH_HINT, disablePush, enablePush, pushState, type PushState } from '../lib/push'

/** SLA — เกินแล้วการ์ดเปลี่ยนสี ให้ครัวเห็นแต่ไกล */
const SLA_MINUTES = 12

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  placed: { to: 'accepted', label: 'รับออเดอร์' },
  accepted: { to: 'preparing', label: 'เริ่มทำ' },
  preparing: { to: 'ready', label: 'ทำเสร็จ' },
  ready: { to: 'served', label: 'เสิร์ฟแล้ว' },
}

// Tailwind สแกนคลาสแบบ static — เขียนชื่อคลาสเต็มไว้ตรงนี้
const COLUMNS: { status: OrderStatus; title: string; accent: string }[] = [
  { status: 'placed', title: 'เข้าใหม่', accent: 'border-t-lapis' },
  { status: 'accepted', title: 'รับแล้ว', accent: 'border-t-gold' },
  { status: 'preparing', title: 'กำลังทำ', accent: 'border-t-ember' },
  { status: 'ready', title: 'พร้อมเสิร์ฟ', accent: 'border-t-royal' },
]

export default function Kitchen() {
  // จอครัวเปิดค้างทั้งวัน ถ้า realtime หลุดตอนเน็ตสะดุดแล้วไม่มีอะไรดึงซ้ำ
  // ออเดอร์จะหายไปเงียบ ๆ — ดึงซ้ำทุก 20 วินาทีเป็นตาข่ายรองรับ
  const { data } = useSnapshot({ refetchInterval: 20_000 })
  const now = useNow(1000)

  const active = (data?.orders ?? []).filter((o) =>
    ['placed', 'accepted', 'preparing', 'ready'].includes(o.status),
  )
  const incoming = active.filter((o) => o.status === 'placed').length

  // ออเดอร์ใหม่เข้ามา → กระดิ่งสั่น + เสียงเตือน (ไม่เตือนตอนเปิดหน้าครั้งแรก)
  const prevIncoming = useRef<number | null>(null)
  const [ring, setRing] = useState(0)
  useEffect(() => {
    if (prevIncoming.current !== null && incoming > prevIncoming.current) {
      setRing((n) => n + 1)
      playNewOrderChime()
    }
    prevIncoming.current = incoming
  }, [incoming])

  // ตัวเลขบนแท็บ — คนครัวสลับไปแท็บอื่นแล้วยังเห็นว่ามีงานเข้า
  useEffect(() => {
    setTabBadge(incoming)
    return () => setTabBadge(0)
  }, [incoming])

  const [sound, setSound] = useState(soundEnabled)
  const [soundError, setSoundError] = useState(false)

  // แจ้งเตือนขึ้นมือถือ — ทำงานแม้ปิดแอป ต่างจากเสียงที่ต้องเปิดหน้านี้ค้างไว้
  const [push, setPush] = useState<PushState | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  useEffect(() => {
    void pushState().then(setPush).catch(() => setPush('unsupported'))
  }, [])

  async function togglePush() {
    setPushBusy(true)
    try {
      setPush(push === 'on' ? await disablePush() : await enablePush())
    } catch (e) {
      console.error(e)
      setPush('off')
    } finally {
      setPushBusy(false)
    }
  }

  async function toggleSound() {
    if (sound) {
      disableSound()
      setSound(false)
      return
    }
    // ต้องปลดล็อกจากในเหตุการณ์กดเท่านั้น เบราว์เซอร์ถึงจะยอมให้เล่นเสียง
    const ok = await enableSound()
    setSound(ok)
    setSoundError(!ok)
    if (ok) playNewOrderChime()
  }

  if (!data) return null

  function tableOf(order: Order) {
    // ใช้ occupancy ปัจจุบัน ไม่ใช่ snapshot ตอนสั่ง — ลูกค้าอาจย้ายโต๊ะไปแล้ว
    const occ = data!.occupancies.find((o) => o.visitId === order.visitId && o.toAt === null)
    const table = data!.tables.find((t) => t.id === occ?.tableId)
    const moved = order.tableIdSnapshot && occ && order.tableIdSnapshot !== occ.tableId
    return { code: table?.code ?? '—', moved }
  }

  const late = active.filter(
    (o) => (now.getTime() - new Date(o.placedAt).getTime()) / 60_000 >= SLA_MINUTES,
  ).length

  return (
    <div>
      <PageHeader
        eyebrow="เตาไฟหลังร้าน"
        title="ครัว"
        subtitle={`เป้าหมาย ${SLA_MINUTES} นาทีต่อออเดอร์ · ค้างอยู่ ${active.length} ใบ`}
        actions={
          <div className="flex items-center gap-2">
            {late > 0 && <Badge tone="crimson">เลยเวลา {late} ใบ</Badge>}
            {push && push !== 'unsupported' && push !== 'not-configured' && (
              <Button
                variant={push === 'on' ? 'primary' : 'ghost'}
                disabled={pushBusy || push === 'ios-needs-install' || push === 'denied'}
                onClick={togglePush}
                title={PUSH_HINT[push]}
              >
                {push === 'on' ? '📲 เตือนมือถือเปิด' : '📵 เตือนมือถือปิด'}
              </Button>
            )}
            {soundSupported() && (
              <Button
                variant={sound ? 'primary' : 'ghost'}
                onClick={toggleSound}
                title={
                  sound
                    ? 'ปิดเสียงเตือน'
                    : 'เปิดเสียงเตือน — เบราว์เซอร์ต้องให้กดก่อนถึงจะเล่นเสียงได้'
                }
              >
                {sound ? '🔔 เสียงเปิด' : '🔕 เสียงปิด'}
              </Button>
            )}
            <div
              key={ring}
              className={`grid h-11 w-11 place-items-center rounded-full border border-gold/50 bg-gold/10 text-gold-deep ${
                ring > 0 ? 'animate-ring' : ''
              }`}
              title="กระดิ่งดังเมื่อมีออเดอร์ใหม่"
            >
              <Icon name="bell" />
            </div>
          </div>
        }
      />

      {soundError && (
        <p className="mb-3 rounded-lg border border-crimson/40 bg-crimson/10 p-3 text-sm text-crimson">
          เบราว์เซอร์ไม่ยอมเปิดเสียง ลองกดปุ่มอีกครั้ง หรือตรวจการตั้งค่าเสียงของเว็บนี้
        </p>
      )}

      {push && push !== 'on' && push !== 'off' && push !== 'unsupported' && (
        <p className="mb-3 rounded-lg border border-lapis/40 bg-lapis/10 p-3 text-sm text-lapis">
          {PUSH_HINT[push]}
        </p>
      )}

      {!sound && soundSupported() && (
        <p className="mb-3 rounded-lg border border-ember/40 bg-ember/10 p-3 text-sm text-ember-deep">
          เสียงเตือนยังปิดอยู่ — กด “เสียงปิด” ด้านบนหนึ่งครั้งเพื่อเปิด
          (เบราว์เซอร์บังคับให้ผู้ใช้กดก่อน ถึงจะเล่นเสียงได้)
        </p>
      )}

      {active.length === 0 ? (
        <Empty icon="🍲">ไม่มีออเดอร์ค้าง 🎉</Empty>
      ) : (
        <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
          {COLUMNS.map((col) => {
            const orders = active.filter((o) => o.status === col.status)
            return (
              <section
                key={col.status}
                className={`w-72 shrink-0 snap-start rounded-xl border-t-4 bg-parchment-deep/50 p-3 lg:w-auto ${col.accent}`}
              >
                <h2 className="mb-3 flex items-center justify-between px-1 text-sm font-bold">
                  {col.title}{' '}
                  <span className="tabular rounded-full bg-vellum px-2 py-0.5 text-xs text-ink-faint">
                    ({orders.length})
                  </span>
                </h2>
                <div className="space-y-3">
                  {orders.length === 0 && (
                    <p className="py-6 text-center text-xs text-ink-faint italic">— ว่าง —</p>
                  )}
                  {orders.map((order) => (
                    <Ticket key={order.id} order={order} now={now} {...tableOf(order)} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Ticket({
  order,
  now,
  code,
  moved,
}: {
  order: Order
  now: Date
  code: string
  moved: unknown
}) {
  const waited = Math.floor((now.getTime() - new Date(order.placedAt).getTime()) / 60_000)
  const late = waited >= SLA_MINUTES
  const next = NEXT[order.status]
  const pct = Math.min(100, (waited / SLA_MINUTES) * 100)

  return (
    <article
      className={`panel animate-page overflow-hidden rounded-lg ${late ? 'animate-ember-pulse !border-crimson/60' : ''}`}
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="text-xl tracking-wide font-bold">{code}</span>
        <span className={`tabular flex items-center gap-1 text-sm ${late ? 'font-bold text-crimson' : 'text-ink-faint'}`}>
          <Icon name="clock" className="h-4 w-4" />
          {waited} นาที
        </span>
      </div>

      {/* เวลาที่รอเทียบกับ SLA */}
      <div className="mx-3 mt-2 h-1 overflow-hidden rounded-full bg-parchment-deep">
        <div
          className={`h-full rounded-full transition-all ${late ? 'bg-crimson' : pct > 66 ? 'bg-ember' : 'bg-forest'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {moved ? (
        <div className="mx-3 mt-2">
          <Badge tone="ember">ลูกค้าย้ายโต๊ะแล้ว</Badge>
        </div>
      ) : null}

      <ul className="mx-3 mt-3 space-y-1.5 border-t border-dashed border-line-strong pt-3 text-sm">
        {order.lines.map((line) => (
          <li key={line.id}>
            <span className="tabular font-bold text-gold-deep">{line.qty}×</span> {line.nameSnapshot}
            {line.note && <div className="pl-5 text-xs text-ember-deep italic">↳ {line.note}</div>}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex gap-1.5 bg-parchment/60 p-2">
        {next && (
          <Button
            variant={order.status === 'ready' ? 'forest' : 'primary'}
            className="flex-1"
            onClick={() => db.updateOrderStatus(order.id, next.to)}
          >
            {next.label}
          </Button>
        )}
        {order.status === 'placed' && (
          <Button variant="danger" onClick={() => db.updateOrderStatus(order.id, 'rejected')}>
            ของหมด
          </Button>
        )}
      </div>
    </article>
  )
}
