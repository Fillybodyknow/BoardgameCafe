import { useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { guestDb, menuImageUrl } from '../../data'
import { cartItems, setCartQty, type Cart } from '../../lib/cart'
import { formatBaht } from '../../domain/pricing'
import type { GuestOrder, MenuItem, OrderStatus } from '../../domain/types'
import { Badge, Button, Card, Empty, INPUT } from '../../components/ui'
import { myPass, rememberMyPass, type MyPass } from '../../lib/myPass'
import { isPlaceholderName } from '../../lib/placeholderName'
import type { Tone } from '../../components/ui'
import { Stepper } from '../OrderDialog'
import { needsKitchen } from '../../domain/kitchen'

const CATEGORY_LABEL: Record<MenuItem['category'], string> = {
  drink: 'เครื่องดื่ม',
  snack: 'ของกินเล่น',
  food: 'อาหารจานหลัก',
  dessert: 'ของหวาน',
}
const CATEGORY_ICON: Record<MenuItem['category'], string> = {
  drink: '🍺',
  snack: '🥨',
  food: '🍖',
  dessert: '🍯',
}

const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  placed: { label: 'ส่งเข้าครัวแล้ว', tone: 'lapis' },
  accepted: { label: 'ครัวรับแล้ว', tone: 'lapis' },
  preparing: { label: 'กำลังทำ', tone: 'ember' },
  ready: { label: 'พร้อมเสิร์ฟ', tone: 'royal' },
  served: { label: 'เสิร์ฟแล้ว', tone: 'forest' },
  rejected: { label: 'ของหมด', tone: 'crimson' },
  cancelled: { label: 'ยกเลิก', tone: 'neutral' },
}

/** ขั้นของออเดอร์ที่ลูกค้าเห็นเป็นเส้นทาง */
const TRACK: { status: OrderStatus; label: string }[] = [
  { status: 'placed', label: 'สั่ง' },
  { status: 'accepted', label: 'รับ' },
  { status: 'preparing', label: 'ทำ' },
  { status: 'ready', label: 'พร้อม' },
  { status: 'served', label: 'เสิร์ฟ' },
]

type Tab = 'menu' | 'orders' | 'bill'

