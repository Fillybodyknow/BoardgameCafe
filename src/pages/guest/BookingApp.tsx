import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { bookingDb } from '../../data'
import type { AvailableTable, BookingLookup, BookingReceipt, ShopHours } from '../../domain/types'
import { Badge, Button, Card, Empty, Field, INPUT, Segmented } from '../../components/ui'
import type { Tone } from '../../components/ui'
import ShopLogo, { ShopName } from '../../components/ShopLogo'
import {
  forgetBooking,
  myBookings,
  rememberBooking,
  type RememberedBooking,
} from '../../lib/myBookings'

const STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  pending: { label: 'รอร้านยืนยัน', tone: 'ember', hint: 'ร้านจะติดต่อกลับเพื่อยืนยัน' },
  confirmed: { label: 'ยืนยันแล้ว', tone: 'forest', hint: 'แล้วเจอกันที่ร้านนะครับ' },
  seated: { label: 'เช็คอินแล้ว', tone: 'lapis', hint: 'กำลังใช้บริการอยู่' },
  cancelled: { label: 'ยกเลิกแล้ว', tone: 'neutral', hint: '' },
  no_show: { label: 'ไม่ได้มาตามนัด', tone: 'crimson', hint: '' },
}

/** แสดงวันให้กดเลือกล่วงหน้ากี่วัน — ไกลกว่านี้ใช้ช่องเลือกวันที่ */
const QUICK_DAYS = 14

/** แปลงเวลาไทยเป็น ISO โดยไม่พึ่ง timezone ของเครื่องลูกค้า (+07:00 ตายตัว) */
function bangkokToISO(date: string, time: string): string {
  return new Date(`${date}T${time}:00+07:00`).toISOString()
}

/** วันนี้ตามเวลาไทย ในรูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
}

/** เลื่อนวันแบบ YYYY-MM-DD ไป n วัน */
function addDays(date: string, n: number): string {
  return new Date(new Date(`${date}T12:00:00+07:00`).getTime() + n * 86_400_000 + 7 * 3600_000)
    .toISOString()
    .slice(0, 10)
}

