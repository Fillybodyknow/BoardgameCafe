import { shopLogoUrl } from '../data'
import { useShopProfile } from '../hooks/useShop'

/**
 * โลโก้ร้าน — ยังไม่ได้อัปโหลดก็ใช้ตราครั่ง ⚜ แทน
 * ขนาดกำหนดจากภายนอก (className) ให้ใช้ได้ทั้งแถบเมนูเล็ก ๆ และหัวหน้าใหญ่
 */
export default function ShopLogo({ className = 'h-12 w-12', seal = 'text-2xl' }: { className?: string; seal?: string }) {
  const shop = useShopProfile()
  const url = shopLogoUrl(shop.logoPath)
  if (url) {
    return <img src={url} alt={shop.name} className={`shrink-0 object-contain ${className}`} />
  }
  return (
    <div className={`wax-seal shrink-0 ${className} ${seal}`} aria-hidden>
      ⚜
    </div>
  )
}

/** ชื่อร้าน — แยกเป็น component ให้หน้าที่มี early return ใช้ได้โดยไม่ต้องย้าย hook */
export function ShopName() {
  return <>{useShopProfile().name}</>
}
