import type { RealtimeChannel } from '@supabase/supabase-js'
import type { BookingPort, DataPort, GuestPort, Snapshot } from '../port'
import type {
  AvailableTable, BillPreview, BookingConfig, BookingLookup, BookingReceipt,
  CafeTable, GuestOrder, GuestPass, GuestSession, ID, MenuItem,
  Occupancy, Order, OrderStatus, PassSettlement, PaymentInput, RatePlan, Reservation,
  ShopHours, Visit,
} from '../../domain/types'
import { requireClient } from './client'

/**
 * Adapter จริง — คุยกับ Supabase
 *
 * หน้าที่มีแค่ 2 อย่าง: แปลง snake_case ↔ camelCase และเรียก RPC
 * กติกาธุรกิจกับการคิดเงินอยู่ในฐานข้อมูลทั้งหมด ที่นี่ไม่ตัดสินใจอะไรเอง
 */

// ตารางที่ต้องรู้ทันทีเมื่อเปลี่ยน — จอครัวกับผังโต๊ะพึ่งพาสิ่งนี้
const WATCHED = [
  'visits', 'occupancies', 'guest_passes', 'orders', 'order_lines',
  'cafe_tables', 'reservations',
] as const

class SupabaseAdapter implements DataPort {
  private channel: RealtimeChannel | null = null
  private listeners = new Set<() => void>()

