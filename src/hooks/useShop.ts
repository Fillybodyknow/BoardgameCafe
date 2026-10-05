import { useQuery } from '@tanstack/react-query'
import { shopDb } from '../data'
import { DEFAULT_PROFILE } from '../data/mock/shopStore'
import type { ShopProfile } from '../domain/types'

export const SHOP_PROFILE_KEY = ['shop', 'profile'] as const

/**
 * ชื่อร้านและโลโก้ — ใช้ได้ทุกหน้า รวมถึงหน้าที่ยังไม่ล็อกอิน
 *
 * ระหว่างโหลด หรือถ้าโหลดไม่ได้ (เช่นยังไม่ได้รัน patch-shop-profile.sql)
 * ใช้ค่าตั้งต้นไปก่อน หน้าจอจะได้ไม่ว่างหรือพังเพราะชื่อร้านอย่างเดียว
 */
export function useShopProfile(): ShopProfile {
  const q = useQuery({
    queryKey: SHOP_PROFILE_KEY,
    queryFn: () => shopDb.profile(),
    // เปลี่ยนนาน ๆ ครั้ง ไม่ต้องโหลดใหม่ทุกหน้า
    staleTime: 5 * 60_000,
  })
  return q.data ?? DEFAULT_PROFILE
}
