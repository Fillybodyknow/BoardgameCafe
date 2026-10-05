import { useEffect, useState } from 'react'
import { Button, Icon, Modal } from '../../components/ui'
import { guestUrl, qrSvg } from '../../lib/printer'

/**
 * QR ของโต๊ะบนจอลูกค้า — ใบหายหรือเพื่อนมาทีหลัง ก็สแกนจากจอมือถือคนในโต๊ะได้เลย
 * ไม่ต้องเดินไปขอที่เคาน์เตอร์
 *
 * เป็น token เดียวกับใบที่พิมพ์ (ของรอบนี้) ไม่ได้ออกใบใหม่ จึงหมดอายุพร้อมกัน
 * ตอนปิดบิล — ส่วนการออก QR ใหม่ (กรณีหลุดออกนอกร้าน) ยังเป็นงานของพนักงาน
 */
export default function TableQRSheet({
  token,
  tableCode,
  onClose,
}: {
  token: string
  tableCode: string
  onClose: () => void
}) {
  const url = guestUrl(token)
  const [svg, setSvg] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // ขาวดำล้วนแบบเดียวกับใบที่พิมพ์ — กล้องอ่านจากจออีกเครื่องได้ง่ายที่สุด
    void qrSvg(url).then((s) => alive && setSvg(s))
    return () => {
      alive = false
    }
  }, [url])

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  async function share() {
    try {
      await navigator.share({ title: `โต๊ะ ${tableCode}`, text: 'สแกนเข้าโต๊ะเพื่อสั่งของ', url })
    } catch {
      // ผู้ใช้กดยกเลิกหน้าต่างแชร์ — ไม่ใช่ข้อผิดพลาด
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setNotice('คัดลอกลิงก์แล้ว — ส่งให้เพื่อนในโต๊ะทางแชตได้')
    } catch {
      setNotice('คัดลอกไม่ได้ — ให้เพื่อนสแกนจากจอแทน')
    }
  }

  return (
    <Modal
      title={`QR โต๊ะ ${tableCode}`}
      hint="ให้เพื่อนในโต๊ะสแกนจากจอนี้ได้เลย ไม่ต้องไปขอใบใหม่ที่เคาน์เตอร์"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {canShare && (
            <Button className="flex-1" onClick={() => void share()}>
              แชร์ลิงก์
            </Button>
          )}
          <Button className="flex-1" onClick={() => void copy()}>
            คัดลอกลิงก์
          </Button>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-[17rem] rounded-xl bg-white p-4 shadow-md">
        {svg ? (
          <div
            role="img"
            aria-label={`QR โต๊ะ ${tableCode}`}
            className="[&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
            // svg สร้างจากไลบรารี qrcode ของเราเอง ไม่ได้มาจากข้อมูลผู้ใช้
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="grid aspect-square place-items-center text-xs text-ink-faint">กำลังสร้าง QR…</div>
        )}
      </div>

      {notice && (
        <p className="mt-3 animate-unroll rounded-lg border border-forest/30 bg-forest/10 p-2 text-center text-xs text-forest-deep">
          ✓ {notice}
        </p>
      )}

      <ul className="mt-4 space-y-1.5 text-xs text-ink-soft">
        <li className="flex gap-2">
          <Icon name="qr" className="h-4 w-4 shrink-0 text-gold-deep" />
          สแกนไม่ติด? เพิ่มความสว่างหน้าจอ แล้วถือห่างจากกล้องประมาณหนึ่งฝ่ามือ
        </li>
        <li className="flex gap-2">
          <Icon name="clock" className="h-4 w-4 shrink-0 text-gold-deep" />
          ใช้ได้เฉพาะรอบนี้ หมดอายุเมื่อชำระเงิน
        </li>
        <li className="flex gap-2 text-crimson-deep">
          <Icon name="users" className="h-4 w-4 shrink-0" />
          ใครสแกนได้ก็สั่งของเข้าบิลโต๊ะนี้ได้ — แชร์เฉพาะคนในโต๊ะ
        </li>
      </ul>
    </Modal>
  )
}
