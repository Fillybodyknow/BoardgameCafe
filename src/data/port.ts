import type {
  AvailableTable, BillPreview, BookingConfig, BookingLookup, BookingReceipt,
  CafeTable, GuestOrder, GuestPass, GuestSession, ID, MenuCategory,
  MenuItem, Occupancy, Order, OrderStatus, PassSettlement, PaymentInput, RatePlan, Reservation,
  Capability, ShopHours, ShopProfile, StaffMember, StaffRole, TaxConfig, Visit,
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
  ratePlans: RatePlan[]
  reservations: Reservation[]
  /** VAT/ค่าบริการที่ตั้งไว้ — หน้าจอต้องใช้ค่านี้คิดเลข ไม่ใช่ค่าตายตัวในโค้ด */
  tax: TaxConfig
  /** เวลาทำการรายวัน — ใช้บอกว่าตอนนี้ครัวเปิดอยู่ไหม */
  hours: ShopHours[]
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
  /** ลบคนที่ถูกสร้างผิด — ต่างจาก checkOutPass ที่แปลว่ากลับไปแล้วแต่ยังต้องจ่าย */
  voidPass(passId: ID): Promise<void>
  /** ยอดที่คนนี้ต้องจ่ายถ้ากลับตอนนี้ — ดูก่อนกดเก็บเงิน */
  passSettlement(passId: ID): Promise<PassSettlement>
  /** เก็บเงินคนที่กลับก่อน แล้วออกบิลย่อย — คนที่เหลือยังเล่นต่อได้ */
  settlePass(passId: ID, payments?: PaymentInput[]): Promise<void>
  moveVisitToTables(visitId: ID, tableIds: ID[]): Promise<void>
  /** ปิดบิล พร้อมบันทึกการชำระเงิน (ว่าง = ปิดโดยยังไม่เก็บเงิน) */
  closeVisit(visitId: ID, payments?: PaymentInput[]): Promise<void>
  /** เปลี่ยน token ของโต๊ะ ใช้เมื่อสงสัยว่า QR หลุดออกนอกร้าน */
  /** ออก QR ใหม่ให้รอบที่ยังเปิดอยู่ — ใบเดิมใช้ไม่ได้ทันที */
  rotateVisitToken(visitId: ID): Promise<string>

  // --- การจอง (ฝั่งพนักงาน) ---
  confirmReservation(id: ID): Promise<void>
  rejectReservation(id: ID, reason?: string): Promise<void>
  markNoShow(id: ID): Promise<void>
  /** เช็คอินลูกค้าที่จอง — tableIds ใส่มาเพื่อย้ายโต๊ะตอนเช็คอิน */
  seatReservation(
    id: ID,
    guests: { name: string; ratePlanId: ID }[],
    tableIds?: ID[],
  ): Promise<Visit>

  // --- Order ---
  placeOrder(input: {
    idempotencyKey: string
    visitId: ID
    orderedByPassId: ID | null
    splitMode: 'owner' | 'shared'
    placedBy: 'guest' | 'staff'
    items: { menuItemId: ID; qty: number; note?: string }[]
    /** พนักงานยืนยันว่าครัวยังทำให้ได้ ทั้งที่เลยเวลาปิดครัวแล้ว */
    allowClosedKitchen?: boolean
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
/**
 * จองโต๊ะออนไลน์ — ลูกค้าไม่ได้ล็อกอิน
 *
 * ต่างจาก GuestPort ตรงที่ยังไม่มี token ของโต๊ะ (ยังไม่ได้มาร้าน)
 * จึงยืนยันตัวด้วยรหัสจอง + เบอร์โทรแทน
 */
export interface BookingPort {
  hours(): Promise<ShopHours[]>
  config(): Promise<BookingConfig>
  /** ผังโต๊ะพร้อมสถานะว่างของช่วงเวลาที่เลือก */
  availableTables(startAt: string, durationMinutes: number): Promise<AvailableTable[]>
  create(input: {
    customerName: string
    phone: string
    partySize: number
    startAt: string
    durationMinutes: number
    tableIds: ID[]
    note?: string
  }): Promise<BookingReceipt>
  lookup(code: string, phone: string): Promise<BookingLookup>
  cancel(code: string, phone: string): Promise<void>
}

/**
 * ตั้งค่าร้าน — ระดับผู้จัดการขึ้นไป
 *
 * แยกจาก DataPort เพราะเป็นคนละสิทธิ์ และหน้าจอที่เรียกก็คนละหน้า
 * ทุก method ยังผ่าน assert_manager() ฝั่งฐานข้อมูลอีกชั้น
 */
export interface AdminPort {
  /** บอกว่าผู้ใช้ปัจจุบันเป็นระดับไหน — null = ไม่ได้อยู่ในทะเบียนพนักงาน */
  myRole(): Promise<StaffRole | null>
  /** สิทธิ์ที่ผู้ใช้ปัจจุบันมี — หน้าจอใช้ซ่อนเมนูที่กดไปก็โดนปฏิเสธ */
  myCapabilities(): Promise<Capability[]>

  /** รวมของที่เก็บเข้ากรุแล้วด้วย ต่างจาก snapshot ที่หน้าร้านใช้ */
  allMenuItems(): Promise<MenuItem[]>
  allTables(): Promise<CafeTable[]>
  allRatePlans(): Promise<RatePlan[]>
  shopHours(): Promise<ShopHours[]>
  taxConfig(): Promise<TaxConfig>

  saveMenuItem(input: {
    id: ID | null
    sku: string
    name: string
    category: MenuCategory
    price: number
    available: boolean
    sortOrder: number
  }): Promise<void>
  /** ไม่ลบจริง เพราะใบเสร็จเก่าอ้างถึงอยู่ */
  archiveMenuItem(id: ID, archived: boolean): Promise<void>
  /** อัปโหลดรูปที่ย่อแล้ว และเก็บกวาดไฟล์เดิมให้ด้วย */
  uploadMenuImage(id: ID, image: { blob: Blob; dataUrl: string }): Promise<void>
  removeMenuImage(id: ID): Promise<void>
  /** รูปบรรยากาศโต๊ะ — ลูกค้าใช้ตัดสินใจตอนจอง */
  uploadTableImage(id: ID, image: { blob: Blob; dataUrl: string }): Promise<void>
  removeTableImage(id: ID): Promise<void>

  saveTable(input: {
    id: ID | null
    code: string
    zone: string
    seatMin: number
    seatMax: number
    allowShare: boolean
    sortOrder: number
  }): Promise<void>
  archiveTable(id: ID, archived: boolean): Promise<void>

  saveRatePlan(input: {
    id: ID | null
    name: string
    pricePerHour: number
    roundToMinutes: number
    minimumMinutes: number
    dayPassCap: number | null
    active: boolean
    sortOrder: number
  }): Promise<void>

  saveShopHours(input: {
    weekday: number
    openTime: string
    closeTime: string
    closed: boolean
    /** null = ครัวปิดพร้อมร้าน */
    kitchenCloseTime: string | null
  }): Promise<void>
  saveTaxConfig(input: TaxConfig): Promise<void>

  // --- บัญชีพนักงาน ---
  listStaff(): Promise<StaffMember[]>
  /**
   * สร้างบัญชีใหม่
   *
   * ต้องผ่าน Edge Function เพราะการสร้างบัญชี Auth ใช้ service_role key
   * ซึ่งอยู่ในเว็บ static ไม่ได้
   */
  createStaff(input: {
    username: string
    password: string
    displayName: string
    role: StaffRole
  }): Promise<void>
  setStaffRole(userId: ID, role: StaffRole): Promise<void>
  setStaffActive(userId: ID, active: boolean): Promise<void>
  renameStaff(userId: ID, name: string): Promise<void>

  /** ชื่อร้านและโลโก้ — เฉพาะเจ้าของร้าน (สิทธิ์ branding) */
  saveShopProfile(input: { name: string; tagline: string }): Promise<void>
  /** อัปโหลดโลโก้ที่ย่อแล้ว และเก็บกวาดไฟล์เดิมให้ด้วย */
  uploadShopLogo(image: { blob: Blob; dataUrl: string }): Promise<void>
  removeShopLogo(): Promise<void>
}

export interface GuestPort {
  session(token: string): Promise<GuestSession>
  /** ลูกค้าลงชื่อตัวเองหลังสแกน QR — คืน pass ให้เครื่องจำไว้ */
  register(token: string, name: string): Promise<{ passId: ID; displayName: string }>
  /**
   * รับชื่อที่พนักงานสร้างไว้ตอนเปิดโต๊ะ (เช่น "ผู้เล่น 2") แทนการสร้างคนใหม่
   * name ว่าง = ใช้ชื่อเดิม
   */
  claim(token: string, passId: ID, name?: string): Promise<{ passId: ID; displayName: string }>
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

/**
 * ชื่อร้านและโลโก้ — อ่านได้โดยไม่ต้องล็อกอิน
 * หน้าล็อกอิน หน้าจอง และหน้าลูกค้าสแกน QR ต้องใช้ก่อนที่จะมีใครล็อกอิน
 */
export interface ShopPort {
  profile(): Promise<ShopProfile>
}
