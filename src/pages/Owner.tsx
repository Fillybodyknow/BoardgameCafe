import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminDb } from '../data'
import { SNAPSHOT_KEY } from '../hooks/useData'
import { formatBaht } from '../domain/pricing'
import type { MenuCategory, ShopHours, TaxConfig } from '../domain/types'
import { Badge, Button, Card, Empty, SectionTitle } from '../components/ui'

const CATEGORY_LABEL: Record<MenuCategory, string> = {
  drink: 'เครื่องดื่ม', snack: 'ของกินเล่น', food: 'อาหารจานหลัก', dessert: 'ของหวาน',
}

const WEEKDAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

type Tab = 'menu' | 'tables' | 'rates' | 'hours'

const TABS: { key: Tab; label: string }[] = [
  { key: 'menu', label: 'เมนู' },
  { key: 'tables', label: 'โต๊ะ' },
  { key: 'rates', label: 'เรตราคา' },
  { key: 'hours', label: 'เวลาทำการ' },
]

export default function Owner() {
  const [tab, setTab] = useState<Tab>('menu')
  const role = useQuery({ queryKey: ['admin', 'role'], queryFn: () => adminDb.myRole() })

  if (role.isPending) return <Empty>กำลังตรวจสิทธิ์…</Empty>

  if (role.data !== 'manager' && role.data !== 'owner') {
    return (
      <Empty>
        หน้านี้เปิดให้เฉพาะผู้จัดการและเจ้าของร้าน
        <br />
        <span className="text-xs">
          (ต่อให้เปิดหน้านี้ได้ ฐานข้อมูลก็ยังปฏิเสธการแก้ค่าอยู่ดี)
        </span>
      </Empty>
    )
  }

  return (
    <div className="space-y-4">
      <SectionTitle>ตั้งค่าร้าน</SectionTitle>

      <div className="flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? 'subtle' : 'ghost'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {tab === 'menu' && <MenuTab />}
      {tab === 'tables' && <TablesTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'hours' && <HoursTab />}
    </div>
  )
}

/** รวม error handling + refresh ไว้ที่เดียว ทุกแท็บใช้เหมือนกัน */
function useSave<T>(keys: string[], fn: (v: T) => Promise<void>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', ...keys] })
      // ผังโต๊ะ/เมนูฝั่งหน้าร้านต้องเห็นการเปลี่ยนแปลงทันที
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY })
    },
  })
}

function Err({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="mt-2 text-sm text-rose-400">
      {error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ'}
    </p>
  )
}

const input =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

// ================================================================== เมนู ====

const BLANK_MENU = {
  id: null as string | null,
  sku: '',
  name: '',
  category: 'drink' as MenuCategory,
  price: 0,
  available: true,
  sortOrder: 0,
}

function MenuTab() {
  const items = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => adminDb.allMenuItems() })
  const [draft, setDraft] = useState<typeof BLANK_MENU | null>(null)

  const save = useSave(['menu'], (v: typeof BLANK_MENU) => adminDb.saveMenuItem(v))
  const archive = useSave(['menu'], (v: { id: string; archived: boolean }) =>
    adminDb.archiveMenuItem(v.id, v.archived),
  )

  useEffect(() => {
    if (save.isSuccess) setDraft(null)
  }, [save.isSuccess])

  if (items.isPending) return <Empty>กำลังโหลด…</Empty>

  const active = (items.data ?? []).filter((m) => !m.archived)
  const archived = (items.data ?? []).filter((m) => m.archived)

  return (
    <div className="space-y-3">
      <Button variant="primary" onClick={() => setDraft({ ...BLANK_MENU, sortOrder: active.length + 1 })}>
        + เพิ่มเมนู
      </Button>

      <p className="text-xs text-slate-500">
        แก้ราคามีผลกับออเดอร์ใหม่เท่านั้น — ออเดอร์ที่สั่งไปแล้วและใบเสร็จเก่าใช้ราคา ณ ตอนสั่ง
      </p>

      {active.map((m) => (
        <Card key={m.id} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <Badge tone="slate">{m.sku}</Badge>
              {!m.available && <Badge tone="rose">ของหมด</Badge>}
            </div>
            <div className="tabular mt-0.5 text-sm text-slate-400">
              {CATEGORY_LABEL[m.category]} · ฿{formatBaht(m.price)}
            </div>
          </div>
          <div className="flex gap-1">
            <Button
              onClick={() =>
                setDraft({
                  id: m.id, sku: m.sku, name: m.name, category: m.category,
                  price: m.price, available: m.available, sortOrder: m.sortOrder ?? 0,
                })
              }
            >
              แก้ไข
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(`เก็บ "${m.name}" เข้ากรุ? จะไม่แสดงในเมนูอีก แต่ใบเสร็จเก่ายังอ่านได้`)) {
                  archive.mutate({ id: m.id, archived: true })
                }
              }}
            >
              เก็บเข้ากรุ
            </Button>
          </div>
        </Card>
      ))}

      <Err error={archive.error} />

      {archived.length > 0 && (
        <details className="rounded-xl border border-slate-800 p-3">
          <summary className="cursor-pointer text-sm text-slate-400">
            เก็บเข้ากรุแล้ว ({archived.length})
          </summary>
          <div className="mt-2 space-y-1">
            {archived.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-500">{m.name}</span>
                <Button onClick={() => archive.mutate({ id: m.id, archived: false })}>
                  เอากลับมา
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}

      {draft && (
        <Dialog title={draft.id ? 'แก้ไขเมนู' : 'เพิ่มเมนู'} onClose={() => setDraft(null)}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="รหัส">
              <input
                value={draft.sku}
                onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
                placeholder="D05"
                className={input}
              />
            </Field>
            <Field label="หมวด">
              <select
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value as MenuCategory })}
                className={input}
              >
                {(Object.keys(CATEGORY_LABEL) as MenuCategory[]).map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="ชื่อเมนู">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={input}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="ราคา (บาท)">
              <input
                type="number"
                min={0}
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: Number(e.target.value) })}
                className={input}
              />
            </Field>
            <Field label="ลำดับแสดง">
              <input
                type="number"
                value={draft.sortOrder}
                onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
                className={input}
              />
            </Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.available}
              onChange={(e) => setDraft({ ...draft, available: e.target.checked })}
              className="accent-emerald-500"
            />
            มีขายอยู่ (ติ๊กออกถ้าของหมดวันนี้)
          </label>

          <Err error={save.error} />
          <DialogActions
            busy={save.isPending}
            onCancel={() => setDraft(null)}
            onSave={() => save.mutate(draft)}
          />
        </Dialog>
      )}
    </div>
  )
}

