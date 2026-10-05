import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { adminDb, shopLogoUrl } from '../data'
import { formatBytes, resizeToPng } from '../lib/image'
import { SHOP_PROFILE_KEY, useShopProfile } from '../hooks/useShop'
import { Button, Card, Field, INPUT, SectionTitle } from '../components/ui'

const NAME_MAX = 60
const TAGLINE_MAX = 80

/**
 * ชื่อร้านและโลโก้ — เฉพาะเจ้าของร้าน (สิทธิ์ branding)
 *
 * ใช้ทุกที่ที่ลูกค้าเห็น: แถบเมนู หน้าล็อกอิน หน้าจอง หน้าสแกน QR และหัวใบ QR
 * ที่พิมพ์ — มีตัวอย่างสดด้านข้าง ให้เห็นก่อนบันทึกว่าจะออกมาหน้าตาแบบไหน
 */
export default function BrandTab() {
  const qc = useQueryClient()
  const shop = useShopProfile()

  const [name, setName] = useState(shop.name)
  const [tagline, setTagline] = useState(shop.tagline)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // โหลดค่าจริงเสร็จทีหลัง (ครั้งแรกได้ค่าตั้งต้นมาก่อน) — ตามค่าจริงถ้ายังไม่ได้แก้อะไร
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) {
      setName(shop.name)
      setTagline(shop.tagline)
    }
  }, [shop.name, shop.tagline, touched])

  const logo = shopLogoUrl(shop.logoPath)
  const dirty = name.trim() !== shop.name || tagline.trim() !== shop.tagline

  async function act(fn: () => Promise<void>, ok: string) {
    setError(null)
    setNotice(null)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: SHOP_PROFILE_KEY })
      setNotice(ok)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    }
  }

  async function save() {
    setSaving(true)
    await act(() => adminDb.saveShopProfile({ name, tagline }), 'บันทึกชื่อร้านแล้ว — ทุกหน้าเปลี่ยนตามทันที')
    setTouched(false)
    setSaving(false)
  }

  async function upload(file: File | undefined) {
    if (!file) return
    setUploading(true)
    await act(async () => {
      const resized = await resizeToPng(file)
      await adminDb.uploadShopLogo(resized)
      setNotice(`ย่อจาก ${formatBytes(file.size)} เหลือ ${formatBytes(resized.blob.size)}`)
    }, 'เปลี่ยนโลโก้แล้ว')
    setUploading(false)
  }

  async function removeLogo() {
    if (!confirm('ถอดโลโก้ออก? จะกลับไปใช้ตราครั่ง ⚜ แทน')) return
    setUploading(true)
    await act(() => adminDb.removeShopLogo(), 'ถอดโลโก้แล้ว')
    setUploading(false)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section className="space-y-6">
        <div>
          <SectionTitle>ชื่อร้าน</SectionTitle>
          <Card className="space-y-3">
            <Field label={`ชื่อร้าน (${name.trim().length}/${NAME_MAX})`}>
              <input
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => {
                  setName(e.target.value)
                  setTouched(true)
                }}
                placeholder="เช่น ร้านเกมป้าแดง"
                className={INPUT}
              />
            </Field>
            <Field label={`คำโปรยใต้ชื่อ — ว่างได้ (${tagline.trim().length}/${TAGLINE_MAX})`}>
              <input
                value={tagline}
                maxLength={TAGLINE_MAX}
                onChange={(e) => {
                  setTagline(e.target.value)
                  setTouched(true)
                }}
                placeholder="เช่น เล่นจนลืมเวลา"
                className={INPUT}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={saving || !dirty || !name.trim()} onClick={() => void save()}>
                {saving ? 'กำลังบันทึก…' : 'บันทึกชื่อร้าน'}
              </Button>
              {dirty && (
                <Button
                  disabled={saving}
                  onClick={() => {
                    setName(shop.name)
                    setTagline(shop.tagline)
                    setTouched(false)
                  }}
                >
                  ยกเลิกที่แก้
                </Button>
              )}
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle>โลโก้</SectionTitle>
          <Card className="space-y-3">
            <div className="flex items-center gap-4">
              <div className="grid h-24 w-24 shrink-0 place-items-center rounded-xl border border-dashed border-line-strong bg-[repeating-conic-gradient(#eadfc6_0_25%,#fbf6ea_0_50%)] bg-[length:16px_16px] p-2">
                {logo ? (
                  <img src={logo} alt="โลโก้ร้าน" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-ink-faint">ยังไม่มีโลโก้</span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  disabled={uploading}
                  onChange={(e) => {
                    void upload(e.target.files?.[0])
                    e.target.value = ''
                  }}
                  className="block w-full text-xs text-ink-faint file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-vellum file:px-3 file:py-1.5 file:text-ink hover:file:border-gold"
                />
                {logo && (
                  <Button variant="danger" disabled={uploading} onClick={() => void removeLogo()}>
                    ถอดโลโก้
                  </Button>
                )}
              </div>
            </div>
            {uploading && <p className="text-xs text-ink-faint">กำลังย่อและอัปโหลด…</p>}
            <p className="text-xs text-ink-faint">
              แนะนำ PNG พื้นใส ทรงจัตุรัสหรือวงกลม — ย่อให้เหลือไม่เกิน 512px อัตโนมัติ
              ใบ QR ที่พิมพ์จะแปลงเป็นขาวดำ เพราะเครื่องพิมพ์ความร้อนพิมพ์สีไม่ได้
            </p>
          </Card>
        </div>

        {error && <p className="animate-shake text-sm text-crimson">{error}</p>}
        {notice && !error && (
          <p className="animate-unroll rounded-lg border border-forest/30 bg-forest/10 p-2 text-sm text-forest-deep">
            ✓ {notice}
          </p>
        )}
      </section>

      {/* ตัวอย่างสด — ใช้ค่าที่กำลังพิมพ์ ไม่ต้องบันทึกก่อนก็เห็น */}
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <SectionTitle>ตัวอย่าง</SectionTitle>
        <div className="space-y-3">
          <div className="tapestry rounded-xl px-5 py-6 text-center shadow-lg">
            {logo ? (
              <img src={logo} alt="" className="mx-auto h-16 w-16 object-contain" />
            ) : (
              <div className="wax-seal mx-auto h-16 w-16 text-3xl">⚜</div>
            )}
            <div className="brand mt-3 text-xl break-words">{name.trim() || 'ชื่อร้าน'}</div>
            {tagline.trim() && (
              <div className="mt-1 font-display text-[0.65rem] tracking-[0.3em] text-gold-light/60 uppercase">
                {tagline.trim()}
              </div>
            )}
          </div>
          <p className="text-center text-xs text-ink-faint">แถบเมนู · หน้าล็อกอิน · หน้าจอง · หน้าสแกน QR</p>

          <div className="mx-auto w-48 bg-white p-3 text-center text-black shadow-md">
            {logo && <img src={logo} alt="" className="mx-auto mb-1 h-10 object-contain grayscale contrast-150" />}
            <div className="text-xs font-bold">
              {logo ? '' : '⚜ '}
              {name.trim() || 'ชื่อร้าน'}
              {logo ? '' : ' ⚜'}
            </div>
            <div className="my-1 border-t border-dashed border-black" />
            <div className="text-[0.6rem]">โต๊ะ</div>
            <div className="text-2xl font-bold">A1</div>
          </div>
          <p className="text-center text-xs text-ink-faint">หัวใบ QR ที่พิมพ์ให้ลูกค้า</p>
        </div>
      </aside>
    </div>
  )
}
