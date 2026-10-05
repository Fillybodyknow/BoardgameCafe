import QRCode from 'qrcode'

/** สีหมึกบนกระดาษหนัง — ยังตัดกันชัดพอให้กล้องมือถืออ่านได้ */
export const QR_COLOR = { dark: '#2a1c12', light: '#fffdf7' }

/** URL ที่ฝังใน QR — ต้องเป็น absolute เพราะลูกค้าเปิดจากมือถือตัวเอง */
export function guestUrl(token: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/t/${token}`
}

export function bookingUrl(): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/book`
}

export function toQrDataUrl(url: string, width = 320): Promise<string> {
  return QRCode.toDataURL(url, { width, margin: 1, color: QR_COLOR })
}
