import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { bookingDb } from '../../data'
import type { AvailableTable, BookingLookup, BookingReceipt } from '../../domain/types'
import { Badge, Button, Card, Empty } from '../../components/ui'
import type { Tone } from '../../components/ui'

const STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  pending: { label: 'รอร้านยืนยัน', tone: 'amber', hint: 'ร้านจะติดต่อกลับเพื่อยืนยัน' },
  confirmed: { label: 'ยืนยันแล้ว', tone: 'emerald', hint: 'แล้วเจอกันที่ร้านนะครับ' },
  seated: { label: 'เช็คอินแล้ว', tone: 'sky', hint: 'กำลังใช้บริการอยู่' },
  cancelled: { label: 'ยกเลิกแล้ว', tone: 'slate', hint: '' },
  no_show: { label: 'ไม่ได้มาตามนัด', tone: 'rose', hint: '' },
}

/** แปลงเวลาไทยเป็น ISO โดยไม่พึ่ง timezone ของเครื่องลูกค้า (+07:00 ตายตัว) */
function bangkokToISO(date: string, time: string): string {
  return new Date(`${date}T${time}:00+07:00`).toISOString()
}

/** วันนี้ตามเวลาไทย ในรูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok',
  })
}

export default function BookingApp() {
  const [params, setParams] = useSearchParams()
  const mode = params.get('m') === 'find' ? 'find' : 'book'

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <h1 className="text-xl font-bold">🎲 จองโต๊ะ</h1>
        <ShopHoursLine />
        <div className="mt-3 flex gap-1">
          <Button
            className="flex-1"
            variant={mode === 'book' ? 'subtle' : 'ghost'}
            onClick={() => setParams({})}
          >
            จองใหม่
          </Button>
          <Button
            className="flex-1"
            variant={mode === 'find' ? 'subtle' : 'ghost'}
            onClick={() => setParams({ m: 'find' })}
          >
            ดูรายการที่จองไว้
          </Button>
        </div>
      </header>

      <main className="flex-1 p-4">{mode === 'book' ? <BookForm /> : <FindBooking />}</main>
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
    <p className="mt-0.5 text-xs text-slate-500">
      {same
        ? `เปิด ${open[0]!.openTime} – ${open[0]!.closeTime} ทุกวัน`
        : 'เวลาทำการต่างกันในแต่ละวัน — เลือกวันแล้วดูช่วงเวลาที่จองได้'}
    </p>
  )
}

function BookForm() {
  const cfg = useQuery({ queryKey: ['booking', 'config'], queryFn: () => bookingDb.config() })
  const hours = useQuery({ queryKey: ['booking', 'hours'], queryFn: () => bookingDb.hours() })

  const [date, setDate] = useState(todayBangkok)
  const [time, setTime] = useState('18:00')
  const [duration, setDuration] = useState(120)
  const [party, setParty] = useState(2)
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<BookingReceipt | null>(null)

  const startAt = useMemo(() => bangkokToISO(date, time), [date, time])

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

  /** เวลาทำการของวันที่เลือก — 0 = อาทิตย์ ตรงกับ shop_hours ฝั่งฐานข้อมูล */
  const today = useMemo(() => {
    const weekday = new Date(`${date}T12:00:00+07:00`).getUTCDay()
    return hours.data?.find((h) => h.weekday === weekday)
  }, [hours.data, date])

  const slots = useMemo(() => {
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
      setReceipt(
        await bookingDb.create({
          customerName: name,
          phone,
          partySize: party,
          startAt,
          durationMinutes: duration,
          tableIds: picked,
          note: note || undefined,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'จองไม่สำเร็จ')
      void tables.refetch()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="วันที่">
            <input
              type="date"
              value={date}
              min={todayBangkok()}
              max={maxDate}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="เวลา">
            <select value={time} onChange={(e) => setTime(e.target.value)} className={inputClass}>
              {slots.map((s) => (
                <option key={s} value={s}>
                  {s} น.
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="เล่นกี่ชั่วโมง">
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className={inputClass}
            >
              {[60, 90, 120, 180, 240, 300].map((m) => (
                <option key={m} value={m}>
                  {m / 60} ชม.
                </option>
              ))}
            </select>
          </Field>
          <Field label="กี่คน">
            <input
              type="number"
              min={1}
              max={20}
              value={party}
              onChange={(e) => setParty(Math.max(1, Number(e.target.value) || 1))}
              className={inputClass}
            />
          </Field>
        </div>
      </Card>

      {today?.closed && (
        <Card className="border-rose-800/60 bg-rose-950/20 text-sm text-rose-300">
          วันที่เลือกร้านปิด ลองเลือกวันอื่นครับ
        </Card>
      )}

      {!today?.closed && slots.length === 0 && (
        <Card className="border-amber-800/60 bg-amber-950/20 text-sm text-amber-300">
          ระยะเวลาที่เลือกยาวเกินกว่าเวลาทำการของวันนี้ ({today?.openTime}–{today?.closeTime})
          ลองลดจำนวนชั่วโมงลง
        </Card>
      )}

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-400">เลือกโต๊ะ</h2>
          {picked.length > 0 && (
            <span className={`text-xs ${seats >= party ? 'text-slate-500' : 'text-rose-400'}`}>
              เลือกแล้ว {picked.length} โต๊ะ · นั่งได้ {seats} คน
            </span>
          )}
        </div>

        {tables.isPending ? (
          <Empty>กำลังเช็คโต๊ะว่าง…</Empty>
        ) : (
          <TablePicker
            tables={tables.data ?? []}
            picked={picked}
            onToggle={(id) =>
              setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
            }
          />
        )}
      </div>

      <Card className="space-y-2">
        <Field label="ชื่อผู้จอง">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"
            className={inputClass}
          />
        </Field>
        <Field label="เบอร์โทร">
          <input
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="08x-xxx-xxxx"
            className={inputClass}
          />
        </Field>
        <Field label="หมายเหตุ (ถ้ามี)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เช่น มีเด็กเล็ก / ขอโต๊ะเงียบ"
            className={inputClass}
          />
        </Field>
      </Card>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <Button
        variant="primary"
        className="w-full !py-3"
        disabled={
          busy || picked.length === 0 || !name.trim() || !phone.trim() ||
          seats < party || slots.length === 0
        }
        onClick={submit}
      >
        {busy ? 'กำลังส่งคำขอ…' : 'ส่งคำขอจอง'}
      </Button>

      <p className="text-center text-xs text-slate-500">
        ส่งแล้วรอร้านยืนยันอีกครั้ง คุณจะได้รหัสจองไว้เปิดดูและยกเลิกเอง
      </p>
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
    return <Empty>ช่วงเวลานี้เต็มหมดแล้ว ลองเปลี่ยนเวลาดูครับ</Empty>
  }

  return (
    <div className="space-y-3">
      {zones.map(([zone, list]) => (
        <div key={zone}>
          <h3 className="mb-1 text-xs text-slate-500">{zone}</h3>
          <div className="grid grid-cols-3 gap-2">
            {list.map((t) => {
              const on = picked.includes(t.id)
              return (
                <button
                  key={t.id}
                  disabled={!t.available}
                  onClick={() => onToggle(t.id)}
                  className={`rounded-lg border p-2 text-left transition ${
                    !t.available
                      ? 'cursor-not-allowed border-slate-800 bg-slate-900/40 opacity-40'
                      : on
                        ? 'border-emerald-500 bg-emerald-950/40'
                        : 'border-slate-700 hover:border-slate-500'
                  }`}
                >
                  <div className="font-bold">{t.code}</div>
                  <div className="text-xs text-slate-500">
                    {t.seatMin}–{t.seatMax} ที่
                  </div>
                  {!t.available && <div className="text-xs text-rose-400">ไม่ว่าง</div>}
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
    <div className="space-y-4 text-center">
      <p className="text-5xl">📋</p>
      <h2 className="text-lg font-bold">ส่งคำขอจองแล้ว</h2>

      <Card>
        <p className="text-sm text-slate-400">รหัสจองของคุณ</p>
        <p className="tabular my-2 text-4xl font-bold tracking-[0.3em] text-emerald-400">
          {receipt.code}
        </p>
        <p className="text-xs text-slate-500">
          จดไว้ให้ดี ใช้คู่กับเบอร์โทรเพื่อเปิดดูหรือยกเลิกรายการ
        </p>
      </Card>

      <Card className="space-y-1 text-left text-sm">
        <Row label="สถานะ" value={st?.label ?? receipt.status} />
        <Row label="เวลา" value={fmtDateTime(receipt.startAt)} />
        <Row label="ระยะเวลา" value={`${receipt.durationMinutes / 60} ชม.`} />
        <Row label="โต๊ะ" value={receipt.tables.join(', ')} />
      </Card>

      <p className="text-sm text-amber-400">{st?.hint}</p>
      <Link to="/book?m=find" className="inline-block text-sm text-slate-400 underline">
        ไปหน้าดูรายการที่จองไว้
      </Link>
    </div>
  )
}

function FindBooking() {
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
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
    <div className="space-y-4">
      <Card className="space-y-2">
        <Field label="รหัสจอง">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="เช่น K7M2XQ"
            maxLength={6}
            className={`${inputClass} tabular text-center text-lg tracking-[0.3em]`}
          />
        </Field>
        <Field label="เบอร์โทรที่ใช้จอง">
          <input
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="08x-xxx-xxxx"
            className={inputClass}
          />
        </Field>
        <Button
          variant="primary"
          className="w-full"
          disabled={busy || code.length < 6 || !phone.trim()}
          onClick={() => run(async () => setResult(await bookingDb.lookup(code, phone)))}
        >
          ค้นหา
        </Button>
      </Card>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      {result && (
        <Card className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{result.customerName}</span>
            <Badge tone={st?.tone ?? 'slate'}>{st?.label ?? result.status}</Badge>
          </div>
          <div className="space-y-1 text-sm">
            <Row label="เวลา" value={fmtDateTime(result.startAt)} />
            <Row label="ระยะเวลา" value={`${result.durationMinutes / 60} ชม.`} />
            <Row label="จำนวน" value={`${result.partySize} คน`} />
            <Row label="โต๊ะ" value={result.tables.join(', ') || '—'} />
            {result.note && <Row label="หมายเหตุ" value={result.note} />}
          </div>

          {canCancel && (
            <Button
              variant="danger"
              className="mt-2 w-full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!confirm('ยกเลิกรายการจองนี้?')) return
                  await bookingDb.cancel(code, phone)
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

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
