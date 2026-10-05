import type { ShopPort } from '../port'
import { requireClient } from './client'

/** bucket ของโลโก้ แยกจากรูปเมนู (ดู migration 2000) */
export const SHOP_BUCKET = 'shop-assets'

export const supabaseShopAdapter: ShopPort = {
  async profile() {
    const { data, error } = await requireClient()
      .from('shop_profile')
      .select('name, tagline, logo_path')
      .single()
    if (error) throw new Error(error.message)
    return { name: data.name, tagline: data.tagline ?? '', logoPath: data.logo_path ?? null }
  },
}
