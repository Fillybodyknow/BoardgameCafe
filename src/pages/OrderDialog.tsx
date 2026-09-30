import { useMemo, useState } from 'react'
import { useSnapshot } from '../hooks/useData'
import { db, menuImageUrl } from '../data'
import { formatBaht } from '../domain/pricing'
import type { GuestPass, MenuItem } from '../domain/types'
import { Button, INPUT, Modal, Segmented } from '../components/ui'

const CATEGORY_LABEL: Record<MenuItem['category'], string> = {
  drink: 'เครื่องดื่ม',
  snack: 'ของกินเล่น',
  food: 'อาหารจานหลัก',
  dessert: 'ของหวาน',
}

export default function OrderDialog({
  visitId,
  passes,
  onClose,
}: {
  visitId: string
  passes: GuestPass[]
  onClose: () => void
}) {
  const { data } = useSnapshot()
  const [cart, setCart] = useState<Record<string, number>>({})
  const [splitMode, setSplitMode] = useState<'owner' | 'shared'>('owner')
  const [ownerId, setOwnerId] = useState<string>(passes[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // สร้างครั้งเดียวต่อการเปิด dialog — กดปุ่มรัว/เน็ตหลุดแล้ว retry จะไม่เกิดออเดอร์ซ้ำ
  const idempotencyKey = useMemo(() => `ord-${visitId}-${Date.now()}-${Math.random()}`, [visitId])

  const groups = useMemo(() => {
    const byCat = new Map<MenuItem['category'], MenuItem[]>()
    for (const item of data?.menu ?? []) {
      const list = byCat.get(item.category) ?? []
      list.push(item)
      byCat.set(item.category, list)
    }
    return [...byCat.entries()]
  }, [data])

  const total = Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = data?.menu.find((m) => m.id === id)
    return sum + (item ? item.price * qty : 0)
  }, 0)

  const count = Object.values(cart).reduce((a, b) => a + b, 0)
  const activePasses = passes.filter((p) => p.status === 'active' || p.status === 'paused')

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await db.placeOrder({
        idempotencyKey,
        visitId,
        orderedByPassId: splitMode === 'owner' ? ownerId : null,
        splitMode,
        placedBy: 'staff',
        items: Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty })),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'สั่งไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="รับออเดอร์"
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          {error && <p className="mb-2 animate-shake text-sm text-crimson">{error}</p>}
          <div className="mb-3 flex items-baseline justify-between text-sm">
            <span className="text-ink-faint">{count} รายการ</span>
            <span key={total} className="tabular animate-bump text-lg font-bold text-gold-deep">
              ฿{formatBaht(total)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button
              className="flex-1"
              variant="primary"
              disabled={count === 0 || busy || (splitMode === 'owner' && !ownerId)}
              onClick={submit}
            >
              ส่งเข้าครัว
            </Button>
          </div>
        </>
      }
    >
      <div className="panel mb-5 rounded-lg bg-parchment-deep/50 p-3">
        <Segmented
          className="w-full"
          value={splitMode}
          onChange={setSplitMode}
          options={[
            { value: 'owner', label: 'ลงชื่อคนสั่ง' },
            { value: 'shared', label: 'แชร์ทั้งโต๊ะ' },
          ]}
        />
        {splitMode === 'owner' && (
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={`${INPUT} mt-2`}>
            {activePasses.map((pass) => (
              <option key={pass.id} value={pass.id}>
                {pass.displayName}
              </option>
            ))}
          </select>
        )}
        {splitMode === 'shared' && (
          <p className="mt-2 text-xs text-ink-faint">
            ตอนแยกบิลจะหารเท่ากันในกลุ่ม {activePasses.length} คน
          </p>
        )}
      </div>

      <div className="space-y-5">
        {groups.map(([category, items]) => (
          <div key={category}>
            <h4 className="flourish mb-2 text-xs font-semibold">{CATEGORY_LABEL[category]}</h4>
            <div className="divide-y divide-line/70">
              {items.map((item) => {
                const qty = cart[item.id] ?? 0
                const img = menuImageUrl(item.imagePath)
                return (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between gap-2 py-2 ${item.available ? '' : 'opacity-40'}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {img ? (
                        <img src={img} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-parchment-deep text-ink-faint">
                          🍽
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {item.name}
                          {!item.available && <span className="ml-2 text-xs text-crimson">ของหมด</span>}
                        </div>
                        <div className="tabular text-xs text-gold-deep">฿{formatBaht(item.price)}</div>
                      </div>
                    </div>
                    <Stepper
                      qty={qty}
                      disabled={!item.available}
                      onChange={(n) => setCart((c) => ({ ...c, [item.id]: n }))}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/** ปุ่มเพิ่ม/ลดจำนวน — ใช้ทั้งฝั่งพนักงานและลูกค้า */
export function Stepper({
  qty,
  disabled,
  onChange,
  onAdd,
}: {
  qty: number
  disabled?: boolean
  onChange: (n: number) => void
  /** เรียกตอนกด + พร้อมตำแหน่งปุ่ม — ใช้ทำเหรียญลอย */
  onAdd?: (el: HTMLElement) => void
}) {
  return (
    <div
      className={`flex shrink-0 items-center rounded-full border transition ${
        qty > 0 ? 'border-gold bg-gold/10' : 'border-line-strong bg-vellum'
      }`}
    >
      {qty > 0 && (
        <>
          <button
            type="button"
            aria-label="ลด"
            onClick={() => onChange(Math.max(0, qty - 1))}
            className="grid h-8 w-8 place-items-center rounded-full text-lg text-ink-soft transition hover:bg-gold/20"
          >
            −
          </button>
          <span key={qty} className="tabular w-5 animate-bump text-center text-sm font-bold">
            {qty}
          </span>
        </>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          onAdd?.(e.currentTarget)
          onChange(qty + 1)
        }}
        className="grid h-8 w-8 place-items-center rounded-full text-lg text-gold-deep transition hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>
    </div>
  )
}
