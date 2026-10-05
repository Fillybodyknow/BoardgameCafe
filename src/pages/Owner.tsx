import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminDb, menuImageUrl } from '../data'
import { formatBytes, resizeToJpeg } from '../lib/image'
import StaffTab from './StaffTab'
import BrandTab from './BrandTab'
import { SNAPSHOT_KEY } from '../hooks/useData'
import { formatBaht } from '../domain/pricing'
import type { MenuCategory, ShopHours, TaxConfig } from '../domain/types'
import {
  Badge, Button, Card, Empty, Field, INPUT, Modal, PageHeader, SectionTitle, Segmented,
} from '../components/ui'

const CATEGORY_LABEL: Record<MenuCategory, string> = {
  drink: 'เครื่องดื่ม', snack: 'ของกินเล่น', food: 'อาหารจานหลัก', dessert: 'ของหวาน',
}

const WEEKDAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

type Tab = 'menu' | 'tables' | 'rates' | 'hours' | 'staff' | 'brand'

const TABS: { key: Tab; label: string }[] = [
  { key: 'menu', label: 'เมนู' },
  { key: 'tables', label: 'โต๊ะ' },
  { key: 'rates', label: 'เรตราคา' },
  { key: 'hours', label: 'เวลาทำการ' },
  { key: 'staff', label: 'พนักงาน' },
  { key: 'brand', label: 'ชื่อร้าน & โลโก้' },
]

export default function Owner() {
  const [tab, setTab] = useState<Tab>('menu')
  const role = useQuery({ queryKey: ['admin', 'role'], queryFn: () => adminDb.myRole() })
  const caps = useQuery({
    queryKey: ['admin', 'capabilities'],
    queryFn: () => adminDb.myCapabilities(),
  })

  if (role.isPending || caps.isPending) return <Empty>กำลังตรวจสิทธิ์…</Empty>

  if (!caps.data?.includes('settings')) {
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
    <div>
      <PageHeader
        eyebrow="ห้องบัญชาการของเจ้าของร้าน"
        title="ตั้งค่าร้าน"
        subtitle="เมนู โต๊ะ เรตราคา และเวลาทำการ — แก้แล้วหน้าร้านเห็นทันที"
      />

      <div className="-mx-4 mb-6 overflow-x-auto px-4">
        <Segmented
          value={tab}
          onChange={setTab}
          options={TABS
            // จัดการบัญชีเป็นสิทธิ์แยกจากการตั้งค่าร้าน
            .filter((t) => t.key !== 'staff' || caps.data?.includes('accounts'))
            // ชื่อและโลโก้เฉพาะเจ้าของร้าน ผู้จัดการไม่เห็นแท็บนี้
            .filter((t) => t.key !== 'brand' || caps.data?.includes('branding'))
            .map((t) => ({ value: t.key, label: t.label }))}
          className="min-w-full sm:min-w-0"
        />
      </div>

      <div key={tab} className="animate-page">
      {tab === 'menu' && <MenuTab />}
      {tab === 'tables' && <TablesTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'hours' && <HoursTab />}
      {tab === 'brand' && caps.data?.includes('branding') && <BrandTab />}
      {tab === 'staff' && caps.data?.includes('accounts') && (
        <StaffTab myRole={role.data ?? 'staff'} />
      )}
      </div>
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

/**
 * ช่องกรอกเวลาที่บันทึกตอนออกจากช่อง ไม่ใช่ทุกครั้งที่ค่าเปลี่ยน
 *
 * <input type="time"> คืนค่าว่างระหว่างที่ยังกรอกไม่ครบ ถ้าบันทึกทุกครั้งที่
 * ค่าเปลี่ยน ตัวเลขที่พิมพ์ค้างไว้จะถูกเขียนทับด้วยค่าที่โหลดกลับมาจาก
 * เซิร์ฟเวอร์ แล้วกรอกให้ครบไม่ได้เลย — เกิดกับช่องเวลาปิดครัวซึ่งเว้นว่างได้
 * จึงวนเป็นค่าว่างตลอด
 */
function TimeField({
  value,
  onCommit,
  className = '',
  'aria-label': label,
}: {
  value: string | null
  /** null = เว้นว่าง */
  onCommit: (v: string | null) => void
  className?: string
  'aria-label'?: string
}) {
  const [draft, setDraft] = useState(value ?? '')
  const [editing, setEditing] = useState(false)

  // ค่าจากเซิร์ฟเวอร์เปลี่ยนตอนที่ไม่ได้แก้อยู่ → ตามค่านั้น
  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  return (
    <input
      type="time"
      aria-label={label}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        const next = draft || null
        if (next !== (value ?? null)) onCommit(next)
      }}
      className={className}
    />
  )
}

