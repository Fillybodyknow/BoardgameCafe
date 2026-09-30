import type {
  BillPreview, CafeTable, GameTitle, GuestOrder, GuestPass, GuestSession, ID,
  MenuItem, Occupancy, Order, OrderStatus, PaymentInput, RatePlan, Reservation, Visit,
} from '../domain/types'

/**
 * สัญญาระหว่างหน้าจอกับแหล่งข้อมูล
 *
 * ตอนนี้มี implementation เดียวคือ MockAdapter (ในหน่วยความจำ + localStorage)
 * เมื่อสมัคร Supabase แล้ว เขียน SupabaseAdapter ให้ implement interface นี้
 * แล้วสลับใน data/index.ts — หน้าจอไม่ต้องแก้แม้แต่บรรทัดเดียว
 *
 * ทุก method ที่สร้างเงิน/ออเดอร์รับ idempotencyKey เพราะเน็ตร้านหลุดบ่อย
 * และมือถือจะ retry เอง
 */
export interface Snapshot {
  tables: CafeTable[]
  visits: Visit[]
  occupancies: Occupancy[]
  passes: GuestPass[]
  orders: Order[]
  menu: MenuItem[]
  games: GameTitle[]
  ratePlans: RatePlan[]
  reservations: Reservation[]
}

export interface DataPort {
  /** ดึงสถานะทั้งร้าน — ของจริงจะแตกเป็น query ย่อย + realtime channel */
  getSnapshot(): Promise<Snapshot>
  /** แจ้งเมื่อข้อมูลเปลี่ยน (ของจริง = Supabase Realtime) คืนฟังก์ชันยกเลิก */
  subscribe(listener: () => void): () => void

  // --- Visit / Pass ---
  openVisit(input: { tableIds: ID[]; guests: { name: string; ratePlanId: ID }[] }): Promise<Visit>
  addPass(visitId: ID, input: { name: string; ratePlanId: ID }): Promise<GuestPass>
  pausePass(passId: ID): Promise<void>
  resumePass(passId: ID): Promise<void>
  checkOutPass(passId: ID): Promise<void>
  moveVisitToTables(visitId: ID, tableIds: ID[]): Promise<void>
  /** ปิดบิล พร้อมบันทึกการชำระเงิน (ว่าง = ปิดโดยยังไม่เก็บเงิน) */
  closeVisit(visitId: ID, payments?: PaymentInput[]): Promise<void>
  /** เปลี่ยน token ของโต๊ะ ใช้เมื่อสงสัยว่า QR หลุดออกนอกร้าน */
  rotateTableToken(tableId: ID): Promise<string>

  // --- Order ---
  placeOrder(input: {
    idempotencyKey: string
    visitId: ID
    orderedByPassId: ID | null
    splitMode: 'owner' | 'shared'
    placedBy: 'guest' | 'staff'
    items: { menuItemId: ID; qty: number; note?: string }[]
  }): Promise<Order>
  updateOrderStatus(orderId: ID, status: OrderStatus): Promise<void>

  // --- Bill ---
  /** ยอดเรียลไทม์ ไม่ commit — ของจริงต้องเป็น RPC ฝั่งเซิร์ฟเวอร์ */
  previewBill(visitId: ID, now?: Date): Promise<BillPreview>
}

/**
 * สิ่งที่ลูกค้าเรียกได้หลังสแกน QR — ไม่ต้องล็อกอิน
 *
 * แยกจาก DataPort โดยตั้งใจ เพราะเป็นคนละผู้ใช้และคนละระดับสิทธิ์
 * ทุก method รับ token แทน visitId — ลูกค้าจึงอ้างถึงโต๊ะอื่นไม่ได้เลย
 * แม้จะแก้ค่าที่ส่งไปก็ตาม
 */
export interface GuestPort {
  session(token: string): Promise<GuestSession>
  orders(token: string): Promise<GuestOrder[]>
  bill(token: string): Promise<BillPreview>
  placeOrder(input: {
    token: string
    idempotencyKey: string
    orderedByPassId: ID | null
    splitMode: 'owner' | 'shared'
    items: { menuItemId: ID; qty: number; note?: string }[]
  }): Promise<{ orderId: ID; status: OrderStatus }>
}