  async getSnapshot(): Promise<Snapshot> {
    const sb = requireClient()

    const [
      tables, visits, occupancies, passes, orders, orderLines,
      menu, ratePlans, reservations, tax, hours,
    ] = await Promise.all([
      sb.from('cafe_tables').select('*').eq('archived', false).order('sort_order'),
      sb.from('visits').select('*').eq('status', 'open'),
      sb.from('occupancies').select('*'),
      sb.from('guest_passes').select('*'),
      sb.from('orders').select('*'),
      sb.from('order_lines').select('*'),
      sb.from('menu_items').select('*').eq('archived', false).order('sort_order'),
      sb.from('rate_plans').select('*').eq('active', true).order('sort_order'),
      sb.from('reservations').select('*').in('status', ['pending', 'confirmed', 'seated']),
      sb.from('tax_config').select('*').eq('id', 1).single(),
      sb.from('shop_hours').select('*').order('weekday'),
    ])

    for (const res of [tables, visits, occupancies, passes, orders, orderLines, menu, ratePlans, reservations, tax, hours]) {
      if (res.error) throw new Error(res.error.message)
    }

    // จับ order_lines เข้ากับ order ของมัน
    const linesByOrder = new Map<string, Order['lines']>()
    for (const row of orderLines.data ?? []) {
      const list = linesByOrder.get(row.order_id) ?? []
      list.push({
        id: row.id,
        menuItemId: row.menu_item_id,
        nameSnapshot: row.name_snapshot,
        unitPriceSnapshot: Number(row.unit_price_snapshot),
        qty: row.qty,
        note: row.note ?? undefined,
      })
      linesByOrder.set(row.order_id, list)
    }

    return {
      tables: (tables.data ?? []).map(toTable),
      visits: (visits.data ?? []).map(toVisit),
      occupancies: (occupancies.data ?? []).map(toOccupancy),
      passes: (passes.data ?? []).map(toPass),
      orders: (orders.data ?? []).map((row) => toOrder(row, linesByOrder.get(row.id) ?? [])),
      menu: (menu.data ?? []).map(toMenuItem),
      ratePlans: (ratePlans.data ?? []).map(toRatePlan),
      reservations: (reservations.data ?? []).map(toReservation),
      tax: {
        serviceChargeRate: Number(tax.data!.service_charge_rate),
        vatRate: Number(tax.data!.vat_rate),
        vatIncluded: tax.data!.vat_included,
      },
      hours: (hours.data ?? []).map(toHours),
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)

    // เปิด channel เดียวใช้ร่วมกันทุก listener
    if (!this.channel) {
      const sb = requireClient()
      const channel = sb.channel('cafe-floor')
      for (const table of WATCHED) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
          this.listeners.forEach((fn) => fn())
        })
      }
      channel.subscribe()
      this.channel = channel
    }

    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.channel) {
        void requireClient().removeChannel(this.channel)
        this.channel = null
      }
    }
  }

  // ------------------------------------------------------------- Visit ----

  async openVisit(input: { tableIds: ID[]; guests: { name: string; ratePlanId: ID }[] }) {
    const row = await rpc<Record<string, unknown>>('open_visit', {
      p_table_ids: input.tableIds,
      p_guests: input.guests.map((g) => ({ name: g.name, ratePlanId: g.ratePlanId })),
    })
    return toVisit(row)
  }

  async addPass(visitId: ID, input: { name: string; ratePlanId: ID }) {
    const row = await rpc<Record<string, unknown>>('add_pass', {
      p_visit_id: visitId,
      p_name: input.name,
      p_rate_plan_id: input.ratePlanId,
    })
    return toPass(row)
  }

  async pausePass(passId: ID) {
    await rpc('pause_pass', { p_pass_id: passId })
  }

  async resumePass(passId: ID) {
    await rpc('resume_pass', { p_pass_id: passId })
  }

  async checkOutPass(passId: ID) {
    await rpc('check_out_pass', { p_pass_id: passId })
  }

  async passSettlement(passId: ID): Promise<PassSettlement> {
    return await rpc<PassSettlement>('pass_settlement', { p_pass_id: passId })
  }

  async settlePass(passId: ID, payments: PaymentInput[] = []) {
    await rpc('settle_pass', {
      p_pass_id: passId,
      p_payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
    })
  }

  async moveVisitToTables(visitId: ID, tableIds: ID[]) {
    await rpc('move_visit_to_tables', { p_visit_id: visitId, p_table_ids: tableIds })
  }

  async closeVisit(visitId: ID, payments: PaymentInput[] = []) {
    await rpc('close_visit', {
      p_visit_id: visitId,
      p_payments: payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        paidFor: p.paidFor ?? [],
      })),
    })
  }

  async rotateTableToken(tableId: ID) {
    return await rpc<string>('rotate_table_token', { p_table_id: tableId })
  }

  // ------------------------------------------------------------- Order ----

  async placeOrder(input: Parameters<DataPort['placeOrder']>[0]) {
    const row = await rpc<Record<string, unknown>>('place_order', {
      p_idempotency_key: input.idempotencyKey,
      p_visit_id: input.visitId,
      p_ordered_by_pass_id: input.orderedByPassId,
      p_split_mode: input.splitMode,
      p_placed_by: input.placedBy,
      p_allow_closed_kitchen: input.allowClosedKitchen ?? false,
      p_items: input.items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty, note: i.note ?? null })),
    })

    // RPC คืนแค่หัวออเดอร์ — ดึงรายการมาประกอบให้ครบตามสัญญาของ DataPort
    const sb = requireClient()
    const { data, error } = await sb.from('order_lines').select('*').eq('order_id', row.id as string)
    if (error) throw new Error(error.message)

    return toOrder(row, (data ?? []).map((l) => ({
      id: l.id,
      menuItemId: l.menu_item_id,
      nameSnapshot: l.name_snapshot,
      unitPriceSnapshot: Number(l.unit_price_snapshot),
      qty: l.qty,
      note: l.note ?? undefined,
    })))
  }

  async updateOrderStatus(orderId: ID, status: OrderStatus) {
    await rpc('update_order_status', { p_order_id: orderId, p_status: status })
  }

  // ------------------------------------------------------------- การจอง ----

  async confirmReservation(id: ID) {
    await rpc('confirm_reservation', { p_id: id })
  }

  async rejectReservation(id: ID, reason?: string) {
    await rpc('reject_reservation', { p_id: id, p_reason: reason ?? null })
  }

  async markNoShow(id: ID) {
    await rpc('mark_no_show', { p_id: id })
  }

  async seatReservation(id: ID, guests: { name: string; ratePlanId: ID }[], tableIds?: ID[]) {
    const row = await rpc<Record<string, unknown>>('seat_reservation', {
      p_id: id,
      p_guests: guests.map((g) => ({ name: g.name, ratePlanId: g.ratePlanId })),
      p_table_ids: tableIds ?? null,
    })
    return toVisit(row)
  }

  // -------------------------------------------------------------- Bill ----

  async previewBill(visitId: ID): Promise<BillPreview> {
    // ยอดมาจากฐานข้อมูลเสมอ ไม่คำนวณซ้ำฝั่ง client
    return await rpc<BillPreview>('preview_bill', { p_visit_id: visitId })
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireClient().rpc(fn, args)
  if (error) {
    // ข้อความ raise exception จาก Postgres เป็นภาษาไทยอยู่แล้ว ส่งต่อให้หน้าจอตรง ๆ
    throw new Error(error.message)
  }
  return data as T
}

