import { useEffect, useState } from 'react'
import { db } from '../data'
import { bookingUrl, guestUrl, toQrDataUrl } from '../lib/qr'
import { useSnapshot } from '../hooks/useData'
import type { CafeTable } from '../domain/types'
import { Badge, Button, Card, Empty, Icon, PageHeader } from '../components/ui'
import type { IconName } from '../components/ui'

export default function TableQR() {
  const { data } = useSnapshot()
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [bookingQR, setBookingQR] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void toQrDataUrl(bookingUrl()).then(setBookingQR)
  }, [])

  const tables = data?.tables ?? []

  useEffect(() => {
    let cancelled = false
    async function render() {
      const next: Record<string, string> = {}
      for (const table of tables) {
        if (!table.qrToken) continue
        next[table.id] = await toQrDataUrl(guestUrl(table.qrToken))
      }
      if (!cancelled) setCodes(next)
    }
    void render()
    return () => {
      cancelled = true
    }
    // แปลงใหม่เมื่อ token เปลี่ยน (เช่นหลังกดเปลี่ยน token)
  }, [tables.map((t) => `${t.id}:${t.qrToken}`).join(',')])

  if (!data) return null

  const missing = tables.some((t) => !t.qrToken)

  return (
    <div>
      <PageHeader
        eyebrow="ป้ายประจำโต๊ะ"
        title="QR ประจำโต๊ะ"
        subtitle="พิมพ์ติดไว้ที่โต๊ะ ลูกค้าสแกนแล้วสั่งอาหารได้เองโดยไม่ต้องล็อกอิน"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Rule icon="qr" title="สแกนแล้วสั่งได้เลย">
          ไม่ต้องสมัคร ไม่ต้องล็อกอิน
        </Rule>
        <Rule icon="table" title="ใช้ได้เฉพาะตอนเปิดโต๊ะ">
          ปิดบิลแล้วใบเดิมสั่งอะไรไม่ได้ จนกว่าจะมีลูกค้าใหม่นั่ง
        </Rule>
        <Rule icon="refresh" title="QR หลุดออกนอกร้าน?" warn>
          กด "เปลี่ยน QR" แล้วพิมพ์ใบใหม่ — ใบเก่าจะใช้ไม่ได้ทันที
        </Rule>
      </div>

      <Card ornate className="mt-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row">
          {bookingQR ? (
            <img
              src={bookingQR}
              alt="QR จองโต๊ะ"
              className="w-36 shrink-0 rounded-lg border-4 border-double border-gold/60 bg-[#fffdf7] p-2"
            />
          ) : (
            <div className="aspect-square w-36 shrink-0 animate-pulse rounded-lg bg-parchment-deep" />
          )}
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="font-display text-[0.7rem] tracking-[0.25em] text-gold-deep uppercase">
              ประกาศหน้าร้าน
            </p>
            <h3 className="text-xl font-bold">QR จองโต๊ะล่วงหน้า</h3>
            <p className="mt-1 text-sm text-ink-soft">
              คนละใบกับ QR ประจำโต๊ะ — ใบนี้ไม่ผูกกับโต๊ะไหน เอาไปติดหน้าร้าน โพสต์เพจ
              หรือส่งให้ลูกค้าทางแชตได้เลย
            </p>
            <code className="mt-3 block truncate rounded bg-parchment-deep px-2 py-1 text-xs text-ink-faint">
              {bookingUrl()}
            </code>
            <div className="mt-3 flex justify-center gap-2 sm:justify-start">
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(bookingUrl())
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Icon name="copy" className="h-4 w-4" />
                {copied ? 'คัดลอกแล้ว ✓' : 'คัดลอกลิงก์'}
              </Button>
              <Button onClick={() => printBooking(bookingQR)}>
                <Icon name="print" className="h-4 w-4" />
                พิมพ์
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {missing && (
        <Empty>
          ข้อมูลโต๊ะยังไม่มี token — ต้องรัน migration ล่าสุดก่อน (supabase/setup-all.sql)
        </Empty>
      )}

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tables
          .filter((t) => t.qrToken)
          .map((table) => (
            <article key={table.id} className="panel lift rounded-xl p-2">
              {/* ป้ายตั้งโต๊ะ: กรอบคู่ด้านใน */}
              <div className="rounded-lg border-4 border-double border-gold/50 p-4 text-center">
                <div className="flex items-center justify-between">
                  <Badge tone={table.status === 'occupied' ? 'forest' : 'neutral'}>
                    {table.zone}
                  </Badge>
                  <span className="text-xs text-ink-faint">{table.seatMax} ที่นั่ง</span>
                </div>
                <div className="mt-2 text-4xl tracking-wide font-bold">{table.code}</div>
                <div className="divider my-2 text-[0.6rem]" aria-hidden>
                  ◆
                </div>
                {codes[table.id] ? (
                  <img
                    src={codes[table.id]}
                    alt={`QR โต๊ะ ${table.code}`}
                    className="mx-auto w-full max-w-[200px] rounded bg-[#fffdf7] p-1"
                  />
                ) : (
                  <div className="mx-auto aspect-square w-full max-w-[200px] animate-pulse rounded bg-parchment-deep" />
                )}
                <p className="mt-2 text-xs text-ink-faint italic">
                  สแกนเพื่อสั่งอาหารและเครื่องดื่ม
                </p>
              </div>

              <div className="mt-2 flex gap-1.5">
                <Button className="flex-1" onClick={() => printOne(table, codes[table.id])}>
                  <Icon name="print" className="h-4 w-4" />
                  พิมพ์
                </Button>
                <Button
                  variant="danger"
                  disabled={busy === table.id}
                  onClick={async () => {
                    if (!confirm(`เปลี่ยน QR ของโต๊ะ ${table.code}? ใบที่พิมพ์ไว้จะใช้ไม่ได้ทันที`))
                      return
                    setBusy(table.id)
                    try {
                      await db.rotateTableToken(table.id)
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  เปลี่ยน QR
                </Button>
              </div>
            </article>
          ))}
      </div>
    </div>
  )
}

function Rule({
  icon,
  title,
  warn,
  children,
}: {
  icon: IconName
  title: string
  warn?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`panel flex gap-3 rounded-xl p-4 ${warn ? '!border-ember/40 !bg-ember/5' : ''}`}
    >
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
          warn ? 'bg-ember/15 text-ember-deep' : 'bg-gold/15 text-gold-deep'
        }`}
      >
        <Icon name={icon} className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-ink-soft">{children}</div>
      </div>
    </div>
  )
}

function printBooking(dataUrl: string) {
  printSheet('จองโต๊ะล่วงหน้า', '', dataUrl, 'สแกนเพื่อจองโต๊ะ')
}

function printOne(table: CafeTable, dataUrl?: string) {
  if (!dataUrl) return
  printSheet(table.code, table.zone, dataUrl, 'สแกนเพื่อสั่งอาหารและเครื่องดื่ม')
}

function printSheet(title: string, subtitle: string, dataUrl: string, hint: string) {
  const w = window.open('', '_blank', 'width=480,height=720')
  if (!w) return
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8">
    <title>${title}</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Taviraj:wght@400;700&display=swap">
    <style>
      body { font-family: 'Taviraj', Georgia, serif; text-align: center; padding: 32px; color: #2a1c12; }
      .frame { display: inline-block; padding: 24px 40px; border: 6px double #b8872e; border-radius: 12px; }
      .orn { color: #b8872e; letter-spacing: 10px; margin: 0 0 12px; }
      h1 { font-size: 60px; margin: 0 0 4px; }
      p { color: #5b4633; margin: 4px 0 20px; }
      img { width: 300px; }
      .hint { margin-top: 20px; font-size: 18px; }
    </style></head><body><div class="frame">
    <div class="orn">❦ ◆ ❦</div>
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <img src="${dataUrl}" alt="QR">
    <p class="hint">${hint}</p>
    </div></body></html>`)
  w.document.close()
  w.focus()
  // รอฟอนต์โหลดก่อนสั่งพิมพ์ ไม่งั้นหัวป้ายออกมาเป็นฟอนต์ระบบ
  w.onload = () => w.print()
}
