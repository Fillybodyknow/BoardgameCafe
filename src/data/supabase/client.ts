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
