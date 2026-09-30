import type { DataPort } from './port'
import { mockAdapter } from './mock/mockAdapter'

/**
 * จุดสลับ backend — แก้ที่เดียว หน้าจอไม่ต้องรู้เรื่อง
 *
 * เมื่อมี Supabase แล้ว:
 *   const hasSupabase = Boolean(import.meta.env.VITE_SUPABASE_URL)
 *   export const db: DataPort = hasSupabase ? supabaseAdapter : mockAdapter
 */
export const db: DataPort = mockAdapter

export const IS_MOCK = true

export { mockAdapter }
export type { DataPort, Snapshot } from './port'
