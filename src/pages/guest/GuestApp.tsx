import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { guestDb, menuImageUrl } from '../../data'
import { formatBaht } from '../../domain/pricing'
import type { GuestOrder, MenuItem, OrderStatus } from '../../domain/types'
import { Badge, Button, Card, Empty } from '../../components/ui'
import type { Tone } from '../../components/ui'

const CATEGORY_LABEL: Record<MenuItem['category'], string> = {
  drink: 'เครื่องดื่ม', snack: 'ของกินเล่น', food: 'อาหารจานหลัก', dessert: 'ของหวาน',
}

const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  placed: { label: 'ส่งเข้าครัวแล้ว', tone: 'sky' },
  accepted: { label: 'ครัวรับแล้ว', tone: 'sky' },
  preparing: { label: 'กำลังทำ', tone: 'amber' },
  ready: { label: 'พร้อมเสิร์ฟ', tone: 'violet' },
  served: { label: 'เสิร์ฟแล้ว', tone: 'emerald' },
  rejected: { label: 'ของหมด', tone: 'rose' },
  cancelled: { label: 'ยกเลิก', tone: 'slate' },
}

type Tab = 'menu' | 'orders' | 'bill'

/**
 * หน้าจอของลูกค้าที่สแกน QR ที่โต๊ะ
 *
 * ไม่มีการล็อกอิน สิทธิ์ทั้งหมดมาจาก token ใน URL
 * ทุกคำขอส่ง token ไปให้เซิร์ฟเวอร์แปลงเป็นโต๊ะเอง หน้าจอนี้ไม่เคยรู้จัก
 * visitId ของโต๊ะอื่น และแก้ค่าใน URL ให้ไปโต๊ะอื่นก็ไม่ได้
 */
