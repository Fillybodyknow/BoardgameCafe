import { useEffect, useState } from 'react'
import { bookingUrl, toQrDataUrl } from '../lib/qr'
import { loadPrinter, printTableSlip, savePrinter } from '../lib/printer'
import { shopLogoUrl } from '../data'
import { useShopProfile } from '../hooks/useShop'
import type { PaperWidth, PrinterSettings } from '../lib/printer'
import { useSnapshot } from '../hooks/useData'
import type { Visit } from '../domain/types'
import { Button, Card, Empty, Field, Icon, INPUT, PageHeader, SectionTitle, Segmented } from '../components/ui'
import type { IconName } from '../components/ui'
import SlipDialog from './SlipDialog'

/**
 * QR ของโต๊ะสร้างใหม่ทุกครั้งที่เปิดโต๊ะ แล้วพิมพ์ลงเครื่องพิมพ์ความร้อนยื่นให้ลูกค้า
 * หน้านี้จึงไม่มี QR ติดโต๊ะให้พิมพ์แล้ว เหลือ: ตั้งค่าเครื่องพิมพ์, พิมพ์ซ้ำให้โต๊ะ
 * ที่เปิดอยู่ และ QR จองโต๊ะ (ใบเดียวที่ยังถาวร เพราะไม่ผูกกับโต๊ะไหน)
 */
