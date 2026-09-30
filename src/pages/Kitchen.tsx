import { useNow, useSnapshot } from '../hooks/useData'
import { db } from '../data'
import type { Order, OrderStatus } from '../domain/types'
import { Badge, Button, Card, Empty } from '../components/ui'

/** SLA — เกินแล้วการ์ดเปลี่ยนสี ให้ครัวเห็นแต่ไกล */
const SLA_MINUTES = 12

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  placed: { to: 'accepted', label: 'รับออเดอร์' },
  accepted: { to: 'preparing', label: 'เริ่มทำ' },
  preparing: { to: 'ready', label: 'ทำเสร็จ' },
  ready: { to: 'served', label: 'เสิร์ฟแล้ว' },
}

const COLUMNS: { status: OrderStatus; title: string }[] = [
  { status: 'placed', title: 'เข้าใหม่' },
  { status: 'accepted', title: 'รับแล้ว' },
  { status: 'preparing', title: 'กำลังทำ' },
  { status: 'ready', title: 'พร้อมเสิร์ฟ' },
]

export default function Kitchen() {
  const { data } = useSnapshot()
  const now = useNow(1000)

  if (!data) return null

  const active = data.orders.filter((o) =>
    ['placed', 'accepted', 'preparing', 'ready'].includes(o.status),
  )

  function tableOf(order: Order) {
    // ใช้ occupancy ปัจจุบัน ไม่ใช่ snapshot ตอนสั่ง — ลูกค้าอาจย้ายโต๊ะไปแล้ว
    const occ = data!.occupancies.find((o) => o.visitId === order.visitId && o.toAt === null)
    const table = data!.tables.find((t) => t.id === occ?.tableId)
    const moved = order.tableIdSnapshot && occ && order.tableIdSnapshot !== occ.tableId
    return { code: table?.code ?? '—', moved }
  }

  if (active.length === 0) return <Empty>ไม่มีออเดอร์ค้าง 🎉</Empty>

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {COLUMNS.map((col) => {
        const orders = active.filter((o) => o.status === col.status)
        return (
          <section key={col.status}>
            <h2 className="mb-2 text-sm font-semibold text-slate-400">
              {col.title}{' '}
              <span className="tabular text-slate-600">({orders.length})</span>
            </h2>
            <div className="space-y-2">
              {orders.map((order) => {
                const waited = Math.floor((now.getTime() - new Date(order.placedAt).getTime()) / 60_000)
                const late = waited >= SLA_MINUTES
                const next = NEXT[order.status]
                const { code, moved } = tableOf(order)
                return (
                  <Card
                    key={order.id}
                    className={late ? 'border-rose-700/70 bg-rose-950/20' : ''}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold">{code}</span>
                      <span className={`tabular text-sm ${late ? 'text-rose-400' : 'text-slate-400'}`}>
                        {waited} นาที
                      </span>
                    </div>
                    {moved && (
                      <div className="mt-1">
                        <Badge tone="amber">ลูกค้าย้ายโต๊ะแล้ว</Badge>
                      </div>
                    )}
                    <ul className="mt-2 space-y-1 text-sm">
                      {order.lines.map((line) => (
                        <li key={line.id}>
                          <span className="tabular font-semibold">{line.qty}×</span> {line.nameSnapshot}
                          {line.note && (
                            <div className="text-xs text-amber-400">↳ {line.note}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex gap-1">
                      {next && (
                        <Button
                          variant="primary"
                          className="flex-1"
                          onClick={() => db.updateOrderStatus(order.id, next.to)}
                        >
                          {next.label}
                        </Button>
                      )}
                      {order.status === 'placed' && (
                        <Button
                          variant="danger"
                          onClick={() => db.updateOrderStatus(order.id, 'rejected')}
                        >
                          ของหมด
                        </Button>
                      )}
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
