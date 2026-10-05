import type { AdminPort } from '../port'
import type { StaffMember, StaffRole } from '../../domain/types'
import { loadStaff, saveStaff } from './shopStore'
import { mockAdapter } from './mockAdapter'
import { loadHours, loadTax, saveHours, saveTax } from './shopStore'

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
    return loadHours()
  },
  async taxConfig() {
    return loadTax()
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

  // โหมดเดโมไม่มี Storage จึงเก็บรูปที่ย่อแล้วเป็น data URL ลง localStorage
  // ได้ผลเพราะย่อเหลือ ~40KB ถ้าไม่ย่อจะเต็มโควตาทันที
  async uploadMenuImage(id, image) {
    mockAdapter.setMenuImage(id, image.dataUrl)
  },

  async removeMenuImage(id) {
    mockAdapter.setMenuImage(id, null)
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
    saveHours(loadHours().map((h) => (h.weekday === input.weekday ? { ...input } : h)))
  },

  // ---------- บัญชีพนักงาน ----------
  // ตรวจกติกาเดียวกับ RPC ฝั่ง SQL โดยเฉพาะข้อที่สำคัญที่สุด:
  // ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อยหนึ่งคนเสมอ

  async listStaff() {
    return loadStaff()
  },

  async createStaff(input) {
    const list = loadStaff()
    const username = input.username.trim().toLowerCase()

    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
      throw new Error(
        'ชื่อผู้ใช้ต้องยาว 3–30 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข',
      )
    }
    if (input.password.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัว')
    if (!input.displayName.trim()) throw new Error('ต้องใส่ชื่อพนักงาน')
    if (list.some((s) => s.username === username)) {
      throw new Error(`ชื่อผู้ใช้ "${username}" ถูกใช้ไปแล้ว`)
    }

    saveStaff([
      ...list,
      {
        userId: `u-${username}`,
        username,
        displayName: input.displayName.trim(),
        role: input.role,
        active: true,
        email: `${username}@staff.boardgamecafe.local`,
        createdAt: new Date().toISOString(),
        isSelf: false,
      },
    ])
  },

  async setStaffRole(userId, role) {
    const list = loadStaff()
    const target = mustStaff(list, userId)

    if (target.isSelf && target.role !== role) {
      throw new Error('เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้ ให้คนอื่นเปลี่ยนให้')
    }
    if (role !== 'owner') assertOwnerRemains(list, target)

    saveStaff(list.map((s) => (s.userId === userId ? { ...s, role } : s)))
  },

  async setStaffActive(userId, active) {
    const list = loadStaff()
    const target = mustStaff(list, userId)

    if (target.isSelf && !active) throw new Error('ปิดการใช้งานบัญชีตัวเองไม่ได้')
    if (!active) assertOwnerRemains(list, target)

    saveStaff(list.map((s) => (s.userId === userId ? { ...s, active } : s)))
  },

  async renameStaff(userId, name) {
    if (!name.trim()) throw new Error('ต้องใส่ชื่อ')
    const list = loadStaff()
    mustStaff(list, userId)
    saveStaff(list.map((s) => (s.userId === userId ? { ...s, displayName: name.trim() } : s)))
  },

  async saveTaxConfig(input) {
    if (
      input.serviceChargeRate < 0 || input.serviceChargeRate > 1 ||
      input.vatRate < 0 || input.vatRate > 1
    ) {
      throw new Error('อัตราต้องอยู่ระหว่าง 0 ถึง 1 (เช่น 0.07 = 7%)')
    }
    saveTax(input)
  },
}

function mustStaff(list: StaffMember[], userId: string): StaffMember {
  const found = list.find((s) => s.userId === userId)
  if (!found) throw new Error('ไม่พบพนักงานคนนี้')
  return found
}

/** ตรงกับ assert_owner_remains() ฝั่ง SQL — กันร้านล็อกตัวเองจนแก้อะไรไม่ได้ */
function assertOwnerRemains(list: StaffMember[], target: StaffMember) {
  const activeOwners = list.filter((s) => s.role === 'owner' && s.active)
  if (target.role === 'owner' && target.active && activeOwners.length <= 1) {
    throw new Error('ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คน')
  }
}

export type { StaffRole }