// ------------------------------------------------------------- mappers ----

function toTable(r: Record<string, any>): CafeTable {
  return {
    id: r.id, code: r.code, zone: r.zone,
    seatMin: r.seat_min, seatMax: r.seat_max,
    allowShare: r.allow_share, status: r.status,
    sortOrder: r.sort_order, archived: r.archived ?? false,
    qrToken: r.qr_token,
  }
}

function toVisit(r: Record<string, any>): Visit {
  return {
    id: r.id, code: r.code, source: r.source, status: r.status,
    openedAt: r.opened_at, closedAt: r.closed_at,
    businessDate: r.business_date, note: r.note ?? undefined,
    sharedSettled: Number(r.shared_settled ?? 0),
  }
}

function toHours(r: Record<string, any>): ShopHours {
  return {
    weekday: r.weekday,
    openTime: String(r.open_time).slice(0, 5),
    closeTime: String(r.close_time).slice(0, 5),
    closed: r.closed,
    kitchenCloseTime: r.kitchen_close_time ? String(r.kitchen_close_time).slice(0, 5) : null,
  }
}

function toOccupancy(r: Record<string, any>): Occupancy {
  return { id: r.id, visitId: r.visit_id, tableId: r.table_id, fromAt: r.from_at, toAt: r.to_at }
}

function toPass(r: Record<string, any>): GuestPass {
  return {
    id: r.id, visitId: r.visit_id, displayName: r.display_name,
    ratePlanId: r.rate_plan_id, status: r.status,
    checkedInAt: r.checked_in_at, checkedOutAt: r.checked_out_at,
    pausedMinutes: r.paused_minutes, pausedAt: r.paused_at,
    rate: {
      name: r.rate_name ?? '',
      pricePerHour: Number(r.rate_price_per_hour),
      roundToMinutes: r.rate_round_to_minutes,
      minimumMinutes: r.rate_minimum_minutes,
      dayPassCap: r.rate_day_pass_cap === null ? null : Number(r.rate_day_pass_cap),
    },
  }
}

function toOrder(r: Record<string, any>, lines: Order['lines']): Order {
  return {
    id: r.id, visitId: r.visit_id, orderedByPassId: r.ordered_by_pass_id,
    placedBy: r.placed_by, splitMode: r.split_mode,
    tableIdSnapshot: r.table_id_snapshot, status: r.status,
    placedAt: r.placed_at, lines,
  }
}

function toMenuItem(r: Record<string, any>): MenuItem {
  return {
    id: r.id, sku: r.sku, name: r.name, category: r.category,
    price: Number(r.price), available: r.available,
    sortOrder: r.sort_order, archived: r.archived ?? false,
    imagePath: r.image_path ?? null,
  }
}

