/**
 * ย่อรูปฝั่ง client ก่อนอัปโหลด
 *
 * ทำไมต้องย่อ: รูปจากมือถือใบละ 3–5MB ถ้าอัปดิบ ๆ ลูกค้าที่เปิดเมนูจะโหลด
 * หลายสิบเมกะไบต์ และกินโควตา egress ของ Supabase หมดเร็วมาก
 *
 * นี่ไม่ใช่มาตรการความปลอดภัย — ด่านจริงคือ file_size_limit กับ
 * allowed_mime_types ที่ตั้งไว้บน bucket ซึ่งคนแก้ค่าใน devtools ข้ามไม่ได้
 */

export const IMAGE_MAX_EDGE = 800
export const IMAGE_QUALITY = 0.8
export const IMAGE_MIME = 'image/jpeg'

export interface ResizedImage {
  blob: Blob
  /** ไว้แสดงตัวอย่างก่อนอัปโหลด และใช้เป็นที่เก็บรูปในโหมดเดโม */
  dataUrl: string
  width: number
  height: number
}

/** อ่านไฟล์เป็นรูป — โยน error ที่อ่านรู้เรื่องถ้าเบราว์เซอร์เปิดไฟล์นั้นไม่ได้ */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      // เคสที่เจอบ่อยสุด: ไฟล์ .heic จากไอโฟนที่ AirDrop มาลงคอมแล้วอัปจาก
      // เบราว์เซอร์อื่น — ถ้าไม่ดักไว้ จะได้รูปเปล่าขึ้นไปโดยไม่มีใครรู้
      reject(
        new Error(
          file.name.toLowerCase().endsWith('.heic')
            ? 'ไฟล์ .heic เปิดไม่ได้ในเบราว์เซอร์นี้ ลองแปลงเป็น .jpg ก่อน'
            : 'เปิดไฟล์รูปไม่ได้ ลองไฟล์อื่นครับ',
        ),
      )
    }
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement, quality: number, mime = IMAGE_MIME): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ'))),
      mime,
      quality,
    )
  })
}

/** ย่อให้ด้านยาวสุดไม่เกิน maxEdge แล้วบีบเป็น JPEG */
export async function resizeToJpeg(
  file: File,
  maxEdge = IMAGE_MAX_EDGE,
  quality = IMAGE_QUALITY,
): Promise<ResizedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('ไฟล์นี้ไม่ใช่รูปภาพ')
  }

  const img = await loadImage(file)
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.round(img.naturalWidth * scale)
  const height = Math.round(img.naturalHeight * scale)

  if (width === 0 || height === 0) {
    throw new Error('รูปนี้ไม่มีขนาด ลองไฟล์อื่นครับ')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('เบราว์เซอร์นี้ย่อรูปไม่ได้')

  // JPEG ไม่มีพื้นหลังโปร่งใส ถ้าต้นฉบับเป็น PNG โปร่งใสแล้วไม่ทาสีรองไว้
  // พื้นที่โปร่งจะกลายเป็นสีดำ
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await toBlob(canvas, quality)
  return { blob, dataUrl: canvas.toDataURL(IMAGE_MIME, quality), width, height }
}

/** โลโก้ร้านเล็กกว่ารูปเมนูมาก — แสดงไม่เกิน ~100px แม้บนจอความละเอียดสูง */
export const LOGO_MAX_EDGE = 512

/**
 * ย่อโลโก้เป็น PNG — ต่างจากรูปเมนูตรงที่ต้องเก็บพื้นโปร่งใสไว้
 * โลโก้ส่วนใหญ่เป็น PNG พื้นใส ถ้าแปลงเป็น JPEG จะได้กรอบสี่เหลี่ยมสีขาวรอบโลโก้
 */
export async function resizeToPng(file: File, maxEdge = LOGO_MAX_EDGE): Promise<ResizedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('ไฟล์นี้ไม่ใช่รูปภาพ')
  }

  const img = await loadImage(file)
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.round(img.naturalWidth * scale)
  const height = Math.round(img.naturalHeight * scale)
  if (width === 0 || height === 0) {
    throw new Error('รูปนี้ไม่มีขนาด ลองไฟล์อื่นครับ')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('เบราว์เซอร์นี้ย่อรูปไม่ได้')
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await toBlob(canvas, 1, 'image/png')
  return { blob, dataUrl: canvas.toDataURL('image/png'), width, height }
}

export function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
