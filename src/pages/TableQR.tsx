import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { db } from '../data'
import { useSnapshot } from '../hooks/useData'
import type { CafeTable } from '../domain/types'
import { Badge, Button, Card, Empty, SectionTitle } from '../components/ui'

/** URL ที่ฝังใน QR — ต้องเป็น absolute เพราะลูกค้าเปิดจากมือถือตัวเอง */
function guestUrl(token: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/t/${token}`
}

function bookingUrl(): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/book`
}

export default function TableQR() {
  const { data } = useSnapshot()
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [bookingQR, setBookingQR] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void QRCode.toDataURL(bookingUrl(), {
      width: 320, margin: 1, color: { dark: '#0f172a', light: '#ffffff' },
    }).then(setBookingQR)
  }, [])

  const tables = data?.tables ?? []

  useEffect(() => {
    let cancelled = false
    async function render() {
      const next: Record<string, string> = {}
      for (const table of tables) {
        if (!table.qrToken) continue
        next[table.id] = await QRCode.toDataURL(guestUrl(table.qrToken), {
          width: 320,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
        })
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
    <div className="space-y-4">
      <SectionTitle>QR ประจำโต๊ะ</SectionTitle>

      <Card className="text-sm text-slate-400">
        พิมพ์ติดไว้ที่โต๊ะ ลูกค้าสแกนแล้วสั่งอาหารได้เองโดยไม่ต้องล็อกอิน
        <br />
        QR ใช้สั่งของได้เฉพาะตอนที่โต๊ะนั้นเปิดบิลอยู่ — ปิดบิลแล้วใบเดิมสั่งอะไรไม่ได้
        จนกว่าจะมีลูกค้าใหม่นั่ง
        <br />
        <span className="text-amber-400">
          ถ้าสงสัยว่า QR หลุดออกนอกร้าน ให้กด "เปลี่ยน QR" แล้วพิมพ์ใบใหม่ — ใบเก่าจะใช้ไม่ได้ทันที
        </span>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-4">
          {bookingQR && (
            <img
              src={bookingQR}
              alt="QR จองโต๊ะ"
              className="w-28 shrink-0 rounded-lg bg-white p-1.5"
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">QR จองโต๊ะล่วงหน้า</h3>
            <p className="mt-1 text-sm text-slate-400">
              คนละใบกับ QR ประจำโต๊ะ — ใบนี้ไม่ผูกกับโต๊ะไหน เอาไปติดหน้าร้าน
              โพสต์เพจ หรือส่งให้ลูกค้าทางแชตได้เลย
            </p>
            <code className="mt-2 block truncate text-xs text-slate-500">{bookingUrl()}</code>
            <div className="mt-2 flex gap-1">
              <Button onClick={() => void navigator.clipboard?.writeText(bookingUrl())}>
                คัดลอกลิงก์
              </Button>
              <Button onClick={() => printBooking(bookingQR)}>พิมพ์</Button>
            </div>
          </div>
        </div>
      </Card>

      {missing && (
        <Empty>
          ข้อมูลโต๊ะยังไม่มี token — ต้องรัน migration ล่าสุดก่อน (supabase/setup-all.sql)
        </Empty>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tables.filter((t) => t.qrToken).map((table) => (
          <Card key={table.id} className="text-center">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold">{table.code}</span>
              <Badge tone={table.status === 'occupied' ? 'emerald' : 'slate'}>{table.zone}</Badge>
            </div>

            {codes[table.id] ? (
              <img
                src={codes[table.id]}
                alt={`QR โต๊ะ ${table.code}`}
                className="mx-auto mt-3 w-full max-w-[220px] rounded-lg bg-white p-2"
              />
            ) : (
              <div className="mx-auto mt-3 aspect-square w-full max-w-[220px] animate-pulse rounded-lg bg-slate-800" />
            )}

            <div className="mt-3 flex gap-1">
              <Button className="flex-1" onClick={() => printOne(table, codes[table.id])}>
                พิมพ์
              </Button>
              <Button
                variant="danger"
                disabled={busy === table.id}
                onClick={async () => {
                  if (!confirm(`เปลี่ยน QR ของโต๊ะ ${table.code}? ใบที่พิมพ์ไว้จะใช้ไม่ได้ทันที`)) return
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
          </Card>
        ))}
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
  const w = window.open('', '_blank', 'width=480,height=640')
  if (!w) return
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; text-align: center; padding: 32px; }
      h1 { font-size: 56px; margin: 0 0 8px; }
      p { color: #475569; margin: 4px 0 24px; }
      img { width: 320px; }
      .hint { margin-top: 24px; font-size: 18px; }
    </style></head><body>
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <img src="${dataUrl}" alt="QR">
    <p class="hint">${hint}</p>
    </body></html>`)
  w.document.close()
  w.focus()
  w.print()
}
