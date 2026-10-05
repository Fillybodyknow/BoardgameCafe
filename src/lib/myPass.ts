/**
 * จำว่าเครื่องนี้คือใครในโต๊ะไหน
 *
 * ลูกค้าลงชื่อครั้งเดียวหลังสแกน QR แล้วเครื่องจำไว้ ตอนสั่งของจึงไม่ต้อง
 * เลือกจากรายชื่อว่าใครสั่ง ซึ่งเป็นจุดที่คนมักเลื่อนผ่านแล้วออเดอร์ไปลงชื่อผิดคน
 *
 * ผูกกับ token ของโต๊ะ เพราะคนเดียวกันอาจย้ายไปโต๊ะใหม่ในวันถัดไป แล้วต้อง
 * ลงชื่อใหม่ ไม่ใช่ใช้ตัวตนเดิมของรอบที่แล้ว
 */

const KEY = 'bgcafe.mypass.v1'

export interface MyPass {
  passId: string
  displayName: string
}

type Store = Record<string, MyPass>

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Store
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    // โหมดส่วนตัว หรือข้อมูลเสีย — ถือว่ายังไม่เคยลงชื่อ
    return {}
  }
}

function write(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // จำไม่ได้ก็ยังใช้งานได้ แค่ต้องลงชื่อใหม่เมื่อรีเฟรช
  }
}

export function myPass(token: string): MyPass | null {
  return read()[token] ?? null
}

export function rememberMyPass(token: string, pass: MyPass) {
  write({ ...read(), [token]: pass })
}

export function forgetMyPass(token: string) {
  const store = read()
  delete store[token]
  write(store)
}
