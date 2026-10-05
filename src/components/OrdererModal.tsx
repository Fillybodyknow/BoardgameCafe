import { formatBaht } from '../domain/pricing'
import { Button, Modal } from './ui'

export interface Orderer {
  id: string
  displayName: string
}

/**
 * ถามว่าใครเป็นคนสั่ง ก่อนส่งออเดอร์เข้าครัว
 *
 * แยกออกมาจากหน้าสั่งของ เพราะเดิมเป็น dropdown ลอยอยู่หัวรายการเมนู
 * ซึ่งคนสั่งมักเลื่อนผ่านไปโดยไม่ได้แตะ แล้วออเดอร์ไปลงชื่อคนแรกของกลุ่ม
 * ทั้งที่ไม่ใช่คนสั่ง — ตอนแยกบิลถึงค่อยรู้ว่าผิด ซึ่งสายไปแล้ว
 *
 * ถามตอนกดส่งจึงข้ามไม่ได้ และกดชื่อเดียวจบ ไม่ต้องกดยืนยันซ้ำ เพราะ
 * การกดปุ่มส่งเข้าครัวก่อนหน้านี้คือการยืนยันไปแล้วรอบหนึ่ง
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
  return (
    <Modal
      title="ใครเป็นคนสั่ง"
      hint={`${count} รายการ · ฿${formatBaht(total)}`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <Button className="w-full" onClick={onClose} disabled={busy}>
          ย้อนกลับไปแก้รายการ
        </Button>
      }
    >
      <p className="mb-3 text-xs text-ink-faint">
        เลือกแล้วส่งเข้าครัวทันที · ลงชื่อไว้เพื่อให้แยกบิลได้ตอนจ่ายเงิน
      </p>

      <div className="space-y-2">
        {people.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(p.id)}
            className="pick flex w-full items-center gap-3 px-4 py-3 text-left font-semibold disabled:opacity-50"
          >
            <span className="shield h-9 w-7 shrink-0 bg-forest text-sm text-vellum" aria-hidden>
              {initialOf(p.displayName)}
            </span>
            {p.displayName}
          </button>
        ))}

        {people.length === 0 && (
          <p className="rounded-lg bg-parchment-deep/60 p-3 text-sm text-ink-faint">
            ยังไม่มีใครอยู่ในโต๊ะนี้ สั่งแบบแชร์ทั้งโต๊ะได้อย่างเดียว
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => onPick(null)}
          className="pick w-full px-4 py-3 text-left disabled:opacity-50"
        >
          <span className="font-semibold">แชร์ทั้งโต๊ะ</span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            {people.length > 0 ? `หารเท่ากัน ${people.length} คน` : 'หารกันตอนเช็คบิล'}
          </span>
        </button>
      </div>

      {busy && <p className="mt-3 text-center text-sm text-ink-faint">กำลังส่งเข้าครัว…</p>}
    </Modal>
  )
}

/** อักษรแรกของชื่อสำหรับโล่ — ข้ามสระหน้า (เ แ โ ใ ไ) ไม่งั้น "เมย์" ได้ "เ" */
function initialOf(name: string) {
  return [...name].find((ch) => !'เแโใไ'.includes(ch)) ?? name.slice(0, 1)
}
