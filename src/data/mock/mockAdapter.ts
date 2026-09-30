import type { DataPort, GuestPort, Snapshot } from '../port'
import type {
  BillPreview, GuestOrder, GuestPass, GuestSession, ID, Order, OrderStatus,
  PaymentInput, RatePlan, Visit,
} from '../../domain/types'
import { computeBill } from '../../domain/pricing'
import { seed, businessDateOf } from './seed'

const STORAGE_KEY = 'bgcafe.mock.v1'

/**
 * Adapter จำลอง — เก็บใน localStorage เพื่อให้เดโมรอดการรีเฟรช
 *
 * ตั้งใจให้ "โง่" และอ่านง่าย เพราะของจริงตรรกะพวกนี้จะย้ายไปฝั่ง Postgres
 * หน้าที่เดียวของมันคือพิสูจน์ว่า DataPort ครอบคลุมสิ่งที่หน้าจอต้องใช้จริง
 */
class MockAdapter implements DataPort {
  private state: Snapshot
  private listeners = new Set<() => void>()
  /** กัน retry ซ้ำ — ของจริงใช้ unique index บนคอลัมน์ idempotency_key */
  private seenKeys = new Map<string, Order>()

  constructor() {
    this.state = load() ?? seed()
  }

  private commit() {
    save(this.state)
    this.listeners.forEach((fn) => fn())
  }

