/**
 * โมเดลโดเมนของร้านบอร์ดเกม
 *
 * หลักการที่ต้องไม่ลืม:
 *   - หน่วยคิดค่าเล่นคือ GuestPass (รายคน) ไม่ใช่โต๊ะ
 *   - Table เป็นทรัพยากรที่ Visit ยืมใช้ผ่าน Occupancy (ย้ายโต๊ะได้โดยบิลไม่กระทบ)
 *   - ทุก BillLine รู้ว่าเป็นของ pass ไหน จึงแยกบิลได้
 */

export type ID = string
/** ISO-8601 เสมอ เวลาอ้างอิงจากเซิร์ฟเวอร์ ไม่ใช่นาฬิกาเครื่องลูกข่าย */
export type Timestamp = string

// ---------- โต๊ะ ----------

export type TableStatus = 'free' | 'reserved' | 'occupied' | 'cleaning'

export interface CafeTable {
  id: ID
  code: string
  zone: string
  seatMin: number
  seatMax: number
  /** อนุญาตให้ 2 กลุ่มที่ไม่รู้จักกันนั่งโต๊ะเดียวกัน (โต๊ะยาว/เคาน์เตอร์) */
  allowShare: boolean
  status: TableStatus
  /** token ใน QR ที่ติดโต๊ะ — พนักงานเท่านั้นที่อ่านได้ */
  qrToken?: string
}

// ---------- Visit = กลุ่มที่มาด้วยกัน ----------

export type VisitStatus = 'open' | 'billing' | 'paid' | 'closed' | 'void'

export interface Visit {
  id: ID
  code: string
  source: 'walkin' | 'reservation'
  status: VisitStatus
  openedAt: Timestamp
  closedAt: Timestamp | null
  /** ตัดรอบขายตามวันทำการ ไม่ใช่วันที่ปฏิทิน (ร้านปิดหลังเที่ยงคืน) */
  businessDate: string
  note?: string
}

/** ประวัติการครองโต๊ะ — ย้ายโต๊ะ = ปิดแถวเดิม เปิดแถวใหม่ */
export interface Occupancy {
  id: ID
  visitId: ID
  tableId: ID
  fromAt: Timestamp
  toAt: Timestamp | null
}

// ---------- GuestPass = หน่วยคิดค่าเล่น ----------

export type PassStatus = 'active' | 'paused' | 'checked_out' | 'billed'

export interface GuestPass {
  id: ID
  visitId: ID
  displayName: string
  ratePlanId: ID
  status: PassStatus
  checkedInAt: Timestamp
  checkedOutAt: Timestamp | null
  /** นาทีที่ถูกหักออกตอน pause (ออกไปข้างนอกชั่วคราว) */
  pausedMinutes: number
  /** เวลาที่เริ่ม pause ครั้งล่าสุด — null ถ้าไม่ได้ pause อยู่ */
  pausedAt: Timestamp | null
}

// ---------- เมนู / ออเดอร์ ----------

export interface MenuItem {
  id: ID
  sku: string
  name: string
  category: 'drink' | 'snack' | 'food' | 'dessert'
  price: number
  available: boolean
}

export type OrderStatus =
  | 'placed' | 'accepted' | 'preparing' | 'ready' | 'served'
  | 'rejected' | 'cancelled'

export interface OrderLine {
  id: ID
  menuItemId: ID
  nameSnapshot: string
  /** ราคา ณ เวลาสั่ง — ห้าม join ราคาปัจจุบันตอนออกบิล */
  unitPriceSnapshot: number
  qty: number
  note?: string
}

export interface Order {
  id: ID
  visitId: ID
  /** ใครสั่ง — null = สั่งรวมทั้งโต๊ะ (แชร์กัน) */
  orderedByPassId: ID | null
  placedBy: 'guest' | 'staff'
  /** แชร์ = ตอนแยกบิลหารตามจำนวน pass ที่ active ณ เวลาสั่ง */
  splitMode: 'owner' | 'shared'
  tableIdSnapshot: ID | null
  status: OrderStatus
  placedAt: Timestamp
  lines: OrderLine[]
}

// ---------- เกม ----------

export interface GameTitle {
  id: ID
  name: string
  minPlayers: number
  maxPlayers: number
  playMinutes: number
  weight: 1 | 2 | 3 | 4 | 5
  copies: number
  onLoan: number
}

export interface GameLoan {
  id: ID
  visitId: ID
  gameTitleId: ID
  outAt: Timestamp
  returnedAt: Timestamp | null
  status: 'out' | 'returned' | 'returned_incomplete'
  penalty?: number
}

// ---------- ราคา ----------

export interface RatePlan {
  id: ID
  name: string
  pricePerHour: number
  /** ปัดเวลาขึ้นเป็นช่วงละกี่นาที */
  roundToMinutes: number
  /** ชั่วโมงแรกคิดเต็มเสมอ */
  minimumMinutes: number
  /** เพดานเหมาจ่ายทั้งวัน — ระบบเลือกราคาที่ถูกกว่าให้ลูกค้าเอง */
  dayPassCap: number | null
}

// ---------- บิล ----------

export type BillLineSource = 'play_time' | 'order_item' | 'game_penalty' | 'adjustment'

export interface BillLine {
  id: ID
  source: BillLineSource
  sourceId: ID | null
  /** ของใคร — null = แชร์ทั้งโต๊ะ. นี่คือกุญแจของการแยกบิล */
  guestPassId: ID | null
  label: string
  qty: number
  unitPrice: number
  amount: number
}

export interface BillPreview {
  visitId: ID
  lines: BillLine[]
  subtotal: number
  serviceCharge: number
  vat: number
  total: number
  computedAt: Timestamp
}

// ---------- จอง ----------

export type ReservationStatus = 'pending' | 'confirmed' | 'seated' | 'no_show' | 'cancelled'

export interface Reservation {
  id: ID
  customerName: string
  phone: string
  partySize: number
  startAt: Timestamp
  durationMinutes: number
  zonePreference: string | null
  status: ReservationStatus
  tableIds: ID[]
  note?: string
}

// ---------- การชำระเงิน ----------

export type PaymentMethod = 'cash' | 'transfer'

export interface PaymentInput {
  method: PaymentMethod
  amount: number
  /** จ่ายแทน pass ไหนบ้าง — ว่าง = จ่ายรวมทั้งโต๊ะ */
  paidFor?: ID[]
}

// ---------- มุมมองฝั่งลูกค้า (สแกน QR) ----------

/** ลูกค้าเห็นเท่านี้ ไม่มีข้อมูลโต๊ะอื่นและไม่มี token หลุดกลับมา */
export interface GuestSession {
  tableCode: string
  zone: string
  /** null = โต๊ะยังไม่ได้เปิด ต้องแจ้งพนักงานก่อน */
  visitId: ID | null
  passes: { id: ID; displayName: string }[]
  menu: MenuItem[]
}

export interface GuestOrderLine {
  id: ID
  name: string
  qty: number
  amount: number
}

export interface GuestOrder {
  id: ID
  status: OrderStatus
  placedAt: Timestamp
  orderedByPassId: ID | null
  splitMode: 'owner' | 'shared'
  lines: GuestOrderLine[]
}