function Err({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p className="mt-2 animate-shake text-sm text-crimson">
      {error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ'}
    </p>
  )
}

const input = INPUT

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

      <p className="text-xs text-ink-faint">
        แก้ราคามีผลกับออเดอร์ใหม่เท่านั้น — ออเดอร์ที่สั่งไปแล้วและใบเสร็จเก่าใช้ราคา ณ ตอนสั่ง
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
      {active.map((m) => (
        <Card key={m.id} className="lift flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <Thumb path={m.imagePath} alt={m.name} />
            <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <Badge tone="neutral">{m.sku}</Badge>
              {!m.available && <Badge tone="crimson">ของหมด</Badge>}
            </div>
            <div className="tabular mt-0.5 text-sm text-ink-soft">
              {CATEGORY_LABEL[m.category]} · ฿{formatBaht(m.price)}
            </div>
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
      </div>

      <Err error={archive.error} />

      {archived.length > 0 && (
        <details className="panel rounded-xl p-3">
          <summary className="cursor-pointer text-sm text-ink-soft">
            🗝 เก็บเข้ากรุแล้ว ({archived.length})
          </summary>
          <div className="mt-2 space-y-1">
            {archived.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-faint">{m.name}</span>
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
              className="h-4 w-4 accent-[#3d6b46]"
            />
            มีขายอยู่ (ติ๊กออกถ้าของหมดวันนี้)
          </label>

          {draft.id ? (
            <ImageField
              itemId={draft.id}
              path={(items.data ?? []).find((m) => m.id === draft.id)?.imagePath ?? null}
            />
          ) : (
            <p className="mt-3 rounded-lg bg-parchment-deep/70 p-2 text-xs text-ink-soft">
              บันทึกเมนูก่อน แล้วเปิดกลับมาแก้เพื่อใส่รูป
            </p>
          )}

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

/** รูปย่อในรายการ — โหลดแบบ lazy เพื่อไม่ให้ดึงรูปทุกใบพร้อมกัน */
function Thumb({ path, alt }: { path?: string | null; alt: string }) {
  const url = menuImageUrl(path)
  if (!url) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-parchment-deep text-ink-faint">
        🍽
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="h-12 w-12 shrink-0 rounded-lg object-cover"
    />
  )
}

/**
 * อัปโหลดรูปเมนู
 *
 * ย่อรูปในเบราว์เซอร์ก่อนส่งเสมอ รูปจากมือถือใบละหลายเมกะไบต์ ถ้าส่งดิบ ๆ
 * ลูกค้าที่เปิดเมนูจะโหลดหนักและกินโควตา egress เร็วมาก
 */
function ImageField({ itemId, path }: { itemId: string; path: string | null }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const resized = await resizeToJpeg(file)
      await adminDb.uploadMenuImage(itemId, resized)
      setInfo(`ย่อจาก ${formatBytes(file.size)} เหลือ ${formatBytes(resized.blob.size)}`)
      void qc.invalidateQueries({ queryKey: ['admin', 'menu'] })
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อัปโหลดไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await adminDb.removeMenuImage(itemId)
      void qc.invalidateQueries({ queryKey: ['admin', 'menu'] })
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบรูปไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const url = menuImageUrl(path)

  return (
    <div className="mt-3 rounded-lg border border-dashed border-line-strong bg-parchment/50 p-3">
      <div className="text-xs font-medium text-ink-soft">รูปประกอบ</div>
      <div className="mt-2 flex items-center gap-3">
        {url ? (
          <img src={url} alt="" className="h-20 w-20 rounded-lg object-cover" />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-parchment-deep text-2xl text-ink-faint">
            🍽
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(e) => void pick(e.target.files?.[0])}
            className="block w-full text-xs text-ink-faint file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-vellum file:px-3 file:py-1.5 file:text-ink hover:file:border-gold"
          />
          {url && (
            <Button variant="danger" disabled={busy} onClick={remove}>
              ลบรูป
            </Button>
          )}
        </div>
      </div>
      {busy && <p className="mt-2 text-xs text-ink-faint">กำลังย่อและอัปโหลด…</p>}
      {info && <p className="mt-2 text-xs text-forest-deep">✓ {info}</p>}
      {error && <p className="mt-2 animate-shake text-sm text-crimson">{error}</p>}
      <p className="mt-2 text-xs text-ink-faint">
        ย่อให้เหลือกว้างสุด 800px อัตโนมัติ — ถ่ายจากมือถือได้เลย
      </p>
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

      <div className="grid gap-3 lg:grid-cols-2">
      {active.map((t) => (
        <Card key={t.id} className="lift flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg tracking-wide font-bold">{t.code}</span>
              <Badge tone="neutral">{t.zone}</Badge>
              {t.allowShare && <Badge tone="royal">นั่งร่วมได้</Badge>}
              {t.status === 'occupied' && <Badge tone="forest">มีลูกค้า</Badge>}
            </div>
            <div className="mt-0.5 text-sm text-ink-soft">
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
      </div>

      <Err error={archive.error} />

      {archived.length > 0 && (
        <details className="panel rounded-xl p-3">
          <summary className="cursor-pointer text-sm text-ink-soft">
            🗝 เก็บเข้ากรุแล้ว ({archived.length})
          </summary>
          <div className="mt-2 space-y-1">
            {archived.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-faint">{t.code} · {t.zone}</span>
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
              className="h-4 w-4 accent-[#3d6b46]"
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

      <Card className="!border-lapis/30 !bg-lapis/5 text-xs text-lapis-deep">
        ขึ้นราคาแล้ว <b className="text-ink">ไม่กระทบลูกค้าที่กำลังนั่งอยู่</b> —
        แต่ละคนถือเรต ณ เวลาที่เช็คอินติดตัวไว้แล้ว ราคาใหม่ใช้กับคนที่เช็คอินหลังจากนี้เท่านั้น
      </Card>

      {(plans.data ?? []).map((p) => (
        <Card key={p.id} className="lift flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{p.name}</span>
              {p.active === false && <Badge tone="neutral">ปิดใช้</Badge>}
            </div>
            <div className="tabular mt-0.5 text-sm text-ink-soft">
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
              className="h-4 w-4 accent-[#3d6b46]"
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
          <Card key={h.weekday} className={`flex flex-wrap items-center gap-3 !py-3 ${h.closed ? 'opacity-60' : ''}`}>
            <span className="w-24 shrink-0 font-display font-semibold">{WEEKDAY[h.weekday]}</span>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={h.closed}
                onChange={(e) => saveHours.mutate({ ...h, closed: e.target.checked })}
                className="h-4 w-4 accent-[#a02c2d]"
              />
              ปิด
            </label>

            {!h.closed && (
              <div className="flex items-center gap-2">
                <TimeField
                  aria-label={`เวลาเปิด ${WEEKDAY[h.weekday]}`}
                  value={h.openTime}
                  onCommit={(v) => v && saveHours.mutate({ ...h, openTime: v })}
                  className={`${INPUT} !w-auto !py-1`}
                />
                <span className="text-ink-faint">–</span>
                <TimeField
                  aria-label={`เวลาปิด ${WEEKDAY[h.weekday]}`}
                  value={h.closeTime}
                  onCommit={(v) => v && saveHours.mutate({ ...h, closeTime: v })}
                  className={`${INPUT} !w-auto !py-1`}
                />
              </div>
            )}

            {!h.closed && (
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                ครัวปิด
                <TimeField
                  aria-label={`เวลาปิดครัว ${WEEKDAY[h.weekday]}`}
                  value={h.kitchenCloseTime}
                  onCommit={(v) => saveHours.mutate({ ...h, kitchenCloseTime: v })}
                  className={`${INPUT} !w-auto !py-1`}
                />
                {h.kitchenCloseTime === null && (
                  <span className="text-xs text-ink-faint">(ปิดพร้อมร้าน)</span>
                )}
              </label>
            )}
          </Card>
        ))}
        <Err error={saveHours.error} />
        <p className="text-xs text-ink-faint">
          เวลาปิดครัวว่างไว้ = ครัวปิดพร้อมร้าน · หลังครัวปิด ลูกค้าสั่งได้เฉพาะเครื่องดื่ม
          และของกินเล่น ส่วนพนักงานสั่งแทนได้ถ้ายืนยัน
        </p>
        <p className="text-xs text-ink-faint">
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
                className="h-4 w-4 accent-[#3d6b46]"
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
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">{children}</div>
    </Modal>
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