  async getSnapshot(): Promise<Snapshot> {
    return structuredClone(this.state)
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---------- Visit / Pass ----------

  async openVisit(input: { tableIds: ID[]; guests: { name: string; ratePlanId: ID }[] }) {
    const nowIso = new Date().toISOString()
    const seq = this.state.visits.length + 14
    const visit: Visit = {
      id: newId('v'),
      code: `V-${String(seq).padStart(3, '0')}`,
      source: 'walkin',
      status: 'open',
      openedAt: nowIso,
      closedAt: null,
      businessDate: businessDateOf(new Date()),
    }
    this.state.visits.push(visit)

    for (const tableId of input.tableIds) {
      this.state.occupancies.push({
        id: newId('o'), visitId: visit.id, tableId, fromAt: nowIso, toAt: null,
      })
      const table = this.state.tables.find((t) => t.id === tableId)
      if (table) table.status = 'occupied'
    }

    for (const guest of input.guests) {
      this.state.passes.push(makePass(visit.id, guest.name, guest.ratePlanId, nowIso))
    }

    this.commit()
    return structuredClone(visit)
  }

  async addPass(visitId: ID, input: { name: string; ratePlanId: ID }) {
    // เข้ากลางคัน — นาฬิกาเริ่มนับ ณ ตอนนี้ เฉพาะคนนี้
    const pass = makePass(visitId, input.name, input.ratePlanId, new Date().toISOString())
    this.state.passes.push(pass)
    this.commit()
    return structuredClone(pass)
  }

  async pausePass(passId: ID) {
    const pass = this.mustPass(passId)
    if (pass.status !== 'active') return
    pass.status = 'paused'
    pass.pausedAt = new Date().toISOString()
    this.commit()
  }

  async resumePass(passId: ID) {
    const pass = this.mustPass(passId)
    if (pass.status !== 'paused' || !pass.pausedAt) return
    const elapsed = Math.floor((Date.now() - new Date(pass.pausedAt).getTime()) / 60_000)
    pass.pausedMinutes += Math.max(0, elapsed)
    pass.pausedAt = null
    pass.status = 'active'
    this.commit()
  }

  async checkOutPass(passId: ID) {
    const pass = this.mustPass(passId)
    if (pass.status === 'checked_out' || pass.status === 'billed') return
    // กลับก่อนขณะ pause อยู่ → เก็บนาทีที่ค้างก่อน ไม่งั้นเวลาหาย
    if (pass.pausedAt) {
      pass.pausedMinutes += Math.max(0, Math.floor((Date.now() - new Date(pass.pausedAt).getTime()) / 60_000))
      pass.pausedAt = null
    }
    pass.checkedOutAt = new Date().toISOString()
    pass.status = 'checked_out'
    this.commit()
  }

  async moveVisitToTables(visitId: ID, tableIds: ID[]) {
    const nowIso = new Date().toISOString()
    // ปิด occupancy เดิม แล้วเปิดใหม่ — ประวัติยังอยู่ครบ บิลไม่กระทบ
    for (const occ of this.state.occupancies) {
      if (occ.visitId === visitId && occ.toAt === null) {
        occ.toAt = nowIso
        const old = this.state.tables.find((t) => t.id === occ.tableId)
        if (old) old.status = 'cleaning'
      }
    }
    for (const tableId of tableIds) {
      this.state.occupancies.push({ id: newId('o'), visitId, tableId, fromAt: nowIso, toAt: null })
      const table = this.state.tables.find((t) => t.id === tableId)
      if (table) table.status = 'occupied'
    }
    this.commit()
  }

  async rotateTableToken(tableId: ID) {
    const table = this.state.tables.find((t) => t.id === tableId)
    if (!table) throw new Error(`ไม่พบโต๊ะ ${tableId}`)
    table.qrToken = newId('qr')
    this.commit()
    return table.qrToken
  }

  async closeVisit(visitId: ID, payments: PaymentInput[] = []) {
    void payments // โหมดจำลองไม่เก็บประวัติการชำระเงิน ของจริงบันทึกใน close_visit()
    const visit = this.state.visits.find((v) => v.id === visitId)
    if (!visit) throw new Error(`ไม่พบ visit ${visitId}`)
    const nowIso = new Date().toISOString()
    visit.status = 'closed'
    visit.closedAt = nowIso

    for (const pass of this.state.passes) {
      if (pass.visitId !== visitId) continue
      if (pass.status === 'active' || pass.status === 'paused') {
        pass.checkedOutAt = nowIso
      }
      pass.status = 'billed'
    }
    for (const occ of this.state.occupancies) {
      if (occ.visitId === visitId && occ.toAt === null) {
        occ.toAt = nowIso
        const table = this.state.tables.find((t) => t.id === occ.tableId)
        if (table) table.status = 'cleaning'
      }
    }
    this.commit()
  }

  // ---------- Order ----------

  async placeOrder(input: Parameters<DataPort['placeOrder']>[0]) {
    const cached = this.seenKeys.get(input.idempotencyKey)
    if (cached) return structuredClone(cached)

    const visit = this.state.visits.find((v) => v.id === input.visitId)
    if (!visit || visit.status !== 'open') {
      throw new Error('visit นี้ปิดแล้ว สั่งเพิ่มไม่ได้')
    }

    // ต้องตรวจให้ตรงกับ place_order_core() ฝั่ง SQL ไม่งั้นโหมดเดโมจะหละหลวมกว่า
    // ของจริง แล้วบั๊กจะไม่โผล่จนกว่าจะขึ้นฐานข้อมูลจริง
    if (input.splitMode === 'owner') {
      const owner = this.state.passes.find((p) => p.id === input.orderedByPassId)
      if (!owner || owner.visitId !== input.visitId) {
        throw new Error('ผู้สั่งไม่ได้อยู่ในกลุ่มนี้')
      }
      if (owner.status !== 'active' && owner.status !== 'paused') {
        throw new Error('ผู้สั่งไม่ได้อยู่ในกลุ่มนี้แล้ว')
      }
    }

    const occ = this.state.occupancies.find((o) => o.visitId === input.visitId && o.toAt === null)
    const order: Order = {
      id: newId('ord'),
      visitId: input.visitId,
      orderedByPassId: input.splitMode === 'shared' ? null : input.orderedByPassId,
      placedBy: input.placedBy,
      splitMode: input.splitMode,
      tableIdSnapshot: occ?.tableId ?? null,
      status: 'placed',
      placedAt: new Date().toISOString(),
      lines: input.items.map((item) => {
        const menuItem = this.state.menu.find((m) => m.id === item.menuItemId)
        if (!menuItem) throw new Error(`ไม่พบเมนู ${item.menuItemId}`)
        if (!menuItem.available) throw new Error(`${menuItem.name} หมด`)
        return {
          id: newId('ol'),
          menuItemId: menuItem.id,
          nameSnapshot: menuItem.name,
          // ล็อกราคา ณ เวลาสั่ง — แก้ราคาเมนูทีหลังต้องไม่กระทบบิลเก่า
          unitPriceSnapshot: menuItem.price,
          qty: item.qty,
          note: item.note,
        }
      }),
    }

    this.state.orders.push(order)
    this.seenKeys.set(input.idempotencyKey, order)
    this.commit()
    return structuredClone(order)
  }

  async updateOrderStatus(orderId: ID, status: OrderStatus) {
    const order = this.state.orders.find((o) => o.id === orderId)
    if (!order) throw new Error(`ไม่พบออเดอร์ ${orderId}`)
    if (!canTransition(order.status, status)) {
      throw new Error(`เปลี่ยนสถานะจาก ${order.status} เป็น ${status} ไม่ได้`)
    }
    order.status = status
    this.commit()
  }

  // ---------- ฝั่งลูกค้า (สแกน QR) ----------

  /** แปลง token เป็น visit ที่เปิดอยู่ — ตรรกะเดียวกับ visit_for_token() ใน SQL */
  private visitForToken(token: string): { tableId: ID; visitId: ID | null; code: string; zone: string } {
    const table = this.state.tables.find((t) => t.qrToken === token)
    if (!table) throw new Error('QR นี้ใช้ไม่ได้')
    const occ = this.state.occupancies.find((o) => o.tableId === table.id && o.toAt === null)
    const visit = occ && this.state.visits.find((v) => v.id === occ.visitId && v.status === 'open')
    return { tableId: table.id, visitId: visit ? visit.id : null, code: table.code, zone: table.zone }
  }

  async guestSession(token: string): Promise<GuestSession> {
    const { visitId, code, zone } = this.visitForToken(token)
    return {
      tableCode: code,
      zone,
      visitId,
      passes: this.state.passes
        .filter((p) => p.visitId === visitId && (p.status === 'active' || p.status === 'paused'))
        .map((p) => ({ id: p.id, displayName: p.displayName })),
      menu: structuredClone(this.state.menu),
    }
  }

  async guestOrders(token: string): Promise<GuestOrder[]> {
    const { visitId } = this.visitForToken(token)
    if (!visitId) return []
    return this.state.orders
      .filter((o) => o.visitId === visitId)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .map((o) => ({
        id: o.id,
        status: o.status,
        placedAt: o.placedAt,
        orderedByPassId: o.orderedByPassId,
        splitMode: o.splitMode,
        lines: o.lines.map((l) => ({
          id: l.id, name: l.nameSnapshot, qty: l.qty,
          amount: Math.round(l.unitPriceSnapshot * l.qty * 100) / 100,
        })),
      }))
  }

  async guestBill(token: string): Promise<BillPreview> {
    const { visitId } = this.visitForToken(token)
    if (!visitId) throw new Error('โต๊ะนี้ยังไม่ได้เปิด')
    return this.previewBill(visitId)
  }

  async guestPlaceOrder(input: Parameters<GuestPort['placeOrder']>[0]) {
    const { visitId } = this.visitForToken(input.token)
    if (!visitId) throw new Error('โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน')
    const order = await this.placeOrder({
      idempotencyKey: input.idempotencyKey,
      visitId,
      orderedByPassId: input.orderedByPassId,
      splitMode: input.splitMode,
      placedBy: 'guest',
      items: input.items,
    })
    return { orderId: order.id, status: order.status }
  }

  // ---------- Bill ----------

  async previewBill(visitId: ID, now = new Date()): Promise<BillPreview> {
    const ratePlans: Record<string, RatePlan> = {}
    for (const plan of this.state.ratePlans) ratePlans[plan.id] = plan

    return computeBill({
      visitId,
      passes: this.state.passes.filter((p) => p.visitId === visitId),
      orders: this.state.orders.filter((o) => o.visitId === visitId),
      ratePlans,
      now,
    })
  }

  private mustPass(passId: ID): GuestPass {
    const pass = this.state.passes.find((p) => p.id === passId)
    if (!pass) throw new Error(`ไม่พบ pass ${passId}`)
    return pass
  }

  /** ปุ่มรีเซ็ตในเดโม */
  reset() {
    this.state = seed()
    this.seenKeys.clear()
    this.commit()
  }
}

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  placed: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready'],
  ready: ['served'],
  served: [],
  rejected: [],
  cancelled: [],
}

