import type { AdminPort, BookingPort, DataPort, GuestPort, ShopPort } from './port'
import { loadShopProfile } from './mock/shopStore'
import { SHOP_BUCKET, supabaseShopAdapter } from './supabase/shopAdapter'
import { mockAdapter, mockBookingAdapter, mockGuestAdapter } from './mock/mockAdapter'
import { mockAdminAdapter } from './mock/adminAdapter'
import { supabaseAdminAdapter } from './supabase/adminAdapter'
import {
  supabaseAdapter,
  supabaseBookingAdapter,
  supabaseGuestAdapter,
} from './supabase/supabaseAdapter'
import { hasSupabase } from './supabase/client'

/**
 * จุดสลับ backend — หน้าจอไม่รู้ว่าข้อมูลมาจากไหน
 *
 * ตั้งค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY แล้วใช้ของจริง
 * ไม่ตั้ง → ใช้ข้อมูลจำลองใน localStorage (โหมดเดโม)
 */
export const IS_MOCK = !hasSupabase

export const db: DataPort = hasSupabase ? supabaseAdapter : mockAdapter

/** ฝั่งลูกค้าที่สแกน QR — ไม่ต้องล็อกอิน */
export const guestDb: GuestPort = hasSupabase ? supabaseGuestAdapter : mockGuestAdapter

/** จองโต๊ะออนไลน์ — ลูกค้ายังไม่ได้มาร้าน ไม่มีทั้งบัญชีและ QR token */
export const bookingDb: BookingPort = hasSupabase ? supabaseBookingAdapter : mockBookingAdapter

/** ชื่อร้านและโลโก้ — อ่านได้โดยไม่ต้องล็อกอิน */
export const shopDb: ShopPort = hasSupabase
  ? supabaseShopAdapter
  : { profile: async () => loadShopProfile() }

/** ตั้งค่าร้าน — ระดับผู้จัดการขึ้นไป */
export const adminDb: AdminPort = hasSupabase ? supabaseAdminAdapter : mockAdminAdapter

/**
 * แปลง path ที่เก็บในฐานข้อมูลเป็น URL ที่เปิดได้จริง
 *
 * โหมดเดโมเก็บ data URL ไว้ตรง ๆ จึงคืนค่าเดิมกลับไป
 * โหมดจริงประกอบ URL จากโดเมนของโปรเจกต์ ณ ตอนนั้น — เหตุผลที่ฐานข้อมูล
 * เก็บแค่ path ไม่ใช่ URL เต็ม
 */
export function menuImageUrl(path?: string | null): string | null {
  if (!path) return null
  if (path.startsWith('data:')) return path
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined
  return base ? `${base}/storage/v1/object/public/menu-images/${path}` : null
}

/** URL ของโลโก้ร้าน — กติกาเดียวกับ menuImageUrl แต่คนละ bucket */
export function shopLogoUrl(path?: string | null): string | null {
  if (!path) return null
  if (path.startsWith('data:')) return path
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined
  return base ? `${base}/storage/v1/object/public/${SHOP_BUCKET}/${path}` : null
}

export { mockAdapter }
export { hasSupabase, supabase } from './supabase/client'
export type { AdminPort, BookingPort, DataPort, GuestPort, Snapshot } from './port'