export default function TableQR() {
  const { data } = useSnapshot()
  const [bookingQR, setBookingQR] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [printer, setPrinter] = useState<PrinterSettings>(loadPrinter)
  const [reprint, setReprint] = useState<Visit | null>(null)
  const shop = useShopProfile()

  useEffect(() => {
    void toQrDataUrl(bookingUrl()).then(setBookingQR)
  }, [])

  if (!data) return null

  function update(patch: Partial<PrinterSettings>) {
    const next = { ...printer, ...patch }
    setPrinter(next)
    savePrinter(next)
  }

  /** โต๊ะที่แต่ละรอบครองอยู่ — รอบหนึ่งอาจต่อหลายโต๊ะ */
  function tablesOf(visitId: string) {
    return data!.occupancies
      .filter((o) => o.visitId === visitId && o.toAt === null)
      .map((o) => data!.tables.find((t) => t.id === o.tableId))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
  }

  const open = data.visits.filter((v) => v.status === 'open')

  return (
    <div>
      <PageHeader
        eyebrow="ใบ QR และเครื่องพิมพ์"
        title="QR & เครื่องพิมพ์"
        subtitle="เปิดโต๊ะแล้วระบบออก QR ใหม่ให้ทุกครั้ง — พิมพ์ลงเครื่องพิมพ์ความร้อนยื่นให้ลูกค้า"
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Rule icon="qr" title="QR ใหม่ทุกครั้งที่เปิดโต๊ะ">
          ลูกค้าเก่าเอา QR ที่ถ่ายไว้มาสั่งของเข้าบิลคนใหม่ไม่ได้
        </Rule>
        <Rule icon="table" title="ตามกลุ่มไปเมื่อย้ายโต๊ะ">
          ย้ายหรือต่อโต๊ะ ใบเดิมยังใช้ได้ ไม่ต้องพิมพ์ใหม่
        </Rule>
        <Rule icon="clock" title="หมดอายุเมื่อปิดบิล">
          ชำระเงินแล้วใบนั้นสั่งอะไรไม่ได้อีก
        </Rule>
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        สติกเกอร์ QR ที่เคยติดโต๊ะไว้เลิกใช้แล้ว แกะออกได้ — ลูกค้าที่สแกนจะเห็นข้อความให้ขอใบจากพนักงาน
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section>
          <SectionTitle>เครื่องพิมพ์ใบเสร็จ</SectionTitle>
          <Card ornate className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">ขนาดกระดาษ</span>
              <Segmented
                value={String(printer.paper) as '58' | '80'}
                onChange={(v) => update({ paper: Number(v) as PaperWidth })}
                options={[
                  { value: '58', label: '58 มม.' },
                  { value: '80', label: '80 มม.' },
                ]}
              />
            </div>

            <div>
              {/* ชื่อร้านและโลโก้บนหัวใบมาจากหน้าตั้งค่าร้าน — ไม่ให้แก้ซ้ำที่นี่ ชื่อจะได้ไม่ตีกัน */}
              <Field label="ข้อความท้ายใบ">
                <input
                  value={printer.footer}
                  onChange={(e) => update({ footer: e.target.value })}
                  placeholder="เช่น Wi-Fi: BoardgameCafe / รหัส 12345678"
                  className={INPUT}
                />
              </Field>
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={printer.autoPrint}
                onChange={(e) => update({ autoPrint: e.target.checked })}
                className="mt-1 h-4 w-4 accent-[#3d6b46]"
              />
              <span>
                เปิดโต๊ะแล้วสั่งพิมพ์ทันที
                <span className="block text-xs text-ink-faint">
                  ไม่ต้องกดปุ่มพิมพ์ในหน้าต่าง QR — ถ้าอยากข้ามหน้าต่างเลือกเครื่องพิมพ์ด้วย ดูวิธีด้านล่าง
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button
                variant="primary"
                onClick={() =>
                  void printTableSlip(
                    {
                      tableCode: 'A1',
                      zone: 'ตัวอย่าง',
                      visitCode: 'V-000',
                      openedAt: new Date().toISOString(),
                      url: bookingUrl(),
                      shopName: shop.name,
                      logoUrl: shopLogoUrl(shop.logoPath),
                      test: true,
                    },
                    printer,
                  )
                }
              >
                <Icon name="print" className="h-4 w-4" />
                พิมพ์ใบทดสอบ
              </Button>
              <span className="text-xs text-ink-faint">ค่าเหล่านี้จำไว้ในเครื่องนี้เท่านั้น</span>
            </div>

            <details className="rounded-lg bg-parchment-deep/50 p-3 text-sm">
              <summary className="cursor-pointer font-medium">วิธีตั้งเครื่องพิมพ์ความร้อนครั้งแรก</summary>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-ink-soft">
                <li>ลงไดรเวอร์ของเครื่องพิมพ์ (Xprinter, Epson TM, Sunmi ฯลฯ) ให้ Windows/macOS เห็นเป็นเครื่องพิมพ์ปกติ</li>
                <li>
                  ในไดรเวอร์ตั้งขนาดกระดาษเป็น <b>80mm × ยาวต่อเนื่อง</b> (หรือ 58mm) และเปิดตัดกระดาษอัตโนมัติ
                </li>
                <li>
                  กด “พิมพ์ใบทดสอบ” → เลือกเครื่องพิมพ์ความร้อน → ระยะขอบ <b>ไม่มี</b> → ปิด
                  “หัวกระดาษและท้ายกระดาษ” → พิมพ์ (Chrome จำค่านี้ไว้ให้ครั้งต่อไป)
                </li>
                <li>
                  อยากให้ออกเครื่องทันทีไม่ต้องเห็นหน้าต่างพิมพ์: ตั้งเครื่องพิมพ์ความร้อนเป็นเครื่องหลัก
                  แล้วเปิด Chrome ด้วย <code className="rounded bg-vellum px-1">--kiosk-printing</code>{' '}
                  (คลิกขวาที่ shortcut → Properties → ต่อท้ายช่อง Target) คู่กับติ๊ก “เปิดโต๊ะแล้วสั่งพิมพ์ทันที”
                </li>
              </ol>
            </details>
          </Card>
        </section>

        <section>
          <SectionTitle>พิมพ์ซ้ำให้โต๊ะที่เปิดอยู่</SectionTitle>
          {open.length === 0 ? (
            <Empty icon="🕯">ยังไม่มีโต๊ะเปิดอยู่</Empty>
          ) : (
            <div className="space-y-2">
              {open.map((v) => {
                const tables = tablesOf(v.id)
                return (
                  <Card key={v.id} className="flex items-center justify-between gap-3 !py-3">
                    <div className="min-w-0">
                      <div className="font-bold tracking-wide">
                        {tables.map((t) => t.code).join('+') || '—'}
                      </div>
                      <div className="text-xs text-ink-faint">
                        {v.code} · เปิด{' '}
                        {new Date(v.openedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <Button onClick={() => setReprint(v)}>
                      <Icon name="qr" className="h-4 w-4" />
                      ใบ QR
                    </Button>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <Card ornate className="mt-8">
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
              ใบเดียวที่ยังถาวร เพราะไม่ผูกกับโต๊ะไหน เอาไปติดหน้าร้าน โพสต์เพจ
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
                พิมพ์โปสเตอร์
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {reprint && (
        <SlipDialog
          visit={reprint}
          tableCode={tablesOf(reprint.id).map((t) => t.code).join('+') || '—'}
          zone={tablesOf(reprint.id)[0]?.zone ?? ''}
          onClose={() => setReprint(null)}
        />
      )}
    </div>
  )
}

function Rule({
  icon,
  title,
  children,
}: {
  icon: IconName
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="panel flex gap-3 rounded-xl p-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gold/15 text-gold-deep">
        <Icon name={icon} className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-ink-soft">{children}</div>
      </div>
    </div>
  )
}

/** โปสเตอร์ QR จอง — กระดาษ A4/A5 ปกติ ไม่ใช่เครื่องพิมพ์ความร้อน */
function printBooking(dataUrl: string) {
  const w = window.open('', '_blank', 'width=480,height=720')
  if (!w) return
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8">
    <title>จองโต๊ะล่วงหน้า</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Taviraj:wght@400;700&display=swap">
    <style>
      body { font-family: 'Taviraj', Georgia, serif; text-align: center; padding: 32px; color: #2a1c12; }
      .frame { display: inline-block; padding: 24px 40px; border: 6px double #b8872e; border-radius: 12px; }
      .orn { color: #b8872e; letter-spacing: 10px; margin: 0 0 12px; }
      h1 { font-size: 48px; margin: 0 0 16px; }
      img { width: 300px; }
      .hint { margin-top: 20px; font-size: 18px; color: #5b4633; }
    </style></head><body><div class="frame">
    <div class="orn">❦ ◆ ❦</div>
    <h1>จองโต๊ะล่วงหน้า</h1>
    <img src="${dataUrl}" alt="QR">
    <p class="hint">สแกนเพื่อจองโต๊ะ</p>
    </div></body></html>`)
  w.document.close()
  w.focus()
  // รอฟอนต์โหลดก่อนสั่งพิมพ์ ไม่งั้นหัวป้ายออกมาเป็นฟอนต์ระบบ
  w.onload = () => w.print()
}