// ================================================================== โต๊ะ ====

const BLANK_TABLE = {
  id: null as string | null,
  code: '',
  zone: '',
  seatMin: 2,
  seatMax: 4,
  allowShare: false,
  sortOrder: 0,
}

function TablesTab() {
  const tables = useQuery({ queryKey: ['admin', 'tables'], queryFn: () => adminDb.allTables() })
  const [draft, setDraft] = useState<typeof BLANK_TABLE | null>(null)

  const save = useSave(['tables'], (v: typeof BLANK_TABLE) => adminDb.saveTable(v))
  const archive = useSave(['tables'], (v: { id: string; archived: boolean }) =>
    adminDb.archiveTable(v.id, v.archived),
  )

  useEffect(() => {
    if (save.isSuccess) setDraft(null)
  }, [save.isSuccess])

  if (tables.isPending) return <Empty>กำลังโหลด…</Empty>

  const active = (tables.data ?? []).filter((t) => !t.archived)
  const archived = (tables.data ?? []).filter((t) => t.archived)

  return (
    <div className="space-y-3">
      <Button variant="primary" onClick={() => setDraft({ ...BLANK_TABLE, sortOrder: active.length + 1 })}>
        + เพิ่มโต๊ะ
      </Button>

      {active.map((t) => (
        <Card key={t.id} className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold">{t.code}</span>
              <Badge tone="slate">{t.zone}</Badge>
              {t.allowShare && <Badge tone="violet">นั่งร่วมได้</Badge>}
              {t.status === 'occupied' && <Badge tone="emerald">มีลูกค้า</Badge>}
            </div>
            <div className="mt-0.5 text-sm text-slate-400">
              {t.seatMin}–{t.seatMax} ที่นั่ง
            </div>
          </div>
          <div className="flex gap-1">
            <Button
              onClick={() =>
                setDraft({
                  id: t.id, code: t.code, zone: t.zone,
                  seatMin: t.seatMin, seatMax: t.seatMax,
                  allowShare: t.allowShare, sortOrder: t.sortOrder ?? 0,
                })
              }
            >
              แก้ไข
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(`เก็บโต๊ะ ${t.code} เข้ากรุ?`)) {
                  archive.mutate({ id: t.id, archived: true })
                }
              }}
            >
              เก็บเข้ากรุ
            </Button>
          </div>
        </Card>
      ))}

      <Err error={archive.error} />

      {archived.length > 0 && (
        <details className="rounded-xl border border-slate-800 p-3">
          <summary className="cursor-pointer text-sm text-slate-400">
            เก็บเข้ากรุแล้ว ({archived.length})
          </summary>
          <div className="mt-2 space-y-1">
            {archived.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-500">{t.code} · {t.zone}</span>
                <Button onClick={() => archive.mutate({ id: t.id, archived: false })}>
                  เอากลับมา
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}

      {draft && (
        <Dialog title={draft.id ? `แก้ไขโต๊ะ ${draft.code}` : 'เพิ่มโต๊ะ'} onClose={() => setDraft(null)}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="รหัสโต๊ะ">
              <input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="A4"
                className={input}
              />
            </Field>
            <Field label="โซน">
              <input
                value={draft.zone}
                onChange={(e) => setDraft({ ...draft, zone: e.target.value })}
                placeholder="โซนเงียบ"
                className={input}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="ที่นั่งต่ำสุด">
              <input
                type="number"
                min={1}
                value={draft.seatMin}
                onChange={(e) => setDraft({ ...draft, seatMin: Number(e.target.value) })}
                className={input}
              />
            </Field>
            <Field label="ที่นั่งสูงสุด">
              <input
                type="number"
                min={1}
                value={draft.seatMax}
                onChange={(e) => setDraft({ ...draft, seatMax: Number(e.target.value) })}
                className={input}
              />
            </Field>
            <Field label="ลำดับ">
              <input
                type="number"
                value={draft.sortOrder}
                onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
                className={input}
              />
            </Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowShare}
              onChange={(e) => setDraft({ ...draft, allowShare: e.target.checked })}
              className="accent-emerald-500"
            />
            ให้คนละกลุ่มนั่งร่วมกันได้ (โต๊ะยาว / เคาน์เตอร์)
          </label>

          <Err error={save.error} />
          <DialogActions
            busy={save.isPending}
            onCancel={() => setDraft(null)}
            onSave={() => save.mutate(draft)}
          />
        </Dialog>
      )}
    </div>
  )
}