/** 0 = อาทิตย์ ตรงกับ shop_hours ฝั่งฐานข้อมูล */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00+07:00`).getUTCDay()
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  })
}

export default function BookingApp() {
  const [params, setParams] = useSearchParams()
  const mode = params.get('m') === 'find' ? 'find' : 'book'

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="tapestry pennant px-5 pt-6 pb-12 text-center">
        <ShopLogo className="mx-auto h-14 w-14" seal="text-xl" />
        <div className="brand mt-2 text-xs">
          <ShopName />
        </div>
        <h1 className="brand mt-1 text-2xl">⚜ จองโต๊ะ</h1>
        <ShopHoursLine />
      </header>

      <div className="sticky top-0 z-30 -mt-5 px-4 pb-3">
        <Segmented
          className="w-full shadow-lg"
          value={mode}
          onChange={(m) => setParams(m === 'find' ? { m: 'find' } : {})}
          options={[
            { value: 'book', label: 'จองใหม่' },
            { value: 'find', label: 'ดูรายการที่จองไว้' },
          ]}
        />
      </div>

      <main key={mode} className="flex-1 animate-page px-4 pb-10">
        {mode === 'book' ? <BookForm /> : <FindBooking />}
      </main>
    </div>
  )
}

/** เวลาทำการจริงจากฐานข้อมูล — เจ้าของร้านแก้ได้ จึงห้าม hardcode */
function ShopHoursLine() {
  const hours = useQuery({ queryKey: ['booking', 'hours'], queryFn: () => bookingDb.hours() })
  if (!hours.data?.length) return null

  const open = hours.data.filter((h) => !h.closed)
  const same =
    open.length === 7 &&
    open.every((h) => h.openTime === open[0]!.openTime && h.closeTime === open[0]!.closeTime)

  return (
    <p className="mt-1 text-xs text-[#f3e6c8]/70">
      {same
        ? `เปิด ${open[0]!.openTime} – ${open[0]!.closeTime} ทุกวัน`
        : 'เวลาทำการต่างกันในแต่ละวัน — เลือกวันแล้วดูช่วงเวลาที่จองได้'}
    </p>
  )
}

/** หัวข้อแต่ละขั้นของฟอร์ม — เลขโรมันในตรา */
function Step({
  n,
  title,
  aside,
  children,
}: {
  n: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3">
        <span className="wax-seal h-8 w-8 shrink-0 text-xs">{n}</span>
        <h2 className="flex-1 font-display text-base font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function BookForm() {
  const cfg = useQuery({ queryKey: ['booking', 'config'], queryFn: () => bookingDb.config() })
  const hours = useQuery({ queryKey: ['booking', 'hours'], queryFn: () => bookingDb.hours() })

  const [date, setDate] = useState(todayBangkok)
  const [time, setTime] = useState('18:00')
  const [party, setParty] = useState(2)
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<BookingReceipt | null>(null)

  const startAt = useMemo(() => bangkokToISO(date, time), [date, time])

  // ใช้รอบเล่นมาตรฐานของร้าน ไม่ให้ลูกค้าเลือกเอง — ร้านคุมความยาวรอบ
  // ได้จากหน้าตั้งค่า และหน้าจองก็สั้นลงหนึ่งช่อง
  const duration = cfg.data?.defaultDurationMinutes ?? 120

  const tables = useQuery({
    queryKey: ['booking', 'tables', startAt, duration],
    queryFn: () => bookingDb.availableTables(startAt, duration),
  })

  // เปลี่ยนเวลาแล้วโต๊ะที่เลือกไว้อาจไม่ว่างแล้ว — ล้างทิ้งกันเลือกค้าง
  useEffect(() => {
    setPicked([])
  }, [startAt, duration])

  const maxDate = useMemo(() => {
    const days = cfg.data?.maxAdvanceDays ?? 30
    return new Date(Date.now() + (days * 24 + 7) * 3600_000).toISOString().slice(0, 10)
  }, [cfg.data])

  /** วันที่ให้กดเลือกเร็ว ๆ — ไม่เกินเพดานจองล่วงหน้าของร้าน */
  const quickDays = useMemo(() => {
    const out: string[] = []
    const first = todayBangkok()
    for (let i = 0; i < QUICK_DAYS; i++) {
      const d = addDays(first, i)
      if (d > maxDate) break
      out.push(d)
    }
    return out
  }, [maxDate])

  const hoursOf = (d: string): ShopHours | undefined =>
    hours.data?.find((h) => h.weekday === weekdayOf(d))

  /** เวลาทำการของวันที่เลือก */
  const today = useMemo(() => hoursOf(date), [hours.data, date])

  /** ทุกรอบในเวลาทำการของวันที่เลือก */
  const allSlots = useMemo(() => {
    if (!today || today.closed) return []
    const step = cfg.data?.slotMinutes ?? 30
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
    const out: string[] = []
    // ต้องเล่นจบก่อนร้านปิด เหมือนกติกา assert_bookable ฝั่งเซิร์ฟเวอร์
    for (let m = toMin(today.openTime); m + duration <= toMin(today.closeTime); m += step) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
    }
    return out
  }, [cfg.data, duration, today])

  // ตัดรอบที่ใกล้เกินกว่าจะจองได้ทิ้ง — เดิมลูกค้าที่เปิดตอนค่ำยังเห็นรอบเช้าของวันนี้
  // กดเลือกได้ แล้วไปโดนเซิร์ฟเวอร์ปฏิเสธตอนส่ง
  const leadMinutes = cfg.data?.minAdvanceMinutes ?? 30
  const slots = useMemo(() => {
    const earliest = Date.now() + leadMinutes * 60_000
    return allSlots.filter((s) => new Date(bangkokToISO(date, s)).getTime() >= earliest)
  }, [allSlots, date, leadMinutes])

  // เปลี่ยนวันแล้วเวลาที่เลือกไว้อาจอยู่นอกเวลาทำการของวันใหม่
  useEffect(() => {
    if (slots.length > 0 && !slots.includes(time)) setTime(slots[0]!)
  }, [slots, time])

  const seats = (tables.data ?? [])
    .filter((t) => picked.includes(t.id))
    .reduce((n, t) => n + t.seatMax, 0)

  if (receipt) return <Receipt receipt={receipt} />

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const made = await bookingDb.create({
        customerName: name,
        phone,
        partySize: party,
        startAt,
        durationMinutes: duration,
        tableIds: picked,
        note: note || undefined,
      })
      // จำไว้บนเครื่องนี้ จะได้ไม่ต้องกรอกรหัสตอนกลับมาดู
      rememberBooking({ code: made.code, phone, startAt: made.startAt })
      setReceipt(made)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'จองไม่สำเร็จ')
      void tables.refetch()
    } finally {
      setBusy(false)
    }
  }

  const ready =
    picked.length > 0 && name.trim() && phone.trim() && seats >= party && slots.length > 0

  return (
    <div className="space-y-8">
      <Step n="I" title="วันและเวลา">
        <Card className="space-y-4">
          <div>
            <div className="mb-2 text-xs font-medium text-ink-soft">วันที่</div>
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {quickDays.map((d) => {
                const closed = hoursOf(d)?.closed
                const dt = new Date(`${d}T12:00:00+07:00`)
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={date === d}
                    disabled={closed}
                    onClick={() => setDate(d)}
                    className="pick flex w-14 shrink-0 flex-col items-center py-2"
                  >
                    <span className="text-[0.65rem] text-ink-faint">
                      {dt.toLocaleDateString('th-TH', {
                        weekday: 'short',
                        timeZone: 'Asia/Bangkok',
                      })}
                    </span>
                    <span className="tabular text-lg leading-tight font-bold">
                      {dt.toLocaleDateString('th-TH', { day: 'numeric', timeZone: 'Asia/Bangkok' })}
                    </span>
                    <span className="text-[0.6rem] text-ink-faint">
                      {closed
                        ? 'ปิด'
                        : dt.toLocaleDateString('th-TH', {
                            month: 'short',
                            timeZone: 'Asia/Bangkok',
                          })}
                    </span>
                  </button>
                )
              })}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-faint">
              หรือเลือกวันอื่น
              <input
                type="date"
                value={date}
                min={todayBangkok()}
                max={maxDate}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                className={`${INPUT} !w-auto !py-1 !text-xs`}
              />
            </label>
          </div>

          <div>
            <span className="text-xs font-medium tracking-wide text-ink-soft">กี่คน</span>
            <div className="mt-1 flex items-center justify-between rounded-lg border border-line-strong bg-[#fffdf7] p-1">
              <button
                type="button"
                aria-label="ลดจำนวนคน"
                onClick={() => setParty((p) => Math.max(1, p - 1))}
                className="grid h-8 w-8 place-items-center rounded-md text-lg text-ink-soft hover:bg-parchment-deep"
              >
                −
              </button>
              <span key={party} className="tabular animate-bump font-bold">
                {party} คน
              </span>
              <button
                type="button"
                aria-label="เพิ่มจำนวนคน"
                onClick={() => setParty((p) => Math.min(20, p + 1))}
                className="grid h-8 w-8 place-items-center rounded-md text-lg text-gold-deep hover:bg-parchment-deep"
              >
                +
              </button>
            </div>
          </div>

          {slots.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-ink-soft">เวลาเริ่ม</div>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
                {slots.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={time === s}
                    onClick={() => setTime(s)}
                    className="chip tabular !px-0 text-center"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>

        {today?.closed && (
          <Card className="mt-3 !border-crimson/40 !bg-crimson/5 text-sm text-crimson-deep">
            วันที่เลือกร้านปิด ลองเลือกวันอื่นครับ
          </Card>
        )}

        {!today?.closed && allSlots.length > 0 && slots.length === 0 && (
          <Card className="mt-3 !border-ember/40 !bg-ember/5 text-sm text-ember-deep">
            วันนี้เลยเวลารับจองแล้ว (ต้องจองล่วงหน้าอย่างน้อย {leadMinutes} นาที) ลองเลือกวันพรุ่งนี้ดูครับ
          </Card>
        )}

        {!today?.closed && allSlots.length === 0 && (
          <Card className="mt-3 !border-ember/40 !bg-ember/5 text-sm text-ember-deep">
            เวลาทำการของวันนี้ ({today?.openTime}–{today?.closeTime}) สั้นกว่ารอบเล่น{' '}
            {duration / 60} ชม. จึงยังไม่มีรอบให้จอง ลองเลือกวันอื่นดู
          </Card>
        )}
      </Step>

      <Step
        n="II"
        title="เลือกโต๊ะ"
        aside={
          picked.length > 0 && (
            <span className={`text-xs ${seats >= party ? 'text-forest-deep' : 'text-crimson'}`}>
              {picked.length} โต๊ะ · นั่งได้ {seats} คน
            </span>
          )
        }
      >
        {tables.isPending ? (
          <Empty icon="⏳">กำลังเช็คโต๊ะว่าง…</Empty>
        ) : (
          <TablePicker
            tables={tables.data ?? []}
            picked={picked}
            onToggle={(id) =>
              setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
            }
          />
        )}
      </Step>

      <Step n="III" title="ข้อมูลผู้จอง">
        <Card className="space-y-3">
          <Field label="ชื่อผู้จอง">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"
              className={INPUT}
            />
          </Field>
          <Field label="เบอร์โทร">
            <input
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="08x-xxx-xxxx"
              className={INPUT}
            />
          </Field>
          <Field label="หมายเหตุ (ถ้ามี)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="เช่น มีเด็กเล็ก / ขอโต๊ะเงียบ"
              className={INPUT}
            />
          </Field>
        </Card>
      </Step>

      <div>
        {/* สรุปก่อนส่ง */}
        <div className="panel mb-3 rounded-xl px-4 py-3 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-ink-faint">นัดหมาย</span>
            <span className="tabular text-right font-medium">
              {slots.length > 0 ? fmtDateTime(startAt) : '—'}
            </span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-ink-faint">ผู้ร่วมโต๊ะ</span>
            <span className="font-medium">{party} คน</span>
          </div>
        </div>

        {error && <p className="mb-2 animate-shake text-sm text-crimson">{error}</p>}

        <Button
          variant="primary"
          className="w-full !py-3 !text-base"
          disabled={busy || !ready}
          onClick={submit}
        >
          {busy ? 'กำลังส่งคำขอ…' : 'ส่งคำขอจอง'}
        </Button>

        <p className="mt-3 text-center text-xs text-ink-faint">
          ส่งแล้วรอร้านยืนยันอีกครั้ง คุณจะได้รหัสจองไว้เปิดดูและยกเลิกเอง
        </p>
      </div>
    </div>
  )
}

function TablePicker({
  tables,
  picked,
  onToggle,
}: {
  tables: AvailableTable[]
  picked: string[]
  onToggle: (id: string) => void
}) {
  const zones = useMemo(() => {
    const byZone = new Map<string, AvailableTable[]>()
    for (const t of tables) {
      const list = byZone.get(t.zone) ?? []
      list.push(t)
      byZone.set(t.zone, list)
    }
    return [...byZone.entries()]
  }, [tables])

  if (tables.every((t) => !t.available)) {
    return <Empty icon="🏰">ช่วงเวลานี้เต็มหมดแล้ว ลองเปลี่ยนเวลาดูครับ</Empty>
  }

  return (
    <div className="space-y-4">
      {zones.map(([zone, list]) => (
        <div key={zone}>
          <h3 className="mb-1.5 font-sans text-xs font-medium text-ink-faint">{zone}</h3>
          <div className="grid grid-cols-3 gap-2">
            {list.map((t) => {
              const on = picked.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  disabled={!t.available}
                  onClick={() => onToggle(t.id)}
                  className="pick relative p-3 text-left"
                >
                  <div className="text-lg tracking-wide font-bold">{t.code}</div>
                  <div className="text-xs text-ink-faint">
                    {t.seatMin}–{t.seatMax} ที่
                  </div>
                  {!t.available && <div className="text-xs text-crimson">ไม่ว่าง</div>}
                  {on && (
                    <span
                      className="wax-seal seal-stamp absolute top-2 right-2 h-5 w-5 text-[0.55rem]"
                      aria-hidden
                    >
                      ✓
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function Receipt({ receipt }: { receipt: BookingReceipt }) {
  const st = STATUS[receipt.status]
  return (
    <div className="space-y-5 pt-4 text-center">
      <div className="wax-seal seal-stamp mx-auto h-24 w-24 text-4xl">⚜</div>
      <h2 className="text-xl font-bold">ส่งคำขอจองแล้ว</h2>

      <Card ornate>
        <p className="text-sm text-ink-soft">รหัสจองของคุณ</p>
        <p className="tabular my-3 text-4xl font-bold tracking-[0.3em] text-gold-deep">
          {receipt.code}
        </p>
        <p className="text-xs text-ink-faint">
          จดไว้ให้ดี ใช้คู่กับเบอร์โทรเพื่อเปิดดูหรือยกเลิกรายการ
        </p>
      </Card>

      <Card className="space-y-1.5 text-left text-sm">
        <Row label="สถานะ" value={st?.label ?? receipt.status} />
        <Row label="เวลา" value={fmtDateTime(receipt.startAt)} />
        <Row label="โต๊ะ" value={receipt.tables.join(', ')} />
      </Card>

      <p className="text-sm text-ember-deep">{st?.hint}</p>
      <Link
        to="/book?m=find"
        className="inline-block text-sm text-ink-soft underline underline-offset-2"
      >
        ไปหน้าดูรายการที่จองไว้
      </Link>
    </div>
  )
}

function FindBooking() {
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
  const [mine, setMine] = useState<RememberedBooking[]>(() => myBookings())
  // เปิดฟอร์มกรอกรหัสเองเมื่อไม่มีของที่จำไว้ หรือกดขอเอง
  const [manual, setManual] = useState(() => myBookings().length === 0)
  const [result, setResult] = useState<BookingLookup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เกิดข้อผิดพลาด')
    } finally {
      setBusy(false)
    }
  }

  const st = result ? STATUS[result.status] : null
  const canCancel = result && (result.status === 'pending' || result.status === 'confirmed')

  return (
    <div className="space-y-4 pt-2">
      {mine.length > 0 && (
        <Card ornate className="space-y-2">
          <p className="text-sm font-medium">การจองที่ทำจากเครื่องนี้</p>
          {mine.map((b) => (
            <button
              key={b.code}
              type="button"
              disabled={busy}
              onClick={() => {
                setCode(b.code)
                setPhone(b.phone)
                void run(async () => setResult(await bookingDb.lookup(b.code, b.phone)))
              }}
              className="pick flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left disabled:opacity-50"
            >
              <span>
                <span className="tabular font-semibold tracking-[0.2em]">{b.code}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  {fmtDateTime(b.startAt)}
                </span>
              </span>
              <span className="text-sm text-ink-soft">เปิดดู →</span>
            </button>
          ))}
          {!manual && (
            <button
              type="button"
              onClick={() => setManual(true)}
              className="w-full pt-1 text-xs text-ink-faint underline underline-offset-2"
            >
              จองไว้จากเครื่องอื่น? กรอกรหัสเอง
            </button>
          )}
        </Card>
      )}

      {manual && (
        <Card ornate className="space-y-3">
          <p className="text-center text-sm text-ink-soft">กรอกรหัสจองและเบอร์โทรที่ใช้ตอนจอง</p>
          <Field label="รหัสจอง">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="เช่น K7M2XQ"
              maxLength={6}
              className={`${INPUT} tabular !py-3 text-center !text-xl tracking-[0.35em]`}
            />
          </Field>
          <Field label="เบอร์โทรที่ใช้จอง">
            <input
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="08x-xxx-xxxx"
              className={INPUT}
            />
          </Field>
          <Button
            variant="primary"
            className="w-full !py-2.5"
            disabled={busy || code.length < 6 || !phone.trim()}
            onClick={() => run(async () => setResult(await bookingDb.lookup(code, phone)))}
          >
            ค้นหา
          </Button>
        </Card>
      )}

      {error && <p className="animate-shake text-center text-sm text-crimson">{error}</p>}

      {result && (
        <Card className="animate-unroll space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-display text-lg font-semibold">{result.customerName}</span>
            <Badge tone={st?.tone ?? 'neutral'}>{st?.label ?? result.status}</Badge>
          </div>
          <div className="space-y-1.5 border-t border-dashed border-line pt-3 text-sm">
            <Row label="เวลา" value={fmtDateTime(result.startAt)} />
            <Row label="จำนวน" value={`${result.partySize} คน`} />
            <Row label="โต๊ะ" value={result.tables.join(', ') || '—'} />
            {result.note && <Row label="หมายเหตุ" value={result.note} />}
          </div>

          {canCancel && (
            <Button
              variant="danger"
              className="w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!confirm('ยกเลิกรายการจองนี้?')) return
                  await bookingDb.cancel(code, phone)
                  forgetBooking(code)
                  setMine(myBookings())
                  setResult(await bookingDb.lookup(code, phone))
                })
              }
            >
              ยกเลิกการจอง
            </Button>
          )}
        </Card>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-faint">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