type Coin = { id: number; x: number; y: number; dx: number; dy: number }

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
  const [me, setMe] = useState(() => myPass(token))
  /** 'mine' = ของฉันคนเดียว, 'shared' = หารกันทั้งโต๊ะ */
  const [split, setSplit] = useState<'mine' | 'shared'>('mine')
  const [cart, setCart] = useState<Cart>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSent, setJustSent] = useState(false)
  const [coins, setCoins] = useState<Coin[]>([])
  const bagRef = useRef<HTMLDivElement>(null)

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
    return (
      <Centered>
        <div className="dice-rolling text-4xl">🎲</div>
        <p className="mt-4 text-ink-soft italic">กำลังเปิดเมนู…</p>
      </Centered>
    )
  }

  if (session.isError) {
    return (
      <Centered>
        <div className="wax-seal h-20 w-20 rotate-12 text-3xl opacity-80">✕</div>
        <p className="mt-5 text-lg font-semibold">QR นี้ใช้ไม่ได้</p>
        <p className="mt-2 text-sm text-ink-soft">ลองสแกนใหม่ หรือแจ้งพนักงานครับ</p>
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
        <div className="shield h-28 w-24 bg-wine text-3xl text-gold-light shadow-xl">
          {s.tableCode}
        </div>
        <p className="mt-3 text-sm text-ink-faint">{s.zone}</p>
        <div className="divider my-6 w-48 text-xs" aria-hidden>
          ◆
        </div>
        {s.ended ? (
          <>
            <p className="font-display text-lg font-bold">รอบนี้ปิดบิลแล้ว</p>
            <p className="mt-2 max-w-xs text-sm text-ink-soft">
              ขอบคุณที่มาเล่นด้วยกันนะครับ — QR ใบนี้ใช้ได้เฉพาะรอบที่ผ่านมา
              มาครั้งหน้าพนักงานจะพิมพ์ใบใหม่ให้
            </p>
          </>
        ) : (
          <>
            {/* สติกเกอร์ QR ติดโต๊ะแบบเก่า — QR ตอนนี้ออกใหม่ทุกครั้งที่เปิดโต๊ะ */}
            <p className="font-display text-lg font-bold">ยังไม่ได้เปิดโต๊ะ</p>
            <p className="mt-2 max-w-xs text-sm text-ink-soft">
              QR ที่ติดโต๊ะเลิกใช้แล้ว แจ้งพนักงานเพื่อเปิดโต๊ะ แล้วสแกนจากใบ QR ที่ได้รับครับ
            </p>
          </>
        )}
      </Centered>
    )
  }

  // คนที่เคยลงชื่อแล้วแต่พนักงานลบออก (หรือปิดบิลไปแล้ว) ต้องลงใหม่
  const stillHere = me !== null && s.passes.some((p) => p.id === me.passId)
  if (!stillHere) {
    return (
      <RegisterGate
        token={token}
        tableCode={s.tableCode}
        zone={s.zone}
        passes={s.passes}
        onDone={(pass) => {
          rememberMyPass(token, pass)
          setMe(pass)
          void qc.invalidateQueries({ queryKey: ['guest', token] })
        }}
      />
    )
  }

  /** เหรียญทองลอยจากปุ่ม + ไปลงถุงเงินด้านล่าง */
  function flyCoin(el: HTMLElement) {
    const from = el.getBoundingClientRect()
    const bag = bagRef.current?.getBoundingClientRect()
    const x = from.left + from.width / 2
    const y = from.top + from.height / 2
    const tx = bag ? bag.left + bag.width / 2 : window.innerWidth / 2
    const ty = bag ? bag.top + bag.height / 2 : window.innerHeight - 48
    setCoins((c) => [...c, { id: Date.now() + Math.random(), x, y, dx: tx - x, dy: ty - y }])
  }

  async function send(ordererId: string | null) {
    setSending(true)
    setError(null)
    try {
      await guestDb.placeOrder({
        token,
        // สร้างใหม่ทุกครั้งที่กดส่ง — กดรัวจะได้ไม่เกิดออเดอร์ซ้ำ
        idempotencyKey: `g-${token}-${Date.now()}`,
        orderedByPassId: ordererId,
        splitMode: ordererId ? 'owner' : 'shared',
        items: cartItems(cart),
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

  const liveOrders = (orders.data ?? []).filter((o) =>
    ['placed', 'accepted', 'preparing', 'ready'].includes(o.status),
  ).length

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      {/* ธงประจำโต๊ะ */}
      <header className="tapestry pennant px-5 pt-5 pb-10 text-center">
        <div className="brand text-xs">⚜ Boardgame Cafe</div>
        <h1 className="mt-2 font-sans text-3xl font-bold text-gold-light">โต๊ะ {s.tableCode}</h1>
        <p className="mt-1 text-xs text-[#f3e6c8]/70">
          {s.zone} · ยินดีต้อนรับสู่โรงเตี๊ยม ขอให้สนุกกับเกมนะ
        </p>
      </header>

      <nav className="sticky top-0 z-30 -mt-4 px-4 pt-1 pb-3">
        <div className="seg flex w-full shadow-lg">
          {(['menu', 'orders', 'bill'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className="relative flex-1"
            >
              {t === 'menu' ? 'เมนู' : t === 'orders' ? 'ออเดอร์' : 'ยอดของโต๊ะ'}
              {t === 'orders' && liveOrders > 0 && (
                <span className="absolute -top-1 right-2 grid h-4 min-w-4 place-items-center rounded-full bg-crimson px-1 text-[0.6rem] font-bold text-vellum">
                  {liveOrders}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      <main className="flex-1 px-4 pb-36">
        {justSent && (
          <div className="mb-4 flex animate-unroll items-center gap-3 rounded-xl border border-forest/40 bg-forest/10 p-3 text-sm text-forest-deep">
            <span className="wax-seal seal-stamp h-9 w-9 shrink-0 text-sm">✓</span>
            ส่งเข้าครัวแล้ว ติดตามสถานะได้ที่แท็บออเดอร์
          </div>
        )}

        <div key={tab} className="animate-page">
          {tab === 'menu' && (
            <>
              {!s.kitchen.open && (
                <div className="mb-4 flex items-center gap-3 rounded-xl border border-ember/40 bg-ember/10 p-3 text-sm text-ember-deep">
                  <span className="text-xl" aria-hidden>
                    🍳
                  </span>
                  <span>
                    {s.kitchen.reason} ตอนนี้สั่งได้เฉพาะเครื่องดื่มและของกินเล่น ถ้าอยากได้อาหาร
                    ลองแจ้งพนักงานดูได้
                  </span>
                </div>
              )}

              {/* ทางลัดไปแต่ละหมวด */}
              <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
                {groups.map(([category]) => (
                  <button
                    key={category}
                    type="button"
                    className="chip"
                    onClick={() =>
                      document
                        .getElementById(`cat-${category}`)
                        ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    {CATEGORY_ICON[category]} {CATEGORY_LABEL[category]}
                  </button>
                ))}
              </div>

              <div className="space-y-6">
                {groups.map(([category, items]) => (
                  <section key={category} id={`cat-${category}`} className="scroll-mt-20">
                    <h2 className="flourish mb-2 text-sm font-semibold">
                      {CATEGORY_LABEL[category]}
                    </h2>
                    <div className="space-y-2">
                      {items.map((item) => {
                        const qty = cart[item.id] ?? 0
                        const img = menuImageUrl(item.imagePath)
                        // ครัวปิดแล้วก็ยังสั่งเครื่องดื่มได้ แค่ของที่ต้องเข้าครัวสั่งไม่ได้
                        const kitchenClosed = !s.kitchen.open && needsKitchen(item)
                        const orderable = item.available && !kitchenClosed
                        return (
                          <div
                            key={item.id}
                            className={`panel flex items-center justify-between gap-3 rounded-xl p-2.5 transition ${
                              orderable ? '' : 'opacity-50'
                            } ${qty > 0 ? '!border-gold/60' : ''}`}
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              {img ? (
                                <img
                                  src={img}
                                  alt=""
                                  loading="lazy"
                                  className="h-16 w-16 shrink-0 rounded-lg object-cover"
                                />
                              ) : (
                                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-parchment-deep text-2xl">
                                  {CATEGORY_ICON[item.category]}
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="truncate font-medium">{item.name}</div>
                                <div className="tabular text-sm font-semibold text-gold-deep">
                                  ฿{formatBaht(item.price)}
                                </div>
                                {!item.available && (
                                  <div className="text-xs text-crimson">ของหมด</div>
                                )}
                                {item.available && kitchenClosed && (
                                  <div className="text-xs text-ember-deep">ครัวปิดแล้ว</div>
                                )}
                              </div>
                            </div>
                            <Stepper
                              qty={qty}
                              disabled={!orderable}
                              onAdd={flyCoin}
                              onChange={(n) => setCart((c) => setCartQty(c, item.id, n))}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}

          {tab === 'orders' && <OrderList orders={orders.data ?? []} passes={s.passes} />}

          {tab === 'bill' && (
            <>
              {bill.isPending && <Empty icon="⚖">กำลังคิดยอด…</Empty>}
              {bill.data && (
                <Card ornate>
                  <h2 className="text-center font-display text-sm tracking-[0.2em] text-gold-deep uppercase">
                    ใบแจ้งยอด
                  </h2>
                  <ul className="mt-4 space-y-1.5 text-sm">
                    {bill.data.lines.map((line) => (
                      <li key={line.id} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate text-ink-soft">{line.label}</span>
                        <span className="tabular shrink-0">฿{formatBaht(line.amount)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex items-baseline justify-between border-t border-double border-line-strong pt-3 text-lg font-bold">
                    <span className="font-display">ยอดรวมทั้งโต๊ะ</span>
                    <span className="tabular text-2xl text-gold-deep">
                      ฿{formatBaht(bill.data.total)}
                    </span>
                  </div>
                  <p className="mt-3 text-center text-xs text-ink-faint italic">
                    ค่าเล่นยังเดินอยู่ ยอดนี้เป็นยอด ณ ตอนนี้ · ชำระเงินที่เคาน์เตอร์
                  </p>
                </Card>
              )}
            </>
          )}
        </div>
      </main>

      {tab === 'menu' && cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg animate-unroll px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="tapestry flex items-center gap-3 rounded-2xl p-3 shadow-2xl">
            <div
              ref={bagRef}
              key={cartCount}
              className="relative grid h-11 w-11 shrink-0 animate-bump place-items-center rounded-full bg-gold/20 text-2xl"
            >
              💰
              <span className="tabular absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-crimson px-1 text-[0.65rem] font-bold text-vellum">
                {cartCount}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              {error && <p className="truncate text-xs text-[#ffb4a8]">{error}</p>}
              <div className="text-xs text-[#f3e6c8]/70">{cartCount} รายการ</div>
              <div className="tabular font-bold text-gold-light">฿{formatBaht(cartTotal)}</div>
            </div>
            <Button
              variant="primary"
              className="!px-5 !py-2.5"
              onClick={() => void send(split === 'mine' ? me.passId : null)}
              disabled={sending}
            >
              {sending ? 'กำลังส่ง…' : 'ส่งเข้าครัว'}
            </Button>
          </div>

          {/* เครื่องรู้แล้วว่าเราคือใคร เหลือแค่บอกว่าจ่ายคนเดียวหรือหารกัน */}
          <div className="mt-2 flex gap-1.5 rounded-xl bg-[#2a1c12]/60 p-1 text-sm">
            {(
              [
                ['mine', `ของ ${me.displayName}`],
                ['shared', 'หารกันทั้งโต๊ะ'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={split === v}
                onClick={() => setSplit(v)}
                className={`flex-1 truncate rounded-lg px-2 py-1.5 transition ${
                  split === v ? 'bg-gold text-[#2a1c12] font-semibold' : 'text-[#f3e6c8]/80'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {coins.map((c) => (
        <span
          key={c.id}
          className="coin-fly"
          style={{
            left: c.x,
            top: c.y,
            ['--dx' as string]: `${c.dx}px`,
            ['--dy' as string]: `${c.dy}px`,
          }}
          onAnimationEnd={() => setCoins((all) => all.filter((x) => x.id !== c.id))}
        />
      ))}
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
  if (orders.length === 0) return <Empty icon="🍺">ยังไม่มีออเดอร์</Empty>

  return (
    <div className="space-y-3">
      {orders.map((order) => {
        const who = order.orderedByPassId
          ? passes.find((p) => p.id === order.orderedByPassId)?.displayName
          : 'แชร์ทั้งโต๊ะ'
        const total = order.lines.reduce((s, l) => s + l.amount, 0)
        const st = STATUS[order.status]
        const step = TRACK.findIndex((t) => t.status === order.status)
        return (
          <Card key={order.id}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-ink-faint">{who ?? '—'}</span>
              </div>
              <span className="tabular text-sm font-semibold">฿{formatBaht(total)}</span>
            </div>

            {/* เส้นทางของออเดอร์ */}
            {step >= 0 && (
              <ol className="mt-4 flex items-center" aria-label="สถานะออเดอร์">
                {TRACK.map((t, i) => (
                  <li key={t.status} className="flex flex-1 items-center last:flex-none">
                    <div className="flex flex-col items-center gap-1">
                      <span
                        className={`grid h-6 w-6 place-items-center rounded-full border text-[0.6rem] transition ${
                          i < step
                            ? 'border-forest bg-forest text-vellum'
                            : i === step
                              ? 'animate-pulse border-gold bg-gold text-ink'
                              : 'border-line-strong bg-vellum text-ink-faint'
                        }`}
                      >
                        {i < step ? '✓' : i + 1}
                      </span>
                      <span
                        className={`text-[0.65rem] ${i <= step ? 'text-ink' : 'text-ink-faint'}`}
                      >
                        {t.label}
                      </span>
                    </div>
                    {i < TRACK.length - 1 && (
                      <span
                        className={`mx-1 mb-4 h-0.5 flex-1 rounded ${i < step ? 'bg-forest' : 'bg-line'}`}
                      />
                    )}
                  </li>
                ))}
              </ol>
            )}

            <ul className="mt-3 space-y-0.5 border-t border-dashed border-line pt-2 text-sm text-ink-soft">
              {order.lines.map((line) => (
                <li key={line.id} className="flex justify-between">
                  <span>
                    {line.name} × {line.qty}
                  </span>
                  <span className="tabular text-ink-faint">฿{formatBaht(line.amount)}</span>
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
    <div className="flex min-h-screen animate-page flex-col items-center justify-center p-8 text-center">
      {children}
    </div>
  )
}

/**
 * ลงชื่อครั้งแรกก่อนสั่งของ
 *
 * ขอแค่ชื่อ ไม่ขอเบอร์หรืออย่างอื่น เพราะสิ่งเดียวที่ระบบต้องรู้คือ
 * "ออเดอร์นี้ของใคร" ตอนแยกบิล ยิ่งถามน้อยยิ่งมีคนกรอกจริง
 */
function RegisterGate({
  token,
  tableCode,
  zone,
  passes,
  onDone,
}: {
  token: string
  tableCode: string
  zone: string
  passes: { id: string; displayName: string; claimed?: boolean }[]
  onDone: (pass: MyPass) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // ชื่อที่พนักงานสร้างไว้ตอนเปิดโต๊ะ ซึ่งยังไม่มีเครื่องไหนมารับ
  const unclaimed = passes.filter((p) => !p.claimed)
  const [picked, setPicked] = useState<{ id: string; displayName: string } | null>(null)
  const [rename, setRename] = useState('')

  async function run(fn: () => Promise<MyPass>) {
    setBusy(true)
    setError(null)
    try {
      onDone(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลงชื่อไม่สำเร็จ')
      setBusy(false)
    }
  }

  const submit = () => run(() => guestDb.register(token, name))

  // ชื่อชั่วคราวต้องเปลี่ยนเป็นชื่อจริง ไม่งั้นบิลแยกจะขึ้นว่า "ผู้เล่น 2" ไปจนจบ
  const needsName = picked !== null && isPlaceholderName(picked.displayName)
  const claim = () =>
    run(() => guestDb.claim(token, picked!.id, rename.trim() || undefined))

  return (
    <Centered>
      <div className="shield h-28 w-24 bg-wine text-3xl text-gold-light shadow-xl">{tableCode}</div>
      <p className="mt-3 text-sm text-ink-faint">{zone}</p>
      <div className="divider my-6 w-48 text-xs" aria-hidden>
        ◆
      </div>

      <p className="font-display text-lg font-bold">คุณชื่ออะไร</p>

      {unclaimed.length > 0 && (
        <div className="mt-2 w-full max-w-xs">
          <p className="text-sm text-ink-soft">พนักงานลงชื่อโต๊ะนี้ไว้แล้ว แตะชื่อของคุณ</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {unclaimed.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={picked?.id === p.id}
                disabled={busy}
                onClick={() => {
                  setPicked(p)
                  setRename(isPlaceholderName(p.displayName) ? '' : p.displayName)
                  setError(null)
                }}
                className="pick truncate px-3 py-2.5 text-sm font-medium"
              >
                {p.displayName}
              </button>
            ))}
          </div>

          {picked && (
            <div className="panel mt-3 animate-unroll rounded-xl p-3 text-left">
              <p className="text-sm">
                คุณคือ <b>{picked.displayName}</b> ใช่ไหม
              </p>
              <input
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && (!needsName || rename.trim())) void claim()
                }}
                maxLength={40}
                placeholder="ชื่อที่จะให้เพื่อนเห็น"
                className={`${INPUT} mt-2`}
                autoFocus
              />
              {needsName && (
                <p className="mt-1 text-xs text-ink-faint">ใส่ชื่อจริงแทน “{picked.displayName}” ตอนแยกบิลจะได้รู้ว่าใคร</p>
              )}
              <div className="mt-3 flex gap-2">
                <Button className="flex-1" disabled={busy} onClick={() => setPicked(null)}>
                  ไม่ใช่
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={busy || (needsName && !rename.trim())}
                  onClick={() => void claim()}
                >
                  ใช่ ฉันเอง
                </Button>
              </div>
            </div>
          )}

          <div className="divider my-5 text-xs text-ink-faint">หรือ</div>
          <p className="text-sm text-ink-soft">ไม่มีชื่อคุณ? ลงชื่อใหม่</p>
          <p className="text-xs text-ink-faint">จะเพิ่มเป็นผู้เล่นอีกคนในโต๊ะ และคิดค่าเล่นเพิ่ม</p>
        </div>
      )}

      {unclaimed.length === 0 && (
        <p className="mt-2 max-w-xs text-sm text-ink-soft">
          ลงชื่อครั้งเดียวพอ เครื่องนี้จะจำไว้ให้ ตอนสั่งของจะได้ไม่ต้องเลือกชื่อทุกครั้ง
        </p>
      )}

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim() && !busy) void submit()
        }}
        maxLength={40}
        placeholder="ชื่อเล่นก็ได้"
        className={`${INPUT} mt-5 max-w-xs text-center`}
      />

      {error && <p className="mt-3 animate-shake text-sm text-crimson">{error}</p>}

      <Button
        variant="primary"
        className="mt-4 w-full max-w-xs !py-3"
        disabled={busy || !name.trim()}
        onClick={() => void submit()}
      >
        {busy ? 'กำลังลงชื่อ…' : 'เริ่มสั่งของ'}
      </Button>
    </Centered>
  )
}