// ============================================================== เรตราคา ====

const BLANK_RATE = {
  id: null as string | null,
  name: '',
  pricePerHour: 60,
  roundToMinutes: 30,
  minimumMinutes: 60,
  dayPassCap: null as number | null,
  active: true,
  sortOrder: 0,
}

function RatesTab() {
  const plans = useQuery({ queryKey: ['admin', 'rates'], queryFn: () => adminDb.allRatePlans() })
  const [draft, setDraft] = useState<typeof BLANK_RATE | null>(null)

  const save = useSave(['rates'], (v: typeof BLANK_RATE) => adminDb.saveRatePlan(v))

  useEffect(() => {
    if (save.isSuccess) setDraft(null)
  }, [save.isSuccess])

  if (plans.isPending) return <Empty>กำลังโหลด…</Empty>

  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        onClick={() => setDraft({ ...BLANK_RATE, sortOrder: (plans.data?.length ?? 0) + 1 })}
      >
        + เพิ่มเรตราคา
      </Button>

      <Card className="text-xs text-slate-400">
        ขึ้นราคาแล้ว <b className="text-slate-200">ไม่กระทบลูกค้าที่กำลังนั่งอยู่</b> —
        แต่ละคนถือเรต ณ เวลาที่เช็คอินติดตัวไว้แล้ว ราคาใหม่ใช้กับคนที่เช็คอินหลังจากนี้เท่านั้น
      </Card>

      {(plans.data ?? []).map((p) => (
        <Card key={p.id} className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{p.name}</span>
              {p.active === false && <Badge tone="slate">ปิดใช้</Badge>}
            </div>
            <div className="tabular mt-0.5 text-sm text-slate-400">
              ฿{formatBaht(p.pricePerHour)}/ชม. · ปัดทุก {p.roundToMinutes} นาที · ขั้นต่ำ{' '}
              {p.minimumMinutes} นาที
              {p.dayPassCap !== null && <> · เหมาวัน ฿{formatBaht(p.dayPassCap)}</>}
            </div>
          </div>
          <Button
            onClick={() =>
              setDraft({
                id: p.id, name: p.name, pricePerHour: p.pricePerHour,
                roundToMinutes: p.roundToMinutes, minimumMinutes: p.minimumMinutes,
                dayPassCap: p.dayPassCap, active: p.active ?? true,
                sortOrder: p.sortOrder ?? 0,
              })
            }
          >
            แก้ไข
          </Button>
        </Card>
      ))}

      {draft && (
        <Dialog title={draft.id ? 'แก้ไขเรตราคา' : 'เพิ่มเรตราคา'} onClose={() => setDraft(null)}>
          <Field label="ชื่อเรต">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="เช่น สมาชิก, นักเรียน"
              className={input}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="บาท/ชั่วโมง">
              <input
                type="number"
                min={0}
                value={draft.pricePerHour}
                onChange={(e) => setDraft({ ...draft, pricePerHour: Number(e.target.value) })}
                className={input}
              />
            </Field>
            <Field label="ปัดขึ้นทุกกี่นาที">
              <select
                value={draft.roundToMinutes}
                onChange={(e) => setDraft({ ...draft, roundToMinutes: Number(e.target.value) })}
                className={input}
              >
                {[10, 15, 30, 60].map((n) => (
                  <option key={n} value={n}>{n} นาที</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="คิดขั้นต่ำ (นาที)">
              <input
                type="number"
                min={0}
                value={draft.minimumMinutes}
                onChange={(e) => setDraft({ ...draft, minimumMinutes: Number(e.target.value) })}
                className={input}
              />
            </Field>
            <Field label="เพดานเหมาวัน (ว่าง = ไม่มี)">
              <input
                type="number"
                min={0}
                value={draft.dayPassCap ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    dayPassCap: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
                placeholder="199"
                className={input}
              />
            </Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
              className="accent-emerald-500"
            />
            เปิดให้เลือกตอนเปิดโต๊ะ
          </label>

          <Err error={save.error} />
          <DialogActions
            busy={save.isPending}
            onCancel={() => setDraft(null)}
            onSave={() => save.mutate(draft)}
          />
        </Dialog>
      )}
    </div>
  )
}

// =========================================================== เวลาทำการ ====

function HoursTab() {
  const hours = useQuery({ queryKey: ['admin', 'hours'], queryFn: () => adminDb.shopHours() })
  const tax = useQuery({ queryKey: ['admin', 'tax'], queryFn: () => adminDb.taxConfig() })

  const saveHours = useSave(['hours'], (v: ShopHours) => adminDb.saveShopHours(v))
  const saveTax = useSave(['tax'], (v: TaxConfig) => adminDb.saveTaxConfig(v))

  const [draftTax, setDraftTax] = useState<TaxConfig | null>(null)
  useEffect(() => {
    if (tax.data && !draftTax) setDraftTax(tax.data)
  }, [tax.data, draftTax])

  if (hours.isPending) return <Empty>กำลังโหลด…</Empty>

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {(hours.data ?? []).map((h) => (
          <Card key={h.weekday} className="flex flex-wrap items-center gap-3">
            <span className="w-20 shrink-0 font-semibold">{WEEKDAY[h.weekday]}</span>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={h.closed}
                onChange={(e) => saveHours.mutate({ ...h, closed: e.target.checked })}
                className="accent-rose-500"
              />
              ปิด
            </label>

            {!h.closed && (
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={h.openTime}
                  onChange={(e) => saveHours.mutate({ ...h, openTime: e.target.value })}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm outline-none"
                />
                <span className="text-slate-500">–</span>
                <input
                  type="time"
                  value={h.closeTime}
                  onChange={(e) => saveHours.mutate({ ...h, closeTime: e.target.value })}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm outline-none"
                />
              </div>
            )}
          </Card>
        ))}
        <Err error={saveHours.error} />
        <p className="text-xs text-slate-500">
          ยังไม่รองรับร้านที่ปิดหลังเที่ยงคืน เพราะระบบจองยังไม่อนุญาตให้รอบเล่นข้ามวัน
        </p>
      </div>

      {draftTax && (
        <>
          <SectionTitle>ภาษีและค่าบริการ</SectionTitle>
          <Card className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="VAT (%)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={draftTax.vatRate * 100}
                  onChange={(e) =>
                    setDraftTax({ ...draftTax, vatRate: Number(e.target.value) / 100 })
                  }
                  className={input}
                />
              </Field>
              <Field label="ค่าบริการ (%)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={draftTax.serviceChargeRate * 100}
                  onChange={(e) =>
                    setDraftTax({ ...draftTax, serviceChargeRate: Number(e.target.value) / 100 })
                  }
                  className={input}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draftTax.vatIncluded}
                onChange={(e) => setDraftTax({ ...draftTax, vatIncluded: e.target.checked })}
                className="accent-emerald-500"
              />
              ราคาที่ตั้งไว้รวม VAT แล้ว
            </label>
            <Err error={saveTax.error} />
            <Button
              variant="primary"
              className="w-full"
              disabled={saveTax.isPending}
              onClick={() => saveTax.mutate(draftTax)}
            >
              {saveTax.isPending ? 'กำลังบันทึก…' : 'บันทึกภาษีและค่าบริการ'}
            </Button>
          </Card>
        </>
      )}
    </div>
  )
}

// ================================================================ ส่วนกลาง ====

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-slate-800 bg-slate-900 p-5 sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold">{title}</h3>
          <Button onClick={onClose}>✕</Button>
        </div>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  )
}

function DialogActions({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="mt-5 flex gap-2">
      <Button className="flex-1" onClick={onCancel} disabled={busy}>
        ยกเลิก
      </Button>
      <Button className="flex-1" variant="primary" onClick={onSave} disabled={busy}>
        {busy ? 'กำลังบันทึก…' : 'บันทึก'}
      </Button>
    </div>
  )
}
