import type { ShopHours, TaxConfig } from '../../domain/types'

/**
 * ที่เก็บเวลาทำการและภาษีของโหมดเดโม
 *
 * แยกออกมาเป็นไฟล์กลางเพราะทั้งหน้าตั้งค่า (adminAdapter) และหน้าจอง
 * (bookingAdapter) ต้องอ่านชุดเดียวกัน ถ้าต่างคนต่างเก็บ เจ้าของแก้เวลาทำการ
 * แล้วหน้าจองจะยังเสนอเวลาเดิม — ซึ่งเป็นบั๊กที่เคยเกิดจริง
 */

const HOURS_KEY = 'bgcafe.mock.hours.v1'
const TAX_KEY = 'bgcafe.mock.tax.v1'

export const DEFAULT_HOURS: ShopHours[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  openTime: '11:00',
  closeTime: '23:00',
  closed: false,
}))

export const DEFAULT_TAX: TaxConfig = {
  serviceChargeRate: 0,
  vatRate: 0.07,
  vatIncluded: true,
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // โควตาเต็ม/โหมดส่วนตัว — เดโมยังทำงานได้ในหน่วยความจำ
  }
}

export function loadHours(): ShopHours[] {
  return read(HOURS_KEY, DEFAULT_HOURS)
}

export function saveHours(hours: ShopHours[]) {
  write(HOURS_KEY, hours)
}

export function loadTax(): TaxConfig {
  return read(TAX_KEY, DEFAULT_TAX)
}

export function saveTax(tax: TaxConfig) {
  write(TAX_KEY, tax)
}

/** เวลาไทยของวันนั้น ใช้ตัดสินว่าอยู่ในเวลาทำการหรือยัง */
export function bangkokParts(iso: string): { weekday: number; minutes: number; date: string } {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000)
  return {
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
  }
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}