function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED[from].includes(to)
}

function makePass(visitId: ID, name: string, ratePlanId: ID, at: string): GuestPass {
  return {
    id: newId('p'),
    visitId,
    displayName: name,
    ratePlanId,
    status: 'active',
    checkedInAt: at,
    checkedOutAt: null,
    pausedMinutes: 0,
    pausedAt: null,
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function load(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Snapshot) : null
  } catch {
    return null
  }
}

function save(state: Snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // โควตาเต็ม/โหมดส่วนตัว — ปล่อยผ่าน เดโมยังทำงานในหน่วยความจำได้
  }
}

export const mockAdapter = new MockAdapter()

/**
 * ฝั่งลูกค้าแยกเป็นคนละ adapter โดยตั้งใจ — คนละผู้ใช้ คนละสิทธิ์
 * และ placeOrder ของสองฝั่งรับพารามิเตอร์ไม่เหมือนกัน (ลูกค้าส่ง token
 * ไม่ใช่ visitId) จึงอยู่ในอินเทอร์เฟซเดียวกันไม่ได้
 */
export const mockGuestAdapter: GuestPort = {
  session: (token) => mockAdapter.guestSession(token),
  orders: (token) => mockAdapter.guestOrders(token),
  bill: (token) => mockAdapter.guestBill(token),
  placeOrder: (input) => mockAdapter.guestPlaceOrder(input),
}
