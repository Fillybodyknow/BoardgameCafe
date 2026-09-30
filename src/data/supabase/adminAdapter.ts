import type { AdminPort } from '../port'
import type {
  CafeTable, MenuItem, RatePlan, ShopHours, StaffRole, TaxConfig,
} from '../../domain/types'
import { requireClient } from './client'

/**
 * ตั้งค่าร้าน — ทุกการเขียนผ่าน RPC ที่เรียก assert_manager() ฝั่งฐานข้อมูล
 * หน้าจอที่ซ่อนเมนูไว้ไม่ใช่การป้องกัน เป็นแค่ความสะดวก
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireClient().rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

async function all<T>(table: string, order: string): Promise<T[]> {
  const { data, error } = await requireClient().from(table).select('*').order(order)
  if (error) throw new Error(error.message)
  return (data ?? []) as T[]
}

export const supabaseAdminAdapter: AdminPort = {
  async myRole() {
    return await rpc<StaffRole | null>('my_staff_role', {})
  },

  // หน้าตั้งค่าต้องเห็นของที่เก็บเข้ากรุด้วย ต่างจากหน้าร้านที่กรองออก
  async allMenuItems() {
    const rows = await all<Record<string, any>>('menu_items', 'sort_order')
    return rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, category: r.category,
      price: Number(r.price), available: r.available,
      sortOrder: r.sort_order, archived: r.archived,
    })) as MenuItem[]
  },

  async allTables() {
    const rows = await all<Record<string, any>>('cafe_tables', 'sort_order')
    return rows.map((r) => ({
      id: r.id, code: r.code, zone: r.zone,
      seatMin: r.seat_min, seatMax: r.seat_max,
      allowShare: r.allow_share, status: r.status,
      sortOrder: r.sort_order, archived: r.archived, qrToken: r.qr_token,
    })) as CafeTable[]
  },

  async allRatePlans() {
    const rows = await all<Record<string, any>>('rate_plans', 'sort_order')
    return rows.map((r) => ({
      id: r.id, name: r.name,
      pricePerHour: Number(r.price_per_hour),
      roundToMinutes: r.round_to_minutes,
      minimumMinutes: r.minimum_minutes,
      dayPassCap: r.day_pass_cap === null ? null : Number(r.day_pass_cap),
      active: r.active, sortOrder: r.sort_order,
    })) as RatePlan[]
  },

  async shopHours() {
    const rows = await all<Record<string, any>>('shop_hours', 'weekday')
    return rows.map((r) => ({
      weekday: r.weekday,
      openTime: String(r.open_time).slice(0, 5),
      closeTime: String(r.close_time).slice(0, 5),
      closed: r.closed,
    })) as ShopHours[]
  },

  async taxConfig() {
    const { data, error } = await requireClient()
      .from('tax_config').select('*').eq('id', 1).single()
    if (error) throw new Error(error.message)
    return {
      serviceChargeRate: Number(data.service_charge_rate),
      vatRate: Number(data.vat_rate),
      vatIncluded: data.vat_included,
    } as TaxConfig
  },

  async saveMenuItem(input) {
    await rpc('upsert_menu_item', {
      p_id: input.id,
      p_sku: input.sku,
      p_name: input.name,
      p_category: input.category,
      p_price: input.price,
      p_available: input.available,
      p_sort_order: input.sortOrder,
    })
  },

  async archiveMenuItem(id, archived) {
    await rpc('archive_menu_item', { p_id: id, p_archived: archived })
  },

  async saveTable(input) {
    await rpc('upsert_table', {
      p_id: input.id,
      p_code: input.code,
      p_zone: input.zone,
      p_seat_min: input.seatMin,
      p_seat_max: input.seatMax,
      p_allow_share: input.allowShare,
      p_sort_order: input.sortOrder,
    })
  },

  async archiveTable(id, archived) {
    await rpc('archive_table', { p_id: id, p_archived: archived })
  },

  async saveRatePlan(input) {
    await rpc('upsert_rate_plan', {
      p_id: input.id,
      p_name: input.name,
      p_per_hour: input.pricePerHour,
      p_round_to: input.roundToMinutes,
      p_minimum: input.minimumMinutes,
      p_cap: input.dayPassCap,
      p_active: input.active,
      p_sort_order: input.sortOrder,
    })
  },

  async saveShopHours(input) {
    await rpc('upsert_shop_hours', {
      p_weekday: input.weekday,
      p_open: input.openTime,
      p_close: input.closeTime,
      p_closed: input.closed,
    })
  },

  async saveTaxConfig(input) {
    await rpc('update_tax_config', {
      p_service_charge_rate: input.serviceChargeRate,
      p_vat_rate: input.vatRate,
      p_vat_included: input.vatIncluded,
    })
  },
}
