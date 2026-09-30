import type { AdminPort } from '../port'
import type { ShopHours, TaxConfig } from '../../domain/types'
import { mockAdapter } from './mockAdapter'

const HOURS_KEY = 'bgcafe.mock.hours.v1'
const TAX_KEY = 'bgcafe.mock.tax.v1'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // โควตาเต็ม/โหมดส่วนตัว — เดโมยังทำงานได้ในหน่วยความจำ
  }
}

const DEFAULT_HOURS: ShopHours[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  openTime: '11:00',
  closeTime: '23:00',
  closed: false,
}))

const DEFAULT_TAX: TaxConfig = { serviceChargeRate: 0, vatRate: 0.07, vatIncluded: true }

/**
 * โหมดเดโม — ตรวจกติกาเดียวกับ RPC ฝั่ง SQL
 *
 * ถ้าปล่อยให้โหมดนี้หละหลวมกว่า บั๊กจะผ่านเดโมไปโผล่ตอนขึ้นฐานข้อมูลจริง
 * (เคยเกิดมาแล้วสองครั้งในโปรเจกต์นี้)
 */
export const mockAdminAdapter: AdminPort = {
  async myRole() {
    return 'owner'
  },

  async allMenuItems() {
    return await mockAdapter.menuForAdmin()
  },
  async allTables() {
    return await mockAdapter.tablesForAdmin()
  },
  async allRatePlans() {
    return await mockAdapter.ratePlansForAdmin()
  },
  async shopHours() {
    return load(HOURS_KEY, DEFAULT_HOURS)
  },
  async taxConfig() {
    return load(TAX_KEY, DEFAULT_TAX)
  },

  async saveMenuItem(input) {
    if (!input.name.trim()) throw new Error('ต้องใส่ชื่อเมนู')
    if (!input.sku.trim()) throw new Error('ต้องใส่รหัสเมนู')
    if (input.price < 0) throw new Error('ราคาติดลบไม่ได้')
    mockAdapter.saveMenuItem({ ...input, sku: input.sku.trim().toUpperCase() })
  },

  async archiveMenuItem(id, archived) {
    mockAdapter.archiveMenuItem(id, archived)
  },

  async saveTable(input) {
    if (!input.code.trim()) throw new Error('ต้องใส่รหัสโต๊ะ')
    if (input.seatMin < 1 || input.seatMax < input.seatMin) {
      throw new Error('จำนวนที่นั่งไม่ถูกต้อง')
    }
    mockAdapter.saveTable({ ...input, code: input.code.trim().toUpperCase() })
  },

  async archiveTable(id, archived) {
    mockAdapter.archiveTable(id, archived)
  },

  async saveRatePlan(input) {
    if (!input.name.trim()) throw new Error('ต้องใส่ชื่อเรต')
    if (input.pricePerHour < 0 || input.roundToMinutes < 1 || input.minimumMinutes < 0) {
      throw new Error('ค่าที่กรอกไม่ถูกต้อง')
    }
    if (input.dayPassCap !== null && input.dayPassCap < 0) {
      throw new Error('เพดานเหมาวันติดลบไม่ได้')
    }
    mockAdapter.saveRatePlan(input)
  },

  async saveShopHours(input) {
    if (!input.closed && input.closeTime <= input.openTime) {
      throw new Error('เวลาปิดต้องหลังเวลาเปิด (ยังไม่รองรับร้านที่ปิดข้ามวัน)')
    }
    const hours = load(HOURS_KEY, DEFAULT_HOURS).map((h) =>
      h.weekday === input.weekday ? { ...input } : h,
    )
    save(HOURS_KEY, hours)
  },

  async saveTaxConfig(input) {
    if (
      input.serviceChargeRate < 0 || input.serviceChargeRate > 1 ||
      input.vatRate < 0 || input.vatRate > 1
    ) {
      throw new Error('อัตราต้องอยู่ระหว่าง 0 ถึง 1 (เช่น 0.07 = 7%)')
    }
    save(TAX_KEY, input)
  },
}
