import { useEffect, useState } from 'react'
import { guestUrl, toQrDataUrl } from '../lib/qr'
import { Modal } from './ui'

/**
 * QR ของโต๊ะ สำหรับยื่นให้ลูกค้าสแกนตอนเช็คอิน
 *
 * ใช้ token เดิมของโต๊ะ ไม่สร้างใหม่ — ถ้าสร้างใหม่ทุกครั้งที่เปิดโต๊ะ
 * QR ที่ปริ้นท์ติดโต๊ะไว้จะใช้ไม่ได้ทันที ต้องปริ้นท์ใหม่ทุกรอบ
 * (ถ้าสงสัยว่า QR หลุดออกนอกร้าน มีปุ่มให้พนักงานเปลี่ยน token ที่หน้า QR โต๊ะ)
 */
export default function TableQRModal({
  tableCode,
  token,
  onClose,
}: {
  tableCode: string
  token: string
  onClose: () => void
}) {
  const [img, setImg] = useState('')

  useEffect(() => {
    let alive = true
    void toQrDataUrl(guestUrl(token)).then((d) => alive && setImg(d))
    return () => {
      alive = false
    }
  }, [token])

  return (
    <Modal title={`QR โต๊ะ ${tableCode}`} hint="ให้ทุกคนในกลุ่มสแกน" onClose={onClose}>
      <div className="flex flex-col items-center gap-4">
        {img ? (
          <img src={img} alt={`QR โต๊ะ ${tableCode}`} className="w-60 rounded-xl border border-line" />
        ) : (
          <div className="grid h-60 w-60 place-items-center text-sm text-ink-faint">กำลังสร้าง…</div>
        )}

        <ol className="w-full space-y-1.5 text-sm text-ink-soft">
          <li>1. ให้ลูกค้าสแกนด้วยกล้องมือถือ</li>
          <li>2. แต่ละคนลงชื่อตัวเองครั้งเดียว</li>
          <li>3. สั่งของได้เลย ไม่ต้องเรียกพนักงาน</li>
        </ol>

        <p className="text-center text-xs text-ink-faint">
          QR นี้ใช้ได้เฉพาะตอนโต๊ะเปิดอยู่ · ปิดบิลแล้วสั่งอะไรไม่ได้อีก
        </p>
      </div>
    </Modal>
  )
}