export default function GuestApp() {
  const { token = '' } = useParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('menu')
  const [passId, setPassId] = useState<string>('')
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSent, setJustSent] = useState(false)

  const session = useQuery({
    queryKey: ['guest', token, 'session'],
    queryFn: () => guestDb.session(token),
    retry: false,
  })

  const orders = useQuery({
    queryKey: ['guest', token, 'orders'],
    queryFn: () => guestDb.orders(token),
    enabled: Boolean(session.data?.visitId),
    refetchInterval: 15_000,
  })

  const bill = useQuery({
    queryKey: ['guest', token, 'bill'],
    queryFn: () => guestDb.bill(token),
    enabled: Boolean(session.data?.visitId) && tab === 'bill',
  })

  const groups = useMemo(() => {
    const byCat = new Map<MenuItem['category'], MenuItem[]>()
    for (const item of session.data?.menu ?? []) {
      const list = byCat.get(item.category) ?? []
      list.push(item)
      byCat.set(item.category, list)
    }
    return [...byCat.entries()]
  }, [session.data])

  if (session.isPending) {
    return <Centered>กำลังเปิดเมนู…</Centered>
  }

  if (session.isError) {
    return (
      <Centered>
        <p className="text-lg font-semibold">QR นี้ใช้ไม่ได้</p>
        <p className="mt-2 text-sm text-slate-400">ลองสแกนใหม่ หรือแจ้งพนักงานครับ</p>
      </Centered>
    )
  }

  const s = session.data
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0)
  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = s.menu.find((m) => m.id === id)
    return sum + (item ? item.price * qty : 0)
  }, 0)

  // โต๊ะยังไม่เปิด — สั่งอะไรไม่ได้จนกว่าพนักงานจะเปิดบิลให้
  if (!s.visitId) {
    return (
      <Centered>
        <p className="text-4xl font-bold">{s.tableCode}</p>
        <p className="mt-1 text-sm text-slate-500">{s.zone}</p>
        <p className="mt-6 text-lg">ยังไม่ได้เปิดโต๊ะ</p>
        <p className="mt-2 text-sm text-slate-400">
          แจ้งพนักงานเพื่อเปิดโต๊ะก่อนนะครับ แล้วสแกนใหม่อีกครั้ง
        </p>
      </Centered>
    )
  }

  async function send() {
    setSending(true)
    setError(null)
    try {
      await guestDb.placeOrder({
        token,
        // สร้างใหม่ทุกครั้งที่กดส่ง — กดรัวจะได้ไม่เกิดออเดอร์ซ้ำ
        idempotencyKey: `g-${token}-${Date.now()}`,
        orderedByPassId: passId || null,
        splitMode: passId ? 'owner' : 'shared',
        items: Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty })),
      })
      setCart({})
      setJustSent(true)
      setTab('orders')
      void qc.invalidateQueries({ queryKey: ['guest', token] })
      setTimeout(() => setJustSent(false), 4000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'สั่งไม่สำเร็จ')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-baseline justify-between">
          <span className="text-xl font-bold">โต๊ะ {s.tableCode}</span>
          <span className="text-xs text-slate-500">{s.zone}</span>
        </div>

        <div className="mt-3 flex gap-1">
          {(['menu', 'orders', 'bill'] as Tab[]).map((t) => (
            <Button
              key={t}
              className="flex-1"
              variant={tab === t ? 'subtle' : 'ghost'}
              onClick={() => setTab(t)}
            >
              {t === 'menu' ? 'เมนู' : t === 'orders' ? 'ออเดอร์' : 'ยอดของโต๊ะ'}
            </Button>
          ))}
        </div>
      </header>

      <main className="flex-1 p-4 pb-32">
        {justSent && (
          <Card className="mb-4 border-emerald-800/70 bg-emerald-950/30 text-sm text-emerald-300">
            ส่งเข้าครัวแล้ว ติดตามสถานะได้ที่แท็บออเดอร์
          </Card>
        )}

        {tab === 'menu' && (
          <>
            <Card className="mb-4">
              <label className="text-sm text-slate-400">สั่งในชื่อ</label>
              <select
                value={passId}
                onChange={(e) => setPassId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
              >
                <option value="">แชร์ทั้งโต๊ะ (หารกัน)</option>
                {s.passes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                เลือกชื่อตัวเองไว้ ตอนเช็คบิลจะแยกได้ว่าใครสั่งอะไร
              </p>
            </Card>

            <div className="space-y-5">
              {groups.map(([category, items]) => (
                <div key={category}>
                  <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    {CATEGORY_LABEL[category]}
                  </h2>
                  <div className="space-y-1">
                    {items.map((item) => {
                      const qty = cart[item.id] ?? 0
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center justify-between gap-2 rounded-lg px-2 py-2 ${
                            item.available ? '' : 'opacity-40'
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            {menuImageUrl(item.imagePath) && (
                              <img
                                src={menuImageUrl(item.imagePath)!}
                                alt=""
                                loading="lazy"
                                className="h-14 w-14 shrink-0 rounded-lg object-cover"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="truncate">
                                {item.name}
                                {!item.available && (
                                  <span className="ml-2 text-xs text-rose-400">ของหมด</span>
                                )}
                              </div>
                              <div className="tabular text-sm text-slate-500">
                                ฿{formatBaht(item.price)}
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              disabled={qty === 0}
                              onClick={() => setCart((c) => ({ ...c, [item.id]: Math.max(0, qty - 1) }))}
                            >
                              −
                            </Button>
                            <span className="tabular w-6 text-center">{qty || ''}</span>
                            <Button
                              disabled={!item.available}
                              onClick={() => setCart((c) => ({ ...c, [item.id]: qty + 1 }))}
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'orders' && <OrderList orders={orders.data ?? []} passes={s.passes} />}

        {tab === 'bill' && (
          <>
            {bill.isPending && <Empty>กำลังคิดยอด…</Empty>}
            {bill.data && (
              <Card>
                <ul className="space-y-1 text-sm">
                  {bill.data.lines.map((line) => (
                    <li key={line.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-slate-300">{line.label}</span>
                      <span className="tabular shrink-0">฿{formatBaht(line.amount)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex justify-between border-t border-slate-800 pt-3 text-lg font-bold">
                  <span>ยอดรวมทั้งโต๊ะ</span>
                  <span className="tabular text-emerald-400">฿{formatBaht(bill.data.total)}</span>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  ค่าเล่นยังเดินอยู่ ยอดนี้เป็นยอด ณ ตอนนี้ · ชำระเงินที่เคาน์เตอร์
                </p>
              </Card>
            )}
          </>
        )}
      </main>

      {tab === 'menu' && cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-lg border-t border-slate-800 bg-slate-900 p-4">
          {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-slate-400">{cartCount} รายการ</span>
            <span className="tabular font-bold">฿{formatBaht(cartTotal)}</span>
          </div>
          <Button variant="primary" className="w-full !py-3" onClick={send} disabled={sending}>
            {sending ? 'กำลังส่ง…' : 'ส่งเข้าครัว'}
          </Button>
        </div>
      )}
    </div>
  )
}

function OrderList({
  orders,
  passes,
}: {
  orders: GuestOrder[]
  passes: { id: string; displayName: string }[]
}) {
  if (orders.length === 0) return <Empty>ยังไม่มีออเดอร์</Empty>

  return (
    <div className="space-y-2">
      {orders.map((order) => {
        const who = order.orderedByPassId
          ? passes.find((p) => p.id === order.orderedByPassId)?.displayName
          : 'แชร์ทั้งโต๊ะ'
        const total = order.lines.reduce((s, l) => s + l.amount, 0)
        const st = STATUS[order.status]
        return (
          <Card key={order.id}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-slate-400">{who ?? '—'}</span>
              </div>
              <span className="tabular text-sm font-semibold">฿{formatBaht(total)}</span>
            </div>
            <ul className="mt-2 space-y-0.5 text-sm text-slate-300">
              {order.lines.map((line) => (
                <li key={line.id} className="flex justify-between">
                  <span>
                    {line.name} × {line.qty}
                  </span>
                  <span className="tabular text-slate-400">฿{formatBaht(line.amount)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
      {children}
    </div>
  )
}
