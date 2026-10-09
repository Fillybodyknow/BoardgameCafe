import type { BookingPort, DataPort, GuestPort, Snapshot } from '../port'
import type {
  AvailableTable, BillPreview, BookingLookup, BookingReceipt, GuestOrder, GuestPass,
  GuestSession, ID, MenuItem, Order, OrderStatus, PassSettlement, PaymentInput, RatePlan,
  Reservation, Visit,
} from '../../domain/types'
import { computeBill, settlementFor } from '../../domain/pricing'
import { cartNeedsKitchen, kitchenWindow } from '../../domain/kitchen'
import { seed, businessDateOf } from './seed'
import { bangkokParts, loadBooking, loadHours, loadTax, toMinutes } from './shopStore'

/**
 * หนึ่งกลุ่มนั่งได้ครั้งละโต๊ะเดียว — ตรงกับ trigger occupancies_one_table
 * ฝั่ง SQL ถ้าโหมดจำลองหลวมกว่า บั๊กจะไม่โผล่จนกว่าจะขึ้นฐานข้อมูลจริง
 */
function assertOneTable(tableIds: ID[]) {
  if (tableIds.length > 1) {
    throw new Error('หนึ่งกลุ่มนั่งได้ครั้งละ 1 โต๊ะ ถ้าต้องการย้ายให้ใช้ปุ่มย้ายโต๊ะ')
  }
}

