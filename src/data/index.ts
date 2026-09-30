import type { DataPort } from './port'
import { mockAdapter } from './mock/mockAdapter'
import { supabaseAdapter } from './supabase/supabaseAdapter'
import { hasSupabase } from './supabase/client'

/**
 * จุดสลับ backend — หน้าจอไม่รู้ว่าข้อมูลมาจากไหน
 *
 * ตั้งค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY แล้วใช้ของจริง
 * ไม่ตั้ง → ใช้ข้อมูลจำลองใน localStorage (โหมดเดโม)
 */
export const IS_MOCK = !hasSupabase

export const db: DataPort = hasSupabase ? supabaseAdapter : mockAdapter

export { mockAdapter }
export { hasSupabase, supabase } from './supabase/client'
export type { DataPort, Snapshot } from './port'
