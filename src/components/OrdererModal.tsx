import { useState } from 'react'
import { formatBaht } from '../domain/pricing'
import { Button, INPUT, Modal } from './ui'

export interface Orderer {
  id: string
  displayName: string
}

/** ค่าพิเศษของ dropdown — ไม่ชนกับ id ของใครเพราะ id เป็น uuid */
const SHARED = 'shared'

/**
 * ถามว่าใครเป็นคนสั่ง ก่อนส่งออเดอร์เข้าครัว
 *
 * เดิมเป็น dropdown ลอยอยู่หัวรายการเมนู ซึ่งคนสั่งมักเลื่อนผ่านไปโดยไม่ได้แตะ
 * แล้วออเดอร์ไปลงชื่อคนแรกของกลุ่มทั้งที่ไม่ใช่คนสั่ง — ตอนแยกบิลถึงค่อยรู้
 *
 * จึงย้ายมาถามตอนกดส่ง และ**ไม่ตั้งค่าเริ่มต้นไว้** ปุ่มยืนยันกดไม่ได้จนกว่า
 * จะเลือก ถ้าตั้งค่าไว้ให้เลยก็เท่ากับย้ายที่เกิดเหตุ ไม่ได้แก้ปัญหา
 *
 * ต้องถูกวางเป็นพี่น้องกับ Modal ของหน้าสั่งของ ไม่ใช่ซ้อนอยู่ข้างใน
 * เพราะกล่องนั้นมี transform ตอนเปิด ซึ่งทำให้ position: fixed ข้างใน
 * ไปยึดกับกล่องแทนที่จะยึดกับจอ
 */
export default function OrdererModal({
  people,
  count,
  total,
  busy = false,
  onPick,
  onClose,
}: {
  people: Orderer[]
  /** จำนวนรายการในตะกร้า แสดงให้เห็นว่ากำลังจะส่งอะไร */
  count: number
  total: number
  busy?: boolean
  /** null = แชร์ทั้งโต๊ะ หารกันตอนเช็คบิล */
  onPick: (ordererId: string | null) => void
  onClose: () => void
}) {
  const [choice, setChoice] = useState('')

  return (
    <Modal
      title="ใครเป็นคนสั่ง"
      hint={`${count} รายการ · ฿${formatBaht(total)}`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose} disabled={busy}>
            ย้อนกลับ
          </Button>
          <Button
            className="flex-1"
            variant="primary"
            disabled={busy || choice === ''}
            onClick={() => onPick(choice === SHARED ? null : choice)}
          >
            {busy ? 'กำลังส่ง…' : 'ยืนยันส่งเข้าครัว'}
          </Button>
        </div>
      }
    >
      <label className="text-xs font-medium text-ink-soft" htmlFor="orderer">
        ลงชื่อผู้สั่ง
      </label>
      <select
        id="orderer"
        value={choice}
        disabled={busy}
        onChange={(e) => setChoice(e.target.value)}
        className={`${INPUT} mt-1`}
      >
        {/* ไม่มีค่าเริ่มต้น — บังคับให้เลือกจริง ไม่ใช่กดผ่าน */}
        <option value="">— เลือกผู้สั่ง —</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
        <option value={SHARED}>
          แชร์ทั้งโต๊ะ{people.length > 0 ? ` (หารเท่ากัน ${people.length} คน)` : ''}
        </option>
      </select>

      <p className="mt-2 text-xs text-ink-faint">
        {choice === SHARED
          ? 'รายการนี้จะหารเท่ากันในกลุ่มตอนเช็คบิล'
          : 'ลงชื่อไว้เพื่อให้แยกบิลได้ว่าใครสั่งอะไร'}
      </p>

      {people.length === 0 && (
        <p className="mt-3 rounded-lg bg-parchment-deep/60 p-3 text-sm text-ink-faint">
          ยังไม่มีใครอยู่ในโต๊ะนี้ สั่งแบบแชร์ทั้งโต๊ะได้อย่างเดียว
        </p>
      )}
    </Modal>
  )
}
