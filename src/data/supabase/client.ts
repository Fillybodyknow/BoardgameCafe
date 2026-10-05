import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** ตั้งค่าครบหรือยัง — ถ้ายัง แอปจะถอยไปใช้ข้อมูลจำลอง */
export const hasSupabase = Boolean(url && anonKey)

/**
 * anon key เป็นข้อมูลสาธารณะโดยการออกแบบ — มันอยู่ใน bundle ที่ใครก็โหลดได้
 * สิ่งที่กันคนแปลกหน้าไว้คือ RLS + RPC ฝั่งฐานข้อมูล ไม่ใช่การซ่อนคีย์นี้
 */
export const supabase: SupabaseClient | null = hasSupabase
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null

export function requireClient(): SupabaseClient {
  if (!supabase) {
    throw new Error('ยังไม่ได้ตั้งค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  }
  return supabase
}

/**
 * แปลงชื่อผู้ใช้เป็นอีเมลที่ Supabase Auth ใช้ล็อกอิน
 *
 * Supabase ไม่มีการล็อกอินด้วย username ให้ ทุกบัญชีจึงมีอีเมลภายในที่
 * พนักงานไม่เคยเห็น และตาราง staff เป็นตัวแมปกลับ
 *
 * ไม่ต่อ "@โดเมน" เอาเองฝั่งนี้ เพราะถ้าฝั่งสร้างบัญชีใช้โดเมนคนละตัว
 * จะล็อกอินไม่ได้แบบเงียบ ๆ และบัญชีเดิมที่สร้างด้วยอีเมลจริงจะใช้ไม่ได้
 */
export async function emailForLogin(username: string): Promise<string> {
  const sb = requireClient()
  const { data, error } = await sb.rpc('login_email_for', { p_username: username })
  if (error) throw new Error(error.message)
  return String(data)
}
