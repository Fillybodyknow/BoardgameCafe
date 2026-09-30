import { useMemo, useState } from 'react'
import { useSnapshot } from '../hooks/useData'
import { db } from '../data'
import { formatBaht } from '../domain/pricing'
import type { GuestPass, MenuItem } from '../domain/types'
import { Button } from '../components/ui'

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-2xl border border-slate-800 bg-slate-900 sm:rounded-2xl">
        <div className="border-b border-slate-800 p-5">
          <h3 className="text-lg font-bold">รับออเดอร์</h3>

          <div className="mt-3 flex gap-1">
            <Button
              variant={splitMode === 'owner' ? 'subtle' : 'ghost'}
              onClick={() => setSplitMode('owner')}
            >
              ลงชื่อคนสั่ง
            </Button>
            <Button
              variant={splitMode === 'shared' ? 'subtle' : 'ghost'}
              onClick={() => setSplitMode('shared')}
            >
              แชร์ทั้งโต๊ะ
            </Button>
          </div>

          {splitMode === 'owner' && (
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            >
              {activePasses.map((pass) => (
                <option key={pass.id} value={pass.id}>
                  {pass.displayName}
                </option>
              ))}
            </select>
          )}
          {splitMode === 'shared' && (
            <p className="mt-2 text-xs text-slate-500">
              ตอนแยกบิลจะหารเท่ากันในกลุ่ม {activePasses.length} คน
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {groups.map(([category, items]) => (
            <div key={category}>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {CATEGORY_LABEL[category]}
              </h4>
              <div className="space-y-1">
                {items.map((item) => {
                  const qty = cart[item.id] ?? 0
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 ${
                        item.available ? '' : 'opacity-40'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm">
                          {item.name}
                          {!item.available && <span className="ml-2 text-xs text-rose-400">ของหมด</span>}
                        </div>
                        <div className="tabular text-xs text-slate-500">฿{formatBaht(item.price)}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          disabled={qty === 0}
                          onClick={() => setCart((c) => ({ ...c, [item.id]: Math.max(0, qty - 1) }))}
                        >
                          −
                        </Button>
                        <span className="tabular w-6 text-center text-sm">{qty || ''}</span>
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

        <div className="border-t border-slate-800 p-5">
          {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
          <div className="mb-3 flex justify-between text-sm">
            <span className="text-slate-400">{count} รายการ</span>
            <span className="tabular font-bold">฿{formatBaht(total)}</span>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose}>ยกเลิก</Button>
            <Button
              className="flex-1"
              variant="primary"
              disabled={count === 0 || busy || (splitMode === 'owner' && !ownerId)}
              onClick={submit}
            >
              ส่งเข้าครัว
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
