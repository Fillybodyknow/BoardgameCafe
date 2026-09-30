import type { BookingPort, DataPort, GuestPort } from './port'
import { mockAdapter, mockBookingAdapter, mockGuestAdapter } from './mock/mockAdapter'
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

export { mockAdapter }
export { hasSupabase, supabase } from './supabase/client'
export type { BookingPort, DataPort, GuestPort, Snapshot } from './port'
