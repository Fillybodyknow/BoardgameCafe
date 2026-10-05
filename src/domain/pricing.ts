import type {
  BillLine, BillPreview, GuestPass, Order, RatePlan, RateSnapshot, TaxConfig, Timestamp,
} from './types'

/**
 * ⚠️ ชั่วคราวเท่านั้น
 *
 * ตรรกะคิดเงินอยู่ฝั่ง client ตอนนี้เพราะยังไม่มี backend
 * ก่อนรับเงินจริงต้องย้ายไปเป็น Postgres function `calculate_bill(visit_id)`
 * แบบ SECURITY DEFINER แล้วให้หน้าจอเรียกผ่าน RPC เท่านั้น
 * — ไม่งั้นลูกค้าแก้ยอดบิลตัวเองได้จาก devtools
 *
 * ไฟล์นี้จะกลายเป็น "สเปกอ้างอิง" สำหรับเขียน SQL ฝั่งเซิร์ฟเวอร์
 */

/**
 * ใช้เมื่อยังโหลดค่าจริงจากร้านไม่ทัน เท่านั้น
 *
 * ค่าจริงอยู่ในตาราง tax_config และมากับ snapshot ทุกครั้ง — หน้าจอต้องส่ง
 * ค่านั้นเข้ามา ไม่งั้นตัวเลขบนจอจะไม่ตรงกับยอดที่ฐานข้อมูลคิดตอนปิดบิล
 */
export const TAX: TaxConfig = {
  serviceChargeRate: 0,
  vatRate: 0.07,
  vatIncluded: true,
}

const MS_PER_MIN = 60_000

/** นาทีที่คิดเงินได้ของ pass หนึ่งใบ ณ เวลา now */
export function billableMinutes(pass: GuestPass, now: Date): number {
  const start = new Date(pass.checkedInAt).getTime()
  const end = pass.checkedOutAt ? new Date(pass.checkedOutAt).getTime() : now.getTime()

  let paused = pass.pausedMinutes
  if (pass.pausedAt) {
    paused += Math.floor((now.getTime() - new Date(pass.pausedAt).getTime()) / MS_PER_MIN)
  }
  return Math.max(0, Math.floor((end - start) / MS_PER_MIN) - paused)
}

/**
 * ค่าเล่นของ pass หนึ่งใบ — ปัดขึ้นตามช่วง, คิดขั้นต่ำ, แล้วเทียบเพดานเหมาวัน
 *
 * รับได้ทั้ง RatePlan (เรตปัจจุบัน) และ RateSnapshot (เรตที่ pass ถือติดตัว)
 * เพราะสองอย่างนี้มีฟิลด์ที่ใช้คิดเงินเหมือนกัน
 */