function toRatePlan(r: Record<string, any>): RatePlan {
  return {
    id: r.id, name: r.name,
    pricePerHour: Number(r.price_per_hour),
    roundToMinutes: r.round_to_minutes,
    minimumMinutes: r.minimum_minutes,
    dayPassCap: r.day_pass_cap === null ? null : Number(r.day_pass_cap),
    active: r.active ?? true, sortOrder: r.sort_order,
  }
}

function toReservation(r: Record<string, any>): Reservation {
  return {
    id: r.id, customerName: r.customer_name, phone: r.phone,
    partySize: r.party_size, startAt: r.start_at,
    durationMinutes: r.duration_minutes, zonePreference: r.zone_preference,
    status: r.status, tableIds: r.table_ids ?? [],
    code: r.code ?? null, source: r.source ?? 'staff',
    visitId: r.visit_id ?? null,
    note: r.note ?? undefined, staffNote: r.staff_note ?? undefined,
  }
}

export const supabaseAdapter = new SupabaseAdapter()

/**
 * ฝั่งลูกค้า — ไม่ต้องล็อกอิน ใช้ token จาก QR แทน
 *
 * ทุกตัวเป็น RPC ที่แปลง token เป็น visit เองฝั่งเซิร์ฟเวอร์
 * ลูกค้าไม่เคยส่ง visitId หรือ tableId มา จึงอ้างถึงโต๊ะอื่นไม่ได้
 */
/**
 * จองโต๊ะออนไลน์ — ลูกค้ายังไม่ได้มาร้าน จึงไม่มี QR token
 * ยืนยันตัวด้วยรหัสจอง + เบอร์โทรแทน (รหัสอย่างเดียวไม่พอ)
 */
export const supabaseBookingAdapter: BookingPort = {
  async hours() {
    const sb = requireClient()
    const { data, error } = await sb.from('shop_hours').select('*').order('weekday')
    if (error) throw new Error(error.message)
    return (data ?? []).map(toHours)
  },

  async config() {
    const sb = requireClient()
    const { data, error } = await sb.from('reservation_config').select('*').eq('id', 1).single()
    if (error) throw new Error(error.message)
    return {
      slotMinutes: data.slot_minutes,
      defaultDurationMinutes: data.default_duration_minutes,
      minDurationMinutes: data.min_duration_minutes,
      maxDurationMinutes: data.max_duration_minutes,
      maxAdvanceDays: data.max_advance_days,
      minAdvanceMinutes: data.min_advance_minutes,
    } as BookingConfig
  },

  async availableTables(startAt, durationMinutes) {
    return await rpc<AvailableTable[]>('available_tables', {
      p_start: startAt,
      p_duration: durationMinutes,
    })
  },

  async create(input) {
    return await rpc<BookingReceipt>('create_reservation', {
      p_customer_name: input.customerName,
      p_phone: input.phone,
      p_party_size: input.partySize,
      p_start_at: input.startAt,
      p_duration: input.durationMinutes,
      p_table_ids: input.tableIds,
      p_note: input.note ?? null,
    })
  },

  async lookup(code, phone) {
    return await rpc<BookingLookup>('reservation_by_code', { p_code: code, p_phone: phone })
  },

  async cancel(code, phone) {
    await rpc('cancel_reservation_by_code', { p_code: code, p_phone: phone })
  },
}

export const supabaseGuestAdapter: GuestPort = {
  async session(token) {
    return await rpc<GuestSession>('guest_session', { p_token: token })
  },
  async orders(token) {
    return await rpc<GuestOrder[]>('guest_orders', { p_token: token })
  },
  async bill(token) {
    return await rpc<BillPreview>('guest_bill', { p_token: token })
  },
  async placeOrder(input) {
    return await rpc('guest_place_order', {
      p_token: input.token,
      p_ordered_by_pass_id: input.orderedByPassId,
      p_split_mode: input.splitMode,
      p_items: input.items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty, note: i.note ?? null })),
      p_idempotency_key: input.idempotencyKey,
    })
  },
}
