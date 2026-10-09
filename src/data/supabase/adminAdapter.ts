import type { AdminPort } from '../port'
import type {
  BookingConfig, CafeTable, Capability, MenuItem, RatePlan, ShopHours,
  StaffMember, StaffRole, TaxConfig,
} from '../../domain/types'
import { requireClient } from './client'
import { SHOP_BUCKET } from './shopAdapter'

export const BUCKET = 'menu-images'
export const TABLE_BUCKET = 'table-images'

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

  async myCapabilities() {
    return (await rpc<Capability[] | null>('my_capabilities', {})) ?? []
  },

  // หน้าตั้งค่าต้องเห็นของที่เก็บเข้ากรุด้วย ต่างจากหน้าร้านที่กรองออก
  async allMenuItems(): Promise<MenuItem[]> {
    const rows = await all<Record<string, any>>('menu_items', 'sort_order')
    return rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, category: r.category,
      price: Number(r.price), available: r.available,
      sortOrder: r.sort_order, archived: r.archived,
      imagePath: r.image_path ?? null,
    }))
  },

  async allTables(): Promise<CafeTable[]> {
    const rows = await all<Record<string, any>>('cafe_tables', 'sort_order')
    return rows.map((r) => ({
      id: r.id, code: r.code, zone: r.zone,
      seatMin: r.seat_min, seatMax: r.seat_max,
      allowShare: r.allow_share, status: r.status,
      sortOrder: r.sort_order, archived: r.archived, qrToken: r.qr_token,
      imagePath: r.image_path ?? null,
    }))
  },

  async allRatePlans(): Promise<RatePlan[]> {
    const rows = await all<Record<string, any>>('rate_plans', 'sort_order')
    return rows.map((r) => ({
      id: r.id, name: r.name,
      pricePerHour: Number(r.price_per_hour),
      roundToMinutes: r.round_to_minutes,
      minimumMinutes: r.minimum_minutes,
      dayPassCap: r.day_pass_cap === null ? null : Number(r.day_pass_cap),
      active: r.active, sortOrder: r.sort_order,
    }))
  },

  async shopHours(): Promise<ShopHours[]> {
    const rows = await all<Record<string, any>>('shop_hours', 'weekday')
    // ไม่ cast ด้วย `as ShopHours[]` โดยเด็ดขาด — ของเดิม cast ไว้ แล้วตอน
    // เพิ่มฟิลด์ใหม่ TypeScript เลยไม่ฟ้องว่าลืมแปลง ผลคือหน้าตั้งค่าแสดง
    // เวลาปิดครัวเป็นค่าว่างตลอด และเผลอล้างค่าทิ้งเมื่อแก้ช่องอื่นของวันนั้น
    return rows.map((r) => ({
      weekday: r.weekday,
      openTime: String(r.open_time).slice(0, 5),
      closeTime: String(r.close_time).slice(0, 5),
      closed: r.closed,
      kitchenCloseTime: r.kitchen_close_time ? String(r.kitchen_close_time).slice(0, 5) : null,
    }))
  },

  async taxConfig(): Promise<TaxConfig> {
    const { data, error } = await requireClient()
      .from('tax_config').select('*').eq('id', 1).single()
    if (error) throw new Error(error.message)
    return {
      serviceChargeRate: Number(data.service_charge_rate),
      vatRate: Number(data.vat_rate),
      vatIncluded: data.vat_included,
    }
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

  /**
   * อัปโหลดไฟล์ก่อน แล้วค่อยผูกกับเมนู
   *
   * ลำดับนี้สำคัญ: ถ้าผูกก่อนแล้วอัปโหลดพัง เมนูจะชี้ไปไฟล์ที่ไม่มีอยู่จริง
   * ทำแบบนี้แย่ที่สุดคือมีไฟล์ค้างที่ไม่มีใครอ้างถึง ซึ่งไม่กระทบการใช้งาน
   */
  async uploadMenuImage(id, image) {
    const sb = requireClient()
    const path = `menu/${crypto.randomUUID()}.jpg`

    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(path, image.blob, { contentType: 'image/jpeg', upsert: false })
    if (upErr) throw new Error(upErr.message)

    let old: string | null = null
    try {
      old = await rpc<string | null>('set_menu_image', { p_id: id, p_path: path })
    } catch (e) {
      // ผูกไม่สำเร็จ — เก็บไฟล์ที่เพิ่งอัปทิ้ง ไม่ให้ค้างเป็นขยะ
      await sb.storage.from(BUCKET).remove([path])
      throw e
    }

    if (old && old !== path) {
      // ลบรูปเก่าแบบ best-effort ถ้าลบไม่ได้ก็แค่ไฟล์ค้าง ไม่ทำให้อะไรพัง
      await sb.storage.from(BUCKET).remove([old])
    }
  },

  async removeMenuImage(id) {
    const old = await rpc<string | null>('set_menu_image', { p_id: id, p_path: null })
    if (old) await requireClient().storage.from(BUCKET).remove([old])
  },

  async uploadTableImage(id, image) {
    const sb = requireClient()
    const path = `table/${crypto.randomUUID()}.jpg`

    const { error: upErr } = await sb.storage
      .from(TABLE_BUCKET)
      .upload(path, image.blob, { contentType: 'image/jpeg', upsert: false })
    if (upErr) throw new Error(upErr.message)

    let old: string | null = null
    try {
      old = await rpc<string | null>('set_table_image', { p_id: id, p_path: path })
    } catch (e) {
      // ผูกไม่สำเร็จ — เก็บไฟล์ที่เพิ่งอัปทิ้ง ไม่ให้ค้างเป็นขยะ
      await sb.storage.from(TABLE_BUCKET).remove([path])
      throw e
    }

    if (old && old !== path) {
      await sb.storage.from(TABLE_BUCKET).remove([old])
    }
  },

  async removeTableImage(id) {
    const old = await rpc<string | null>('set_table_image', { p_id: id, p_path: null })
    if (old) await requireClient().storage.from(TABLE_BUCKET).remove([old])
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

  async bookingConfig(): Promise<BookingConfig> {
    const { data, error } = await requireClient()
      .from('reservation_config').select('*').eq('id', 1).single()
    if (error) throw new Error(error.message)
    return {
      slotMinutes: data.slot_minutes,
      defaultDurationMinutes: data.default_duration_minutes,
      minDurationMinutes: data.min_duration_minutes,
      maxDurationMinutes: data.max_duration_minutes,
      maxAdvanceDays: data.max_advance_days,
      minAdvanceMinutes: data.min_advance_minutes,
    }
  },

  async saveMaxAdvanceDays(days) {
    await rpc('set_max_advance_days', { p_days: days })
  },

  async saveShopHours(input) {
    await rpc('upsert_shop_hours', {
      p_weekday: input.weekday,
      p_open: input.openTime,
      p_close: input.closeTime,
      p_closed: input.closed,
      p_kitchen_close: input.kitchenCloseTime,
    })
  },

  async listStaff() {
    return await rpc<StaffMember[]>('list_staff', {})
  },

  /**
   * เรียก Edge Function แทน RPC เพราะต้องใช้ service_role สร้างบัญชี Auth
   * ซึ่งอยู่ฝั่งเบราว์เซอร์ไม่ได้
   */
  async createStaff(input) {
    const { data, error } = await requireClient().functions.invoke('create-staff', {
      body: {
        username: input.username,
        password: input.password,
        displayName: input.displayName,
        role: input.role,
      },
    })

    if (error) {
      // functions.invoke ซ่อนข้อความจริงไว้ใน response ถ้าไม่แกะออกมา
      // ผู้ใช้จะเห็นแค่ "Edge Function returned a non-2xx status code"
      const res = (error as { context?: Response }).context

      if (res && typeof res.json === 'function') {
        let detail = ''
        try {
          detail = ((await res.json()) as { error?: string }).error ?? ''
        } catch {
          detail = ''
        }
        throw new Error(detail || `สร้างบัญชีไม่สำเร็จ (HTTP ${res.status})`)
      }

      // ไม่มี response กลับมาเลย = ไปไม่ถึงเซิร์ฟเวอร์ ซึ่งแทบทุกครั้งคือ CORS
      // หรือยังไม่ได้ deploy — ต้องแยกจากกรณีเซิร์ฟเวอร์ตอบ error เพราะวิธีแก้
      // คนละเรื่องกันสิ้นเชิง
      throw new Error(
        'ติดต่อบริการสร้างบัญชีไม่ได้ — ตรวจว่า deploy Edge Function ชื่อ create-staff ' +
          'แล้วหรือยัง และเป็นเวอร์ชันล่าสุด (ดูรายละเอียดใน console ของเบราว์เซอร์)',
      )
    }
    if (data && typeof data === 'object' && 'error' in data) {
      throw new Error(String((data as { error: unknown }).error))
    }
  },

  async setStaffRole(userId, role) {
    await rpc('set_staff_role', { p_user_id: userId, p_role: role })
  },

  async setStaffActive(userId, active) {
    await rpc('set_staff_active', { p_user_id: userId, p_active: active })
  },

  async renameStaff(userId, name) {
    await rpc('rename_staff', { p_user_id: userId, p_name: name })
  },

  async saveShopProfile(input) {
    await rpc('update_shop_profile', { p_name: input.name, p_tagline: input.tagline })
  },

  // ลำดับเดียวกับรูปเมนู: อัปไฟล์ → ผูกกับร้าน → ลบไฟล์เดิม
  async uploadShopLogo(image) {
    const sb = requireClient()
    const path = `logo/${crypto.randomUUID()}.png`

    const { error: upErr } = await sb.storage
      .from(SHOP_BUCKET)
      .upload(path, image.blob, { contentType: 'image/png', upsert: false })
    if (upErr) throw new Error(upErr.message)

    let old: string | null = null
    try {
      old = await rpc<string | null>('set_shop_logo', { p_path: path })
    } catch (e) {
      // ผูกไม่สำเร็จ — เก็บไฟล์ที่เพิ่งอัปทิ้ง ไม่ให้ค้างเป็นขยะ
      await sb.storage.from(SHOP_BUCKET).remove([path])
      throw e
    }
    if (old && old !== path) await sb.storage.from(SHOP_BUCKET).remove([old])
  },

  async removeShopLogo() {
    const old = await rpc<string | null>('set_shop_logo', { p_path: null })
    if (old) await requireClient().storage.from(SHOP_BUCKET).remove([old])
  },

  async saveTaxConfig(input) {
    await rpc('update_tax_config', {
      p_service_charge_rate: input.serviceChargeRate,
      p_vat_rate: input.vatRate,
      p_vat_included: input.vatIncluded,
    })
  },
}
