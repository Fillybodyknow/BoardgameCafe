/**
 * จำการจองไว้บนเครื่องที่กดจอง
 *
 * ปัญหา: ลูกค้าจองเสร็จแล้ว พอกลับมาดูรายการต้องกรอกรหัสจอง + เบอร์โทรใหม่
 * ทั้งที่เพิ่งจองจากเครื่องนี้เอง
 *
 * วิธีที่ไม่ลดความปลอดภัย: จำไว้เฉพาะเครื่องที่จอง เครื่องอื่นยังต้องกรอก
 * รหัสคู่กับเบอร์โทรเหมือนเดิม — ไม่ได้เปิดให้ใครก็เปิดดูได้ด้วยรหัสอย่างเดียว
 *
 * เก็บเบอร์โทรไว้ด้วยเพราะต้องใช้คู่กับรหัสตอนเรียกดู เป็นข้อมูลของเจ้าของ
 * เครื่องเองและไม่ได้ออกไปไหน
 */

const KEY = 'bgcafe.mybookings.v1'
const MAX = 5
/** เก็บต่ออีกหนึ่งวันหลังถึงเวลานัด เผื่อกลับมาดูย้อนหลัง */
const KEEP_AFTER_MS = 24 * 3600_000

export interface RememberedBooking {
  code: string
  phone: string
  /** เวลานัด ใช้เรียงและลบของเก่าทิ้ง */
  startAt: string
}

function read(): RememberedBooking[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as RememberedBooking[]
    return Array.isArray(list) ? list.filter((b) => b && b.code && b.phone) : []
  } catch {
    // โหมดส่วนตัว ข้อมูลเสีย หรือโควตาเต็ม — ถือว่าไม่มีของที่จำไว้
    return []
  }
}

function write(list: RememberedBooking[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // จำไม่ได้ก็ไม่เป็นไร ลูกค้ายังกรอกรหัสเองได้
  }
}

/** รายการที่ยังไม่เก่าเกินไป ใกล้ถึงเวลานัดที่สุดอยู่บนสุด */
export function myBookings(now = new Date()): RememberedBooking[] {
  const alive = read().filter((b) => {
    const at = Date.parse(b.startAt)
    return Number.isNaN(at) || at + KEEP_AFTER_MS > now.getTime()
  })
  return alive.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
}

export function rememberBooking(b: RememberedBooking) {
  const rest = read().filter((x) => x.code !== b.code)
  write([b, ...rest].slice(0, MAX))
}

export function forgetBooking(code: string) {
  write(read().filter((b) => b.code !== code))
}