export function playTimeCharge(minutes: number, plan: RatePlan | RateSnapshot): number {
  const charged = Math.max(minutes, plan.minimumMinutes)
  const blocks = Math.ceil(charged / plan.roundToMinutes)
  const raw = (blocks * plan.roundToMinutes / 60) * plan.pricePerHour
  // เลือกราคาที่ถูกกว่าให้ลูกค้าเสมอ
  return plan.dayPassCap !== null ? Math.min(raw, plan.dayPassCap) : raw
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/** ภาษีและค่าบริการคิดจากยอดรวม — รวมไว้ที่เดียวเพราะมีหลายที่ต้องใช้สูตรนี้ */
function applyTax(subtotal: number, tax: TaxConfig = TAX) {
  const serviceCharge = round2(subtotal * tax.serviceChargeRate)
  const base = subtotal + serviceCharge
  const vat = tax.vatIncluded
    ? round2(base - base / (1 + tax.vatRate))
    : round2(base * tax.vatRate)
  return {
    subtotal,
    serviceCharge,
    vat,
    total: tax.vatIncluded ? round2(base) : round2(base + vat),
  }
}

export interface BillInput {
  visitId: string
  passes: GuestPass[]
  orders: Order[]
  /** เผื่อไว้สำหรับ pass เก่าที่ยังไม่มี snapshot — ปกติไม่ได้ใช้แล้ว */
  ratePlans?: Record<string, RatePlan>
  /** ยอดของที่หารกันซึ่งคนที่กลับก่อนจ่ายไปแล้ว */
  sharedSettled?: number
  /** VAT/ค่าบริการที่เจ้าของร้านตั้งไว้ — ไม่ส่งมาจะใช้ค่าสำรองซึ่งอาจไม่ตรง */
  tax?: TaxConfig
  now: Date
}

/**
 * ยอดที่ "ยังค้างอยู่" ของโต๊ะ ไม่ใช่ยอดดิบทั้งหมด
 *
 * คนที่จ่ายแล้วกลับไป (status 'billed') ถูกตัดออกทั้งค่าเล่นและของที่สั่งเอง
 * ส่วนของที่หารกันยังแสดงเต็มจำนวนแล้วหักด้วยบรรทัดติดลบ เพื่อให้ไล่ตัวเลขได้
 * ว่าหายไปไหน — ต้องตรงกับ preview_bill() ฝั่ง SQL เป๊ะ ๆ ไม่งั้นโหมดจำลอง
 * จะหลวมกว่าของจริงแล้วบั๊กจะหลุดผ่านเทสต์ไปได้
 */
export function computeBill(input: BillInput): BillPreview {
  const { visitId, passes, orders, ratePlans, now } = input
  const sharedSettled = input.sharedSettled ?? 0
  const settledPasses = new Set(passes.filter((p) => p.status === 'billed').map((p) => p.id))
  const lines: BillLine[] = []

  // 1) ค่าเล่นรายคน — ใช้เรตที่ pass ถือติดตัวมา ไม่ใช่เรตปัจจุบันของร้าน
  for (const pass of passes) {
    if (settledPasses.has(pass.id)) continue
    const plan = pass.rate ?? ratePlans?.[pass.ratePlanId]
    if (!plan) continue
    const mins = billableMinutes(pass, now)
    const amount = playTimeCharge(mins, plan)
    lines.push({
      id: `bl-play-${pass.id}`,
      source: 'play_time',
      sourceId: pass.id,
      guestPassId: pass.id,
      label: `ค่าเล่น · ${pass.displayName} (${formatDuration(mins)})`,
      qty: 1,
      unitPrice: amount,
      amount,
    })
  }

  // 2) อาหาร/เครื่องดื่ม — ใช้ราคา snapshot ตอนสั่ง
  const countable: Order['status'][] = ['placed', 'accepted', 'preparing', 'ready', 'served']
  for (const order of orders) {
    if (!countable.includes(order.status)) continue
    // ของที่คนจ่ายแล้วสั่งเองอยู่ในบิลของเขาแล้ว แต่ของที่หารกันยังอยู่
    if (
      order.splitMode === 'owner' &&
      order.orderedByPassId !== null &&
      settledPasses.has(order.orderedByPassId)
    ) {
      continue
    }
    for (const line of order.lines) {
      const amount = round2(line.unitPriceSnapshot * line.qty)
      lines.push({
        id: `bl-ord-${line.id}`,
        source: 'order_item',
        sourceId: line.id,
        // splitMode 'shared' → guestPassId = null → ตอนแยกบิลหารเท่ากัน
        guestPassId: order.splitMode === 'shared' ? null : order.orderedByPassId,
        label: line.nameSnapshot,
        qty: line.qty,
        unitPrice: line.unitPriceSnapshot,
        amount,
      })
    }
  }

  // 3) หักส่วนที่คนกลับก่อนจ่ายไปแล้ว — แสดงเป็นบรรทัดติดลบ ไม่ลดตัวเลขเงียบ ๆ
  if (sharedSettled > 0) {
    lines.push({
      id: `bl-settled-${visitId}`,
      source: 'adjustment',
      sourceId: null,
      guestPassId: null,
      label: 'หักส่วนที่ชำระแล้ว',
      qty: 1,
      unitPrice: -sharedSettled,
      amount: -sharedSettled,
    })
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))

  return {
    visitId,
    lines,
    ...applyTax(subtotal, input.tax),
    computedAt: now.toISOString() as Timestamp,
  }
}

/**
 * ยอดที่คนหนึ่งต้องจ่ายถ้ากลับตอนนี้
 *
 * ต้องให้ผลเท่ากับ pass_settlement() ฝั่ง SQL — คนสุดท้ายที่เหลือรับเศษไป
 * ทั้งหมด ยอดรวมของทุกบิลย่อยจึงเท่ากับยอดเต็มเสมอ
 */
export function settlementFor(
  preview: BillPreview,
  passId: string,
  unsettledCount: number,
  tax?: TaxConfig,
) {
  const ownLines = preview.lines.filter((l) => l.guestPassId === passId)
  const ownTotal = round2(ownLines.reduce((s, l) => s + l.amount, 0))

  // บรรทัดไม่มีเจ้าของ = ของที่หารกัน รวมบรรทัดหักส่วนที่ชำระแล้วด้วย
  // จึงเป็นยอดสุทธิที่ยังไม่มีใครรับผิดชอบ
  const shared = round2(
    preview.lines.filter((l) => l.guestPassId === null).reduce((s, l) => s + l.amount, 0),
  )
  const sharedShare = unsettledCount <= 1 ? shared : round2(shared / unsettledCount)

  return {
    passId,
    ownLines,
    sharedShare,
    headcount: unsettledCount,
    ...applyTax(round2(ownTotal + sharedShare), tax),
    computedAt: preview.computedAt,
  }
}

/** แยกบิลตามเจ้าของบรรทัด — บรรทัดที่ guestPassId = null หารเท่ากัน */
export function splitByOwner(preview: BillPreview, passes: GuestPass[]) {
  const shared = preview.lines.filter((l) => l.guestPassId === null)
  const sharedTotal = shared.reduce((s, l) => s + l.amount, 0)
  const sharePerHead = passes.length > 0 ? sharedTotal / passes.length : 0

  return passes.map((pass, i) => {
    const own = preview.lines.filter((l) => l.guestPassId === pass.id)
    const ownTotal = own.reduce((s, l) => s + l.amount, 0)
    // เศษสตางค์ตกกับคนแรก เพื่อให้ผลรวมตรงกับยอดบิลเสมอ
    const remainder = i === 0
      ? round2(sharedTotal - round2(sharePerHead) * passes.length)
      : 0
    return {
      pass,
      ownLines: own,
      sharedShare: round2(sharePerHead) + remainder,
      total: round2(ownTotal + round2(sharePerHead) + remainder),
    }
  })
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} นาที`
  return m === 0 ? `${h} ชม.` : `${h} ชม. ${m} นาที`
}

export function formatBaht(n: number): string {
  return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
