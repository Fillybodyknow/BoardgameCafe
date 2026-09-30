import type { RealtimeChannel } from '@supabase/supabase-js'
import type { DataPort, Snapshot } from '../port'
import type {
  BillPreview, CafeTable, GameTitle, GuestPass, ID, MenuItem,
  Occupancy, Order, OrderStatus, RatePlan, Reservation, Visit,
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
      menu, games, loans, ratePlans, reservations,
    ] = await Promise.all([
      sb.from('cafe_tables').select('*').order('sort_order'),
      sb.from('visits').select('*').eq('status', 'open'),
      sb.from('occupancies').select('*'),
      sb.from('guest_passes').select('*'),
      sb.from('orders').select('*'),
      sb.from('order_lines').select('*'),
      sb.from('menu_items').select('*').order('sort_order'),
      sb.from('game_titles').select('*').order('name'),
      sb.from('game_loans').select('game_title_id').is('returned_at', null),
      sb.from('rate_plans').select('*').eq('active', true).order('sort_order'),
      sb.from('reservations').select('*').in('status', ['pending', 'confirmed', 'seated']),
    ])

    for (const res of [tables, visits, occupancies, passes, orders, orderLines, menu, games, loans, ratePlans, reservations]) {
      if (res.error) throw new Error(res.error.message)
    }

    // นับกล่องที่ถูกยืมอยู่ต่อชื่อเกม
    const onLoan = new Map<string, number>()
    for (const row of loans.data ?? []) {
      const id = row.game_title_id as string
      onLoan.set(id, (onLoan.get(id) ?? 0) + 1)
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
      games: (games.data ?? []).map((row) => toGame(row, onLoan.get(row.id) ?? 0)),
      ratePlans: (ratePlans.data ?? []).map(toRatePlan),
      reservations: (reservations.data ?? []).map(toReservation),
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

  async moveVisitToTables(visitId: ID, tableIds: ID[]) {
    await rpc('move_visit_to_tables', { p_visit_id: visitId, p_table_ids: tableIds })
  }

  async closeVisit(visitId: ID) {
    await rpc('close_visit', { p_visit_id: visitId, p_payments: [] })
  }

  // ------------------------------------------------------------- Order ----

  async placeOrder(input: Parameters<DataPort['placeOrder']>[0]) {
    const row = await rpc<Record<string, unknown>>('place_order', {
      p_idempotency_key: input.idempotencyKey,
      p_visit_id: input.visitId,
      p_ordered_by_pass_id: input.orderedByPassId,
      p_split_mode: input.splitMode,
      p_placed_by: input.placedBy,
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
  }
}

function toVisit(r: Record<string, any>): Visit {
  return {
    id: r.id, code: r.code, source: r.source, status: r.status,
    openedAt: r.opened_at, closedAt: r.closed_at,
    businessDate: r.business_date, note: r.note ?? undefined,
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
  }
}

function toGame(r: Record<string, any>, onLoan: number): GameTitle {
  return {
    id: r.id, name: r.name,
    minPlayers: r.min_players, maxPlayers: r.max_players,
    playMinutes: r.play_minutes, weight: r.weight,
    copies: r.copies, onLoan,
  }
}

function toRatePlan(r: Record<string, any>): RatePlan {
  return {
    id: r.id, name: r.name,
    pricePerHour: Number(r.price_per_hour),
    roundToMinutes: r.round_to_minutes,
    minimumMinutes: r.minimum_minutes,
    dayPassCap: r.day_pass_cap === null ? null : Number(r.day_pass_cap),
  }
}

function toReservation(r: Record<string, any>): Reservation {
  return {
    id: r.id, customerName: r.customer_name, phone: r.phone,
    partySize: r.party_size, startAt: r.start_at,
    durationMinutes: r.duration_minutes, zonePreference: r.zone_preference,
    status: r.status, tableIds: r.table_ids ?? [], note: r.note ?? undefined,
  }
}

export const supabaseAdapter = new SupabaseAdapter()
