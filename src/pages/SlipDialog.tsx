import { useEffect, useRef, useState } from 'react'
import { db, shopLogoUrl } from '../data'
import { useShopProfile } from '../hooks/useShop'
import type { Visit } from '../domain/types'
import { Button, Icon, Modal, Segmented } from '../components/ui'
import {
  guestUrl, loadPrinter, printTableSlip, qrSvg, savePrinter, slipHtml,
} from '../lib/printer'
import type { PaperWidth, PrinterSettings, TableSlip } from '../lib/printer'

/**
 * ใบ QR ของรอบนี้ — ตัวอย่างบนจอ + พิมพ์ลงเครื่องพิมพ์ความร้อน
 *
 * ตัวอย่างใช้ HTML ชุดเดียวกับที่ส่งไปพิมพ์ (ผ่าน iframe) ที่เห็นบนจอจึงตรงกับ
 * ใบที่ออกจากเครื่อง ไม่ใช่หน้าตาที่เขียนเลียนแบบแยกกันแล้วเพี้ยนทีหลัง
 */
export default function SlipDialog({
  visit,
  tableCode,
  zone,
  justOpened = false,
  onClose,
}: {
  visit: Visit
  tableCode: string
  zone: string
  /** เพิ่งเปิดโต๊ะ — สั่งพิมพ์อัตโนมัติถ้าตั้งไว้ และไม่ต้องมีปุ่มออก QR ใหม่ */
  justOpened?: boolean
  onClose: () => void
}) {
  const [settings, setSettings] = useState<PrinterSettings>(loadPrinter)
  const [token, setToken] = useState(visit.qrToken)
  const [svg, setSvg] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoPrinted = useRef(false)

  const url = token ? guestUrl(token) : ''
  const shop = useShopProfile()
  const slip: TableSlip = {
    tableCode, zone, visitCode: visit.code, openedAt: visit.openedAt, url,
    shopName: shop.name, logoUrl: shopLogoUrl(shop.logoPath),
  }

  useEffect(() => {
    if (!url) return
    let alive = true
    void qrSvg(url).then((s) => alive && setSvg(s))
    return () => {
      alive = false
    }
  }, [url])

  async function print() {
    setBusy(true)
    setError(null)
    try {
      await printTableSlip(slip, settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'พิมพ์ไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  // เปิดโต๊ะแล้วพิมพ์ทันที — ทำครั้งเดียว ไม่ให้ re-render แล้วพิมพ์ซ้ำ
  useEffect(() => {
    if (justOpened && settings.autoPrint && svg && !autoPrinted.current) {
      autoPrinted.current = true
      void print()
    }
  }, [justOpened, settings.autoPrint, svg])

  function setPaper(paper: PaperWidth) {
    const next = { ...settings, paper }
    setSettings(next)
    savePrinter(next)
  }

  async function rotate() {
    if (!confirm('ออก QR ใหม่ให้โต๊ะนี้? ใบที่ลูกค้าถืออยู่จะใช้ไม่ได้ทันที')) return
    setBusy(true)
    setError(null)
    try {
      setToken(await db.rotateVisitToken(visit.id))
      setNotice('ออก QR ใหม่แล้ว — พิมพ์ใบใหม่ให้ลูกค้า ใบเดิมใช้ไม่ได้แล้ว')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ออก QR ใหม่ไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={justOpened ? `เปิดโต๊ะ ${tableCode} แล้ว` : `QR ของโต๊ะ ${tableCode}`}
      hint="พิมพ์ใบนี้ให้ลูกค้า สแกนแล้วลงชื่อและสั่งของได้เอง — QR ใช้ได้เฉพาะรอบนี้"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          {error && <p className="mb-2 animate-shake text-sm text-crimson">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose} disabled={busy}>
              {justOpened ? 'เสร็จ' : 'ปิด'}
            </Button>
            <Button className="flex-1" variant="primary" onClick={print} disabled={busy || !svg}>
              {busy ? 'กำลังส่งไปพิมพ์…' : 'พิมพ์ใบ QR'}
            </Button>
          </div>
        </>
      }
    >
      {!token ? (
        <p className="rounded-lg border border-ember/30 bg-ember/10 p-3 text-sm text-ember-deep">
          รอบนี้ยังไม่มี QR — ฐานข้อมูลยังไม่ได้รัน patch-visit-qr.sql
        </p>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-ink-soft">ขนาดกระดาษ</span>
            <Segmented
              value={String(settings.paper) as '58' | '80'}
              onChange={(v) => setPaper(Number(v) as PaperWidth)}
              options={[
                { value: '58', label: '58 มม.' },
                { value: '80', label: '80 มม.' },
              ]}
            />
          </div>

          {/* ม้วนกระดาษความร้อน */}
          <div className="rounded-xl bg-parchment-deep/60 p-4 shadow-[inset_0_2px_6px_rgb(70_45_20/0.15)]">
            <SlipPreview html={svg ? slipHtml(slip, settings, svg) : ''} paper={settings.paper} />
          </div>

          {notice && (
            <p className="mt-3 animate-unroll rounded-lg border border-forest/30 bg-forest/10 p-2 text-xs text-forest-deep">
              ✓ {notice}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <button
              type="button"
              className="flex items-center gap-1 text-ink-faint underline-offset-2 hover:text-ink hover:underline"
              onClick={() => {
                void navigator.clipboard?.writeText(url)
                setNotice('คัดลอกลิงก์แล้ว — ส่งให้ลูกค้าทางแชตได้')
              }}
            >
              <Icon name="copy" className="h-3.5 w-3.5" /> คัดลอกลิงก์
            </button>
            {!justOpened && (
              <button
                type="button"
                disabled={busy}
                className="flex items-center gap-1 text-crimson underline-offset-2 hover:underline disabled:opacity-40"
                onClick={rotate}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" /> ลูกค้าทำใบหาย — ออก QR ใหม่
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

/** มม. → px บนจอ (96dpi) */
const MM = 96 / 25.4

/** ตัวอย่างใบเหมือนจริง — iframe ทำให้ CSS ของใบไม่ปนกับ CSS ของแอป */
function SlipPreview({ html, paper }: { html: string; paper: PaperWidth }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(420)

  return (
    <div className="mx-auto overflow-hidden bg-white shadow-md" style={{ width: paper * MM }}>
      {html ? (
        <iframe
          ref={ref}
          title="ตัวอย่างใบ QR"
          srcDoc={html}
          className="block w-full border-0"
          style={{ height }}
          onLoad={() => {
            const h = ref.current?.contentDocument?.documentElement.scrollHeight
            if (h) setHeight(h)
          }}
        />
      ) : (
        <div className="grid h-96 place-items-center text-xs text-ink-faint">กำลังสร้าง QR…</div>
      )}
      {/* ขอบฉีกของกระดาษ */}
      <div
        aria-hidden
        className="h-2 bg-parchment-deep/60"
        style={{
          background:
            'linear-gradient(-45deg, transparent 4px, white 0) 0 0 / 8px 8px repeat-x, linear-gradient(45deg, transparent 4px, white 0) 0 0 / 8px 8px repeat-x',
        }}
      />
    </div>
  )
}
