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
  sortOrder?: number
  /** เก็บเข้ากรุ — ไม่ลบจริงเพราะ occupancies/orders อ้างถึงอยู่ */
  archived?: boolean
  /**
   * token ของสติกเกอร์ QR ติดโต๊ะแบบเก่า — เลิกใช้สั่งของแล้ว (ดู Visit.qrToken)
   * เก็บไว้ให้สติกเกอร์ที่ยังติดอยู่บอกลูกค้าว่าต้องขอ QR จากพนักงาน
   */
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
  /** ยอดของที่หารกันซึ่งคนที่กลับก่อนจ่ายไปแล้ว */
  sharedSettled: number
  /**
   * token ใน QR ที่พิมพ์ให้ลูกค้าตอนเปิดโต๊ะ — หนึ่งรอบหนึ่งใบ ตามกลุ่มไปเมื่อย้ายโต๊ะ
   * และใช้ไม่ได้ทันทีที่ปิดบิล พนักงานเท่านั้นที่อ่านได้
   */
  qrToken?: string
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
  /** เครื่องลูกค้ามารับชื่อนี้ไปแล้ว (ลงชื่อเอง หรือแตะเลือกชื่อที่พนักงานสร้างไว้) */
  claimedAt?: Timestamp | null
  /**
   * เรตค่าเล่น ณ เวลาเช็คอิน
   *
   * คัดลอกมาเก็บไว้เหมือนที่ order_lines ทำกับราคาอาหาร ไม่งั้นเจ้าของร้าน
   * ขึ้นราคาตอนบ่าย บิลของทุกคนที่กำลังนั่งอยู่จะเปลี่ยนย้อนหลังทั้งเซสชัน
   */
  rate: RateSnapshot
}

/** ค่าที่ใช้คิดค่าเล่นจริง คัดลอกจาก RatePlan ตอนเช็คอิน */
export interface RateSnapshot {
  name: string
  pricePerHour: number
  roundToMinutes: number
  minimumMinutes: number
  dayPassCap: number | null
}

// ---------- เมนู / ออเดอร์ ----------

export type MenuCategory = 'drink' | 'snack' | 'food' | 'dessert'

export interface MenuItem {
  id: ID
  sku: string
  name: string
  category: MenuCategory
  price: number
  available: boolean
  sortOrder?: number
  /** เก็บเข้ากรุ — ไม่ลบจริงเพราะ order_lines อ้างถึงอยู่ */
  archived?: boolean
  /**
   * path ในถัง menu-images เช่น "menu/abc123.jpg"
   * เก็บ path ไม่ใช่ URL เต็ม เพราะโดเมนของโปรเจกต์เปลี่ยนได้
   * (โหมดเดโมเก็บเป็น data URL ตรง ๆ)
   */
  imagePath?: string | null
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
  active?: boolean
  sortOrder?: number
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
  /** รหัสที่ลูกค้าใช้เปิดดู/ยกเลิกเอง (คู่กับเบอร์โทร) */
  code: string | null
  source: 'staff' | 'online'
  customerName: string
  phone: string
  partySize: number
  startAt: Timestamp
  durationMinutes: number
  zonePreference: string | null
  status: ReservationStatus
  tableIds: ID[]
  visitId: ID | null
  note?: string
  staffNote?: string
}

// ---------- จองออนไลน์ (ฝั่งลูกค้า) ----------

export interface AvailableTable {
  id: ID
  code: string
  zone: string
  seatMin: number
  seatMax: number
  allowShare: boolean
  available: boolean
}

export interface ShopHours {
  weekday: number
  openTime: string
  closeTime: string
  closed: boolean
  /** null = ครัวปิดพร้อมร้าน */
  kitchenCloseTime: string | null
}

/** ครัวเปิดอยู่ไหม — ต้องตรงกับ kitchen_window() ฝั่ง SQL */
export interface KitchenWindow {
  open: boolean
  /** เวลาที่ครัวปิดของวันนั้น เช่น "22:00" */
  closeAt: string | null
  /** เหตุผลที่ปิด สำหรับแสดงให้ผู้ใช้ — null เมื่อเปิดอยู่ */
  reason: string | null
}

/** หมวดที่ต้องให้ครัวทำ — ต้องตรงกับ needs_kitchen() ฝั่ง SQL */
export const KITCHEN_CATEGORIES: MenuCategory[] = ['food', 'dessert']

export interface BookingConfig {
  slotMinutes: number
  defaultDurationMinutes: number
  minDurationMinutes: number
  maxDurationMinutes: number
  maxAdvanceDays: number
  minAdvanceMinutes: number
}

/** ใบยืนยันที่ลูกค้าได้หลังจอง */
export interface BookingReceipt {
  code: string
  status: ReservationStatus
  startAt: Timestamp
  durationMinutes: number
  tables: string[]
}

export interface BookingLookup extends BookingReceipt {
  customerName: string
  partySize: number
  note?: string | null
}

// ---------- การชำระเงิน ----------

export type PaymentMethod = 'cash' | 'transfer'

/** ยอดของคนที่จะกลับก่อน — ต้องตรงกับ pass_settlement() ฝั่ง SQL */
export interface PassSettlement {
  passId: ID
  displayName?: string
  ownLines: BillLine[]
  /** ส่วนแบ่งของรายการที่หารกัน */
  sharedShare: number
  /** จำนวนคนที่ยังไม่ได้จ่าย ณ ตอนคิด */
  headcount: number
  subtotal: number
  serviceCharge: number
  vat: number
  total: number
  computedAt: Timestamp
}

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
  /** null = สั่งไม่ได้ — ดู ended ว่าเพราะปิดบิลแล้ว หรือเป็น QR ติดโต๊ะแบบเก่า */
  visitId: ID | null
  /** true = รอบนี้ปิดบิลไปแล้ว */
  ended?: boolean
  /** claimed = มีเครื่องลูกค้ารับชื่อนี้ไปแล้ว — หน้าลงชื่อให้เลือกได้เฉพาะใบที่ยังว่าง */
  passes: { id: ID; displayName: string; claimed?: boolean }[]
  menu: MenuItem[]
  kitchen: KitchenWindow
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

// ---------- ตั้งค่าร้าน (เจ้าของ/ผู้จัดการ) ----------

/**
 * สิทธิ์ย่อย — ระดับพนักงานคือชุดสำเร็จของสิทธิ์เหล่านี้
 *
 * เก็บชุดไว้ในตาราง role_capabilities ฝั่งฐานข้อมูล ปรับได้โดยไม่ต้องแก้โค้ด
 */
export type Capability = 'floor' | 'kitchen' | 'settings' | 'accounts'

export type StaffRole = 'floor' | 'kitchen' | 'staff' | 'manager' | 'owner'

export interface StaffMember {
  userId: ID
  /** ชื่อที่ใช้ล็อกอิน */
  username: string
  displayName: string
  role: StaffRole
  active: boolean
  /** อีเมลภายในที่ผูกกับบัญชี พนักงานไม่ได้ใช้ล็อกอิน */
  email: string
  createdAt: Timestamp
  /** ตัวเราเอง — หน้าจอใช้ปิดปุ่มที่ทำกับตัวเองไม่ได้ */
  isSelf: boolean
}

export interface TaxConfig {
  serviceChargeRate: number
  vatRate: number
  /** true = ราคาที่แสดงรวม VAT แล้ว */
  vatIncluded: boolean
}