/** ต้องตรงกับ guest_register_limit() ฝั่ง SQL */
const GUEST_REGISTER_LIMIT = 20

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
    // เดโมที่เคยเก็บไว้ก่อนมี QR ต่อรอบ — ออก token ให้รอบที่ยังเปิดอยู่
    for (const v of this.state.visits) v.qrToken ??= newToken()
  }

  private commit() {
    save(this.state)
    this.listeners.forEach((fn) => fn())
  }

  async getSnapshot(): Promise<Snapshot> {
    const snap = structuredClone(this.state)
    // หน้าร้านต้องไม่เห็นของที่เก็บเข้ากรุ — หน้าตั้งค่าใช้ *ForAdmin() แทน
    snap.menu = snap.menu.filter((m) => !m.archived)
    snap.tables = snap.tables.filter((t) => !t.archived)
    snap.tax = loadTax()
    snap.hours = loadHours()
    return snap
  }

  /** หน้าตั้งค่าต้องเห็นของที่เก็บเข้ากรุด้วย จึงไม่กรอง */
  async menuForAdmin() {
    return structuredClone(this.state.menu)
  }

  async tablesForAdmin() {
    return structuredClone(this.state.tables)
  }

  async ratePlansForAdmin() {
    return structuredClone(this.state.ratePlans)
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---------- Visit / Pass ----------

  async openVisit(input: { tableIds: ID[]; guests: { name: string; ratePlanId: ID }[] }) {
    assertOneTable(input.tableIds)
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
      sharedSettled: 0,
      // เปิดโต๊ะหนึ่งครั้ง = QR ใหม่หนึ่งใบ (ดู migration 1800)
      qrToken: newToken(),
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
      this.state.passes.push(
        makePass(visit.id, guest.name, guest.ratePlanId, nowIso, this.mustPlan(guest.ratePlanId)),
      )
    }

    this.commit()
    return structuredClone(visit)
  }

  async addPass(visitId: ID, input: { name: string; ratePlanId: ID }) {
    // เข้ากลางคัน — นาฬิกาเริ่มนับ ณ ตอนนี้ เฉพาะคนนี้ และถือเรต ณ ตอนนี้ไปด้วย
    const pass = makePass(
      visitId,
      input.name,
      input.ratePlanId,
      new Date().toISOString(),
      this.mustPlan(input.ratePlanId),
    )
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

  async voidPass(passId: ID) {
    const pass = this.mustPass(passId)
    if (pass.status === 'billed') throw new Error('คนนี้ชำระเงินไปแล้ว ลบไม่ได้')

    const visit = this.state.visits.find((v) => v.id === pass.visitId)
    if (!visit || visit.status !== 'open') throw new Error('visit นี้ปิดไปแล้ว')

    if (this.state.orders.some((o) => o.orderedByPassId === passId)) {
      throw new Error('คนนี้สั่งของไปแล้ว ลบไม่ได้ — ใช้ "กลับก่อน" แทน')
    }
    if (this.state.passes.filter((p) => p.visitId === pass.visitId).length <= 1) {
      throw new Error('โต๊ะต้องมีอย่างน้อย 1 คน')
    }

    this.state.passes = this.state.passes.filter((p) => p.id !== passId)
    this.commit()
  }

  /** ลูกค้าลงชื่อตัวเอง — กติกาเดียวกับ guest_register() ฝั่ง SQL */
  async guestRegister(token: string, name: string) {
    const { visitId } = this.visitForToken(token)
    if (!visitId) throw new Error('โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน')

    const clean = name.trim()
    if (!clean) throw new Error('กรุณาใส่ชื่อ')
    if (clean.length > 40) throw new Error('ชื่อยาวเกินไป')

    // กดสองที หรือเปิดสองแท็บ ต้องไม่กลายเป็นสองคน
    const same = this.state.passes.find(
      (p) =>
        p.visitId === visitId &&
        p.displayName.toLowerCase() === clean.toLowerCase() &&
        (p.status === 'active' || p.status === 'paused'),
    )
    if (same) {
      same.claimedAt ??= new Date().toISOString()
      this.commit()
      return { passId: same.id, displayName: same.displayName }
    }

    const inVisit = this.state.passes.filter((p) => p.visitId === visitId)
    if (inVisit.length >= GUEST_REGISTER_LIMIT) {
      throw new Error('โต๊ะนี้มีคนครบแล้ว กรุณาแจ้งพนักงาน')
    }

    const plan = this.state.ratePlans[0]
    if (!plan) throw new Error('ร้านยังไม่ได้ตั้งเรทค่าเล่น')

    const pass = makePass(visitId, clean, plan.id, new Date().toISOString(), plan)
    pass.claimedAt = pass.checkedInAt
    this.state.passes.push(pass)
    this.commit()
    return { passId: pass.id, displayName: pass.displayName }
  }

  /** ลูกค้ารับชื่อที่พนักงานสร้างไว้ — กติกาเดียวกับ guest_claim() ฝั่ง SQL */
  async guestClaim(token: string, passId: ID, name?: string) {
    const { visitId } = this.visitForToken(token)
    if (!visitId) throw new Error('โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน')

    const pass = this.state.passes.find(
      (p) => p.id === passId && p.visitId === visitId && (p.status === 'active' || p.status === 'paused'),
    )
    if (!pass) throw new Error('ไม่พบชื่อนี้ในโต๊ะ')

    const clean = name?.trim() || null
    if (clean) {
      if (clean.length > 40) throw new Error('ชื่อยาวเกินไป')
      const dup = this.state.passes.some(
        (p) =>
          p.visitId === visitId && p.id !== passId &&
          (p.status === 'active' || p.status === 'paused') &&
          p.displayName.toLowerCase() === clean.toLowerCase(),
      )
      if (dup) throw new Error('ชื่อนี้มีคนใช้ในโต๊ะแล้ว')
    }
    if (pass.claimedAt) throw new Error('ชื่อนี้มีคนรับไปแล้ว — ถ้าเป็นคุณ ให้ลงชื่อด้วยชื่อเดิม')

    pass.claimedAt = new Date().toISOString()
    if (clean) pass.displayName = clean
    this.commit()
    return { passId: pass.id, displayName: pass.displayName }
  }

  async moveVisitToTables(visitId: ID, tableIds: ID[]) {
    assertOneTable(tableIds)
    const nowIso = new Date().toISOString()
    // ปิด occupancy เดิม แล้วเปิดใหม่ — ประวัติยังอยู่ครบ บิลไม่กระทบ
    for (const occ of this.state.occupancies) {
      if (occ.visitId === visitId && occ.toAt === null) {
        occ.toAt = nowIso
        // โต๊ะกลับมาว่างทันที — ไม่มีสถานะ "กำลังเก็บ" แล้ว (ดู migration 800)
        const old = this.state.tables.find((t) => t.id === occ.tableId)
        if (old) old.status = 'free'
      }
    }
    for (const tableId of tableIds) {
      this.state.occupancies.push({ id: newId('o'), visitId, tableId, fromAt: nowIso, toAt: null })
      const table = this.state.tables.find((t) => t.id === tableId)
      if (table) table.status = 'occupied'
    }
    this.commit()
  }

  async rotateVisitToken(visitId: ID) {
    const visit = this.state.visits.find((v) => v.id === visitId && v.status === 'open')
    if (!visit) throw new Error('ไม่พบรอบที่ยังเปิดอยู่')
    visit.qrToken = newToken()
    this.commit()
    return visit.qrToken
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
        if (table) table.status = 'free'
      }
    }
    this.commit()
  }

  async passSettlement(passId: ID): Promise<PassSettlement> {
    const pass = this.mustPass(passId)
    if (pass.status === 'billed') throw new Error('คนนี้ชำระเงินไปแล้ว')

    const preview = await this.previewBill(pass.visitId)
    const heads = this.state.passes.filter(
      (p) => p.visitId === pass.visitId && p.status !== 'billed',
    ).length

    return { ...settlementFor(preview, passId, heads, loadTax()), displayName: pass.displayName }
  }

  async settlePass(passId: ID, payments: PaymentInput[] = []) {
    void payments // โหมดจำลองไม่เก็บประวัติการชำระเงิน ของจริงบันทึกใน settle_pass()
    const pass = this.mustPass(passId)
    if (pass.status === 'billed') throw new Error('คนนี้ชำระเงินไปแล้ว')

    const visit = this.state.visits.find((v) => v.id === pass.visitId)
    if (!visit) throw new Error(`ไม่พบ visit ${pass.visitId}`)
    if (visit.status !== 'open') throw new Error('visit นี้ปิดไปแล้ว')

    // คิดยอดก่อนหยุดนาฬิกา แล้วค่อยเช็คเอาต์ ลำดับเดียวกับฝั่ง SQL
    await this.checkOutPass(passId)
    const calc = await this.passSettlement(passId)

    visit.sharedSettled = Math.round((visit.sharedSettled + calc.sharedShare) * 100) / 100
    pass.status = 'billed'
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

    if (!input.allowClosedKitchen) {
      const window = kitchenWindow(loadHours())
      if (!window.open && cartNeedsKitchen(this.state.menu, input.items)) {
        throw new Error(`${window.reason} ยืนยันอีกครั้งถ้าครัวยังทำให้ได้`)
      }
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
        // ตรงกับ place_order_core() ฝั่ง SQL ถ้าไม่ตรวจ บั๊กรายการ qty=0
        // จะผ่านโหมดเดโมไปโผล่ตอนขึ้นฐานข้อมูลจริง (เคยเกิดมาแล้ว)
        if (!Number.isInteger(item.qty) || item.qty <= 0) {
          throw new Error('จำนวนต้องมากกว่า 0')
        }
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

  // ---------- การจอง (ฝั่งพนักงาน) ----------

  private mustReservation(id: ID): Reservation {
    const r = this.state.reservations.find((x) => x.id === id)
    if (!r) throw new Error('ไม่พบรายการจอง')
    return r
  }

  async confirmReservation(id: ID) {
    const r = this.mustReservation(id)
    if (r.status !== 'pending') throw new Error('ยืนยันได้เฉพาะรายการที่รอยืนยัน')
    r.status = 'confirmed'
    this.commit()
  }

  async rejectReservation(id: ID, reason?: string) {
    const r = this.mustReservation(id)
    if (r.status !== 'pending' && r.status !== 'confirmed') throw new Error('รายการนี้ปิดไปแล้ว')
    r.status = 'cancelled'
    r.staffNote = reason
    this.commit()
  }

  async markNoShow(id: ID) {
    const r = this.mustReservation(id)
    if (r.status !== 'pending' && r.status !== 'confirmed') throw new Error('รายการนี้ปิดไปแล้ว')
    r.status = 'no_show'
    this.commit()
  }

  async seatReservation(id: ID, guests: { name: string; ratePlanId: ID }[], tableIds?: ID[]) {
    const r = this.mustReservation(id)
    if (r.status !== 'pending' && r.status !== 'confirmed') {
      throw new Error('รายการนี้เช็คอินไม่ได้แล้ว')
    }
    const tables = tableIds ?? r.tableIds
    assertOneTable(tables)

    // ตรวจให้ตรงกับ seat_reservation() ฝั่ง SQL — โต๊ะที่จองไว้อาจมีกลุ่มก่อนหน้า
    // นั่งเลยเวลาอยู่ ต้องบอกให้ชัดว่าโต๊ะไหนติด
    const busy = tables
      .map((tid) => this.state.tables.find((t) => t.id === tid))
      .filter(
        (t) =>
          t &&
          !t.allowShare &&
          this.state.occupancies.some((o) => o.tableId === t.id && o.toAt === null),
      )
      .map((t) => t!.code)
    if (busy.length > 0) {
      throw new Error(
        'โต๊ะ ' + busy.join(', ') + ' ยังมีลูกค้าอยู่ ปิดบิลโต๊ะเดิมก่อน หรือเลือกโต๊ะอื่นให้',
      )
    }

    const visit = await this.openVisit({ tableIds: tables, guests })
    const stored = this.state.visits.find((v) => v.id === visit.id)
    if (stored) stored.source = 'reservation'
    visit.source = 'reservation'

    r.status = 'seated'
    r.visitId = visit.id
    r.tableIds = tables
    this.commit()
    return visit
  }

  // ---------- จองออนไลน์ (ฝั่งลูกค้า) ----------

  /** ช่วงเวลาชนกันไหม เมื่อขยายหัวท้ายด้วยเวลาเก็บโต๊ะ */
  private overlaps(r: Reservation, start: number, end: number, bufferMin: number): boolean {
    const rs = new Date(r.startAt).getTime() - bufferMin * 60_000
    const re = rs + (r.durationMinutes + bufferMin * 2) * 60_000
    return rs < end && start < re
  }

  bookingTables(startAt: string, durationMinutes: number): AvailableTable[] {
    const start = new Date(startAt).getTime()
    const end = start + durationMinutes * 60_000
    const now = Date.now()

    return this.state.tables.map((t) => {
      // จองซ้อนไม่ได้ ไม่ว่าโต๊ะจะนั่งร่วมกันได้หรือไม่ — ตรงกับ
      // table_available() ฝั่ง SQL ตั้งแต่ migration 2400
      const clash = this.state.reservations.some(
        (r) =>
          ['pending', 'confirmed', 'seated'].includes(r.status) &&
          r.tableIds.includes(t.id) &&
          // รายการที่เช็คอินแล้วล็อกต่อเฉพาะตอนที่ยังนั่งอยู่จริง ปิดบิลแล้ว
          // ถือว่าเลิกล็อก — ตรงกับ table_available() ฝั่ง SQL
          (r.status !== 'seated' ||
            this.state.visits.some((v) => v.id === r.visitId && v.status === 'open')) &&
          this.overlaps(r, start, end, MOCK_BOOKING.bufferMinutes),
      )
      const occupied =
        start < now + MOCK_BOOKING.occupiedHoldMinutes * 60_000 &&
        this.state.occupancies.some((o) => o.tableId === t.id && o.toAt === null)
      const available = !clash && !occupied

      return {
        id: t.id,
        code: t.code,
        zone: t.zone,
        seatMin: t.seatMin,
        seatMax: t.seatMax,
        allowShare: t.allowShare,
        imagePath: t.imagePath,
        available,
      }
    })
  }

  /** ตรงกับ assert_bookable() ฝั่ง SQL */
  private assertBookable(startAt: string, duration: number) {
    // ค่าที่เจ้าของร้านตั้งได้มาจากที่เก็บ ส่วนที่ยังไม่มีหน้าจอใช้ค่าตั้งต้น
    const cfg = { ...MOCK_BOOKING, ...loadBooking() }
    if (duration < cfg.minDurationMinutes || duration > cfg.maxDurationMinutes) {
      throw new Error(`จองได้ครั้งละ ${cfg.minDurationMinutes}–${cfg.maxDurationMinutes} นาที`)
    }

    const start = new Date(startAt).getTime()
    if (start < Date.now() + cfg.minAdvanceMinutes * 60_000) {
      throw new Error(`ต้องจองล่วงหน้าอย่างน้อย ${cfg.minAdvanceMinutes} นาที`)
    }
    if (start > Date.now() + cfg.maxAdvanceDays * 24 * 3600_000) {
      throw new Error(`จองล่วงหน้าได้ไม่เกิน ${cfg.maxAdvanceDays} วัน`)
    }

    const { weekday, minutes } = bangkokParts(startAt)
    const hours = loadHours().find((h) => h.weekday === weekday)
    if (!hours || hours.closed) throw new Error('วันนั้นร้านปิด')

    const open = toMinutes(hours.openTime)
    const close = toMinutes(hours.closeTime)
    if (minutes < open) throw new Error(`ร้านเปิด ${hours.openTime} น.`)
    if (minutes + duration > close) {
      throw new Error(`ต้องจบก่อนร้านปิด ${hours.closeTime} น.`)
    }
  }

  bookingCreate(input: Parameters<BookingPort['create']>[0]): BookingReceipt {
    const phone = input.phone.replace(/[^0-9]/g, '')
    if (phone.length < 9) throw new Error('เบอร์โทรไม่ถูกต้อง')
    if (!input.customerName.trim()) throw new Error('กรุณาใส่ชื่อผู้จอง')
    if (input.tableIds.length === 0) throw new Error('กรุณาเลือกโต๊ะ')
    // ตรงกับ trigger reservations_one_table ฝั่ง SQL
    if (input.tableIds.length > 1) throw new Error('จองได้ครั้งละ 1 โต๊ะ')

    this.assertBookable(input.startAt, input.durationMinutes)

    const avail = this.bookingTables(input.startAt, input.durationMinutes)
    for (const id of input.tableIds) {
      const t = avail.find((x) => x.id === id)
      if (!t || !t.available) {
        throw new Error('โต๊ะ ' + (t ? t.code : '') + ' ไม่ว่างในช่วงเวลานี้แล้ว')
      }
    }

    const seats = input.tableIds.reduce(
      (n, id) => n + (this.state.tables.find((t) => t.id === id)?.seatMax ?? 0),
      0,
    )
    if (input.partySize > seats) {
      throw new Error(
        'โต๊ะที่เลือกนั่งได้ ' + seats + ' คน แต่จอง ' + input.partySize + ' คน',
      )
    }

    const code = randomCode()
    const reservation: Reservation = {
      id: newId('r'),
      code,
      source: 'online',
      customerName: input.customerName.trim(),
      phone: input.phone,
      partySize: input.partySize,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      zonePreference: null,
      status: 'pending',
      tableIds: input.tableIds,
      visitId: null,
      note: input.note?.trim() || undefined,
    }
    this.state.reservations.push(reservation)
    this.commit()

    return {
      code,
      status: 'pending',
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      tables: this.codesOf(input.tableIds),
    }
  }

  private codesOf(ids: ID[]): string[] {
    return ids
      .map((id) => this.state.tables.find((t) => t.id === id)?.code ?? '')
      .sort()
  }

  /** ต้องมีทั้งรหัสและเบอร์ กันคนสุ่มรหัสไล่ดูข้อมูลคนอื่น */
  private findByCode(code: string, phone: string): Reservation {
    const digits = phone.replace(/[^0-9]/g, '')
    const r = this.state.reservations.find(
      (x) =>
        x.code?.toUpperCase() === code.trim().toUpperCase() &&
        x.phone.replace(/[^0-9]/g, '') === digits,
    )
    if (!r) throw new Error('ไม่พบรายการจอง ตรวจรหัสและเบอร์โทรอีกครั้ง')
    return r
  }

  bookingLookup(code: string, phone: string): BookingLookup {
    const r = this.findByCode(code, phone)
    return {
      code: r.code!,
      status: r.status,
      startAt: r.startAt,
      durationMinutes: r.durationMinutes,
      customerName: r.customerName,
      partySize: r.partySize,
      note: r.note ?? null,
      tables: this.codesOf(r.tableIds),
    }
  }

  bookingCancel(code: string, phone: string) {
    const r = this.findByCode(code, phone)
    if (r.status !== 'pending' && r.status !== 'confirmed') {
      throw new Error('รายการนี้ยกเลิกไม่ได้แล้ว')
    }
    r.status = 'cancelled'
    this.commit()
  }

  // ---------- ฝั่งลูกค้า (สแกน QR) ----------

  /**
   * แปลง token เป็นรอบที่เปิดอยู่ — ตรรกะเดียวกับ visit_for_token() + guest_session() ใน SQL
   *
   * visitId = null แปลว่าสั่งไม่ได้: ended = ปิดบิลแล้ว, ไม่ ended = สติกเกอร์ติดโต๊ะแบบเก่า
   */
  private visitForToken(token: string): { visitId: ID | null; ended: boolean; code: string; zone: string } {
    const visit = this.state.visits.find((v) => v.qrToken === token)
    if (!visit) {
      const table = this.state.tables.find((t) => t.qrToken === token && !t.archived)
      if (!table) throw new Error('QR นี้ใช้ไม่ได้')
      return { visitId: null, ended: false, code: table.code, zone: table.zone }
    }

    // กลุ่มใหญ่ต่อโต๊ะ → B1+B2 / ปิดบิลแล้วใช้โต๊ะสุดท้ายที่นั่ง
    const mine = this.state.occupancies.filter((o) => o.visitId === visit.id)
    const current = mine.filter((o) => o.toAt === null)
    const occs = current.length > 0 ? current : mine.sort((a, b) => b.fromAt.localeCompare(a.fromAt)).slice(0, 1)
    const tables = occs
      .map((o) => this.state.tables.find((t) => t.id === o.tableId))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
    const open = visit.status === 'open'
    return {
      visitId: open ? visit.id : null,
      ended: !open,
      code: tables.map((t) => t.code).join('+') || '—',
      zone: tables[0]?.zone ?? '',
    }
  }

  async guestSession(token: string): Promise<GuestSession> {
    const { visitId, ended, code, zone } = this.visitForToken(token)
    return {
      tableCode: code,
      zone,
      visitId,
      ended,
      passes: this.state.passes
        .filter((p) => p.visitId === visitId && (p.status === 'active' || p.status === 'paused'))
        .map((p) => ({ id: p.id, displayName: p.displayName, claimed: Boolean(p.claimedAt) })),
      // สั่งไม่ได้ก็ไม่ต้องส่งเมนู — ตรงกับฝั่ง SQL
      menu: visitId ? structuredClone(this.state.menu.filter((m) => !m.archived)) : [],
      kitchen: kitchenWindow(loadHours()),
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

    // ด่านเดียวกับ guest_place_order() ฝั่ง SQL — ลูกค้าข้ามไม่ได้ ต่างจากพนักงาน
    const window = kitchenWindow(loadHours())
    if (!window.open && cartNeedsKitchen(this.state.menu, input.items)) {
      throw new Error(`${window.reason} สั่งได้เฉพาะเครื่องดื่มและของกินเล่น`)
    }
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
      sharedSettled: this.state.visits.find((v) => v.id === visitId)?.sharedSettled ?? 0,
      tax: loadTax(),
      now,
    })
  }

  private mustPlan(id: ID): RatePlan {
    const plan = this.state.ratePlans.find((p) => p.id === id)
    if (!plan) throw new Error(`ไม่พบเรตราคา ${id}`)
    return plan
  }

  private mustPass(passId: ID): GuestPass {
    const pass = this.state.passes.find((p) => p.id === passId)
    if (!pass) throw new Error(`ไม่พบ pass ${passId}`)
    return pass
  }

  // ---------- ตั้งค่าร้าน (ใช้โดย mockAdminAdapter) ----------

  saveMenuItem(input: {
    id: ID | null
    sku: string
    name: string
    category: MenuItem['category']
    price: number
    available: boolean
    sortOrder: number
  }) {
    if (input.id) {
      const item = this.state.menu.find((m) => m.id === input.id)
      if (!item) throw new Error('ไม่พบเมนู')
      Object.assign(item, {
        sku: input.sku,
        name: input.name.trim(),
        category: input.category,
        price: input.price,
        available: input.available,
        sortOrder: input.sortOrder,
      })
    } else {
      this.state.menu.push({
        id: newId('m'),
        sku: input.sku,
        name: input.name.trim(),
        category: input.category,
        price: input.price,
        available: input.available,
        sortOrder: input.sortOrder,
        archived: false,
      })
    }
    this.state.menu.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    this.commit()
  }

  setMenuImage(id: ID, path: string | null) {
    const item = this.state.menu.find((m) => m.id === id)
    if (!item) throw new Error('ไม่พบเมนู')
    item.imagePath = path
    this.commit()
  }

  setTableImage(id: ID, path: string | null) {
    const table = this.state.tables.find((t) => t.id === id)
    if (!table) throw new Error('ไม่พบโต๊ะ')
    table.imagePath = path
    this.commit()
  }

  archiveMenuItem(id: ID, archived: boolean) {
    const item = this.state.menu.find((m) => m.id === id)
    if (!item) throw new Error('ไม่พบเมนู')
    item.archived = archived
    // เก็บเข้ากรุแล้วต้องไม่ค้างสถานะพร้อมขาย
    if (archived) item.available = false
    this.commit()
  }

  saveTable(input: {
    id: ID | null
    code: string
    zone: string
    seatMin: number
    seatMax: number
    allowShare: boolean
    sortOrder: number
  }) {
    if (input.id) {
      const table = this.state.tables.find((t) => t.id === input.id)
      if (!table) throw new Error('ไม่พบโต๊ะ')
      // ตรงกับ upsert_table ฝั่ง SQL — occupancies.exclusive คัดลอกไปตอนเปิดโต๊ะ
      // ถ้าเปลี่ยนตอนมีคนนั่ง ค่าจะไม่ตรงกันจนกติกาโต๊ะซ้อนเพี้ยน
      const occupied = this.state.occupancies.some(
        (o) => o.tableId === table.id && o.toAt === null,
      )
      if (occupied && table.allowShare !== input.allowShare) {
        throw new Error('เปลี่ยนการนั่งร่วมตอนมีลูกค้าอยู่ไม่ได้ ปิดบิลก่อน')
      }
      Object.assign(table, {
        code: input.code,
        zone: input.zone.trim(),
        seatMin: input.seatMin,
        seatMax: input.seatMax,
        allowShare: input.allowShare,
        sortOrder: input.sortOrder,
      })
    } else {
      this.state.tables.push({
        id: newId('t'),
        code: input.code,
        zone: input.zone.trim(),
        seatMin: input.seatMin,
        seatMax: input.seatMax,
        allowShare: input.allowShare,
        status: 'free',
        sortOrder: input.sortOrder,
        imagePath: null,
        archived: false,
        qrToken: newId('qr'),
      })
    }
    this.state.tables.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    this.commit()
  }

  archiveTable(id: ID, archived: boolean) {
    const table = this.state.tables.find((t) => t.id === id)
    if (!table) throw new Error('ไม่พบโต๊ะ')

    if (archived) {
      if (this.state.occupancies.some((o) => o.tableId === id && o.toAt === null)) {
        throw new Error('โต๊ะนี้มีลูกค้านั่งอยู่ ปิดบิลก่อน')
      }
      const queued = this.state.reservations.filter(
        (r) => ['pending', 'confirmed'].includes(r.status) && r.tableIds.includes(id),
      ).length
      if (queued > 0) {
        throw new Error(`โต๊ะนี้มีคิวจองค้างอยู่ ${queued} รายการ จัดการคิวก่อน`)
      }
    }

    table.archived = archived
    if (!archived) table.status = 'free'
    this.commit()
  }

  saveRatePlan(input: {
    id: ID | null
    name: string
    pricePerHour: number
    roundToMinutes: number
    minimumMinutes: number
    dayPassCap: number | null
    active: boolean
    sortOrder: number
  }) {
    if (input.id) {
      const plan = this.state.ratePlans.find((p) => p.id === input.id)
      if (!plan) throw new Error('ไม่พบเรตราคา')
      // ไม่แตะ pass ที่เปิดไปแล้ว เพราะแต่ละใบถือ snapshot ของตัวเอง
      Object.assign(plan, { ...input, name: input.name.trim() })
    } else {
      this.state.ratePlans.push({ ...input, id: newId('rp'), name: input.name.trim() })
    }
    this.state.ratePlans.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    this.commit()
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

/**
 * ตรงกับ trigger guest_passes_rate_snapshot ฝั่ง SQL — pass ถือเรตติดตัวไป
 * เจ้าของขึ้นราคาทีหลังจึงไม่กระทบคนที่นั่งอยู่แล้ว
 */
function makePass(
  visitId: ID,
  name: string,
  ratePlanId: ID,
  at: string,
  plan: RatePlan,
): GuestPass {
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
    rate: {
      name: plan.name,
      pricePerHour: plan.pricePerHour,
      roundToMinutes: plan.roundToMinutes,
      minimumMinutes: plan.minimumMinutes,
      dayPassCap: plan.dayPassCap,
    },
  }
}

/** ต้องตรงกับ reservation_config ฝั่ง SQL ไม่งั้นโหมดเดโมให้ผลต่างจากของจริง */
const MOCK_BOOKING = {
  bufferMinutes: 15,
  occupiedHoldMinutes: 90,
  slotMinutes: 30,
  defaultDurationMinutes: 120,
  minDurationMinutes: 60,
  maxDurationMinutes: 300,
  maxAdvanceDays: 30,
  minAdvanceMinutes: 30,
}

/** รหัสจอง ไม่มีตัวที่สับสน (0/O, 1/I) เหมือน new_reservation_code() ฝั่ง SQL */
function randomCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** token ใน QR ต้องเดายาก — ใช้ UUID แบบเดียวกับฝั่ง Postgres */
function newToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? newId('qr') + newId('')
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
export const mockBookingAdapter: BookingPort = {
  async hours() {
    // ต้องเป็นชุดเดียวกับที่หน้าตั้งค่าบันทึก ไม่งั้นแก้เวลาทำการแล้ว
    // หน้าจองยังเสนอเวลาเดิม
    return loadHours()
  },
  async config() {
    return loadBooking()
  },
  async availableTables(startAt, durationMinutes) {
    return mockAdapter.bookingTables(startAt, durationMinutes)
  },
  async create(input) {
    return mockAdapter.bookingCreate(input)
  },
  async lookup(code, phone) {
    return mockAdapter.bookingLookup(code, phone)
  },
  async cancel(code, phone) {
    mockAdapter.bookingCancel(code, phone)
  },
}

export const mockGuestAdapter: GuestPort = {
  register: (token, name) => mockAdapter.guestRegister(token, name),
  claim: (token, passId, name) => mockAdapter.guestClaim(token, passId, name),
  session: (token) => mockAdapter.guestSession(token),
  orders: (token) => mockAdapter.guestOrders(token),
  bill: (token) => mockAdapter.guestBill(token),
  placeOrder: (input) => mockAdapter.guestPlaceOrder(input),
}
