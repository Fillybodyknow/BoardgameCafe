import QRCode from 'qrcode'
export { guestUrl } from './qr'

/**
 * พิมพ์ใบ QR ของโต๊ะลงเครื่องพิมพ์ความร้อน (thermal / slip printer)
 *
 * ใช้ไดรเวอร์ของระบบปฏิบัติการผ่าน window.print() ไม่ได้คุยกับเครื่องพิมพ์ตรง
 * เพราะใช้ได้กับทุกเครื่องที่ลงไดรเวอร์แล้ว ไม่ว่าจะต่อ USB / LAN / Bluetooth
 * และพิมพ์ภาษาไทยได้ถูกต้องเสมอ (ESC/POS ตรง ๆ ต้องปวดหัวกับ code page ไทย)
 *
 * ใบถูกจัดให้พอดีความกว้างหัวพิมพ์จริง ไม่ใช่ความกว้างกระดาษ:
 *   กระดาษ 80mm → หัวพิมพ์ 72mm,  กระดาษ 58mm → หัวพิมพ์ 48mm
 * ถ้าจัดเต็มความกว้างกระดาษ ขอบขวาจะถูกตัดหาย
 */

export type PaperWidth = 58 | 80

export interface PrinterSettings {
  paper: PaperWidth
  /** เปิดโต๊ะแล้วสั่งพิมพ์ทันที ไม่ต้องกดปุ่มพิมพ์ */
  autoPrint: boolean
  /** บรรทัดท้ายใบ เช่น ชื่อ Wi-Fi หรือคำขอบคุณ */
  footer: string
}

export const DEFAULT_PRINTER: PrinterSettings = {
  paper: 80,
  autoPrint: false,
  footer: 'ขอให้สนุกกับเกม!',
}

/** พื้นที่ที่หัวพิมพ์พิมพ์ได้จริง (มม.) */
const PRINTABLE_MM: Record<PaperWidth, number> = { 58: 48, 80: 72 }

// เครื่องพิมพ์ผูกกับเครื่องที่ใช้งาน ไม่ใช่ร้าน — เก็บไว้ในเบราว์เซอร์นี้
const KEY = 'bgcafe.printer.v1'

export function loadPrinter(): PrinterSettings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_PRINTER, ...(JSON.parse(raw) as Partial<PrinterSettings>) } : DEFAULT_PRINTER
  } catch {
    return DEFAULT_PRINTER
  }
}

export function savePrinter(settings: PrinterSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // โหมดส่วนตัว/โควตาเต็ม — ใช้ค่าในหน่วยความจำต่อไป
  }
}

/**
 * QR แบบ SVG — คมทุกความละเอียดหัวพิมพ์ และไม่ต้องใช้ canvas
 * ขาวดำล้วน เพราะหัวพิมพ์ความร้อนพิมพ์สีเทาไม่ได้
 */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 0,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

export interface TableSlip {
  tableCode: string
  zone: string
  visitCode: string
  openedAt: string
  url: string
  /** ชื่อร้านและโลโก้จากหน้าตั้งค่าร้าน — ที่เดียวกับที่ลูกค้าเห็นบนจอ */
  shopName: string
  logoUrl?: string | null
  /** ใบทดสอบจากหน้าตั้งค่า — พิมพ์คำว่า "ทดสอบ" กำกับ กันเอาไปใช้จริง */
  test?: boolean
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** หน้า HTML ของใบ QR — แยกออกมาให้หน้าตัวอย่างกับใบที่พิมพ์ออกมาตรงกัน */
export function slipHtml(slip: TableSlip, settings: PrinterSettings, svg: string): string {
  const width = PRINTABLE_MM[settings.paper]
  const small = settings.paper === 58
  const opened = new Date(slip.openedAt)
  const time = opened.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  // ไม่ใส่ปี — กระดาษ 58mm แคบจนปีตกไปอยู่บรรทัดใหม่คนเดียว
  const date = opened.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>QR โต๊ะ ${esc(slip.tableCode)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap">
<style id="page">
  /* ความยาวจริงถูกวัดแล้วเขียนทับตอนสั่งพิมพ์ (ดู fitPageToContent) */
  @page { size: ${settings.paper}mm 200mm; margin: 0; }
</style>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body {
    width: ${width}mm; margin: 0 auto; padding: 3mm 0 10mm;
    font-family: 'Sarabun', 'Leelawadee UI', Tahoma, sans-serif;
    font-size: ${small ? 9.5 : 11}pt; line-height: 1.35; text-align: center;
  }
  .shop { font-size: ${small ? 11 : 13}pt; font-weight: 700; letter-spacing: .04em; }
  .rule { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .label { font-size: ${small ? 9 : 10}pt; }
  .table { font-size: ${small ? 28 : 36}pt; font-weight: 700; line-height: 1; margin: .5mm 0 1.5mm; }
  .meta { font-size: ${small ? 8.5 : 9.5}pt; }
  .qr { width: ${small ? 38 : 48}mm; margin: 3mm auto; }
  .qr svg { width: 100%; height: auto; display: block; }
  .steps { text-align: left; margin: 0 auto; padding-left: 5mm; font-size: ${small ? 9 : 10}pt; }
  .steps li { margin: .5mm 0; }
  .note { font-size: ${small ? 8 : 8.5}pt; margin-top: 2mm; }
  /* หัวพิมพ์ความร้อนพิมพ์ได้แค่ขาวดำ — แปลงโลโก้เป็นขาวดำเอง จะได้เห็นตรงกับตัวอย่าง */
  .logo { display: block; max-width: ${small ? 18 : 24}mm; max-height: ${small ? 14 : 18}mm; margin: 0 auto 1.5mm; filter: grayscale(1) contrast(1.6); }
  .test { border: 2px solid #000; font-weight: 700; padding: 1mm; margin-bottom: 2mm; }
  b { font-weight: 700; }
</style></head><body>
  ${slip.test ? '<div class="test">ใบทดสอบ — ใช้สั่งของไม่ได้</div>' : ''}
  ${slip.logoUrl ? `<img class="logo" src="${esc(slip.logoUrl)}" alt="">` : ''}
  <div class="shop">${slip.logoUrl ? '' : '⚜ '}${esc(slip.shopName)}${slip.logoUrl ? '' : ' ⚜'}</div>
  <div class="rule"></div>
  <div class="label">โต๊ะ</div>
  <div class="table">${esc(slip.tableCode)}</div>
  <div class="meta">${esc(slip.zone)}${slip.zone ? ' · ' : ''}${esc(slip.visitCode)} · เปิด ${time} น. ${date}</div>
  <div class="qr">${svg}</div>
  <div><b>สแกนด้วยกล้องมือถือ</b></div>
  <ol class="steps">
    <li>ลงชื่อของคุณ</li>
    <li>สั่งอาหารและเครื่องดื่ม</li>
    <li>ดูยอดของโต๊ะได้ตลอด</li>
  </ol>
  <div class="rule"></div>
  <div class="note">QR นี้ใช้ได้เฉพาะรอบนี้<br>หมดอายุเมื่อชำระเงิน<br>กรุณาอย่าแชร์ให้คนนอกโต๊ะ</div>
  ${settings.footer ? `<div class="note"><b>${esc(settings.footer)}</b></div>` : ''}
</body></html>`
}

/** พิมพ์ใบ QR ของโต๊ะ */
export async function printTableSlip(slip: TableSlip, settings = loadPrinter()) {
  const svg = await qrSvg(slip.url)
  await printHtml(slipHtml(slip, settings, svg))
}

/**
 * พิมพ์ผ่าน iframe ที่ซ่อนอยู่ ไม่เปิดหน้าต่างใหม่
 * popup ถูกเบราว์เซอร์บล็อกได้ โดยเฉพาะตอนสั่งพิมพ์อัตโนมัติที่ไม่ได้มาจากการกดปุ่ม
 */
function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0'
    document.body.appendChild(frame)

    const win = frame.contentWindow
    const doc = frame.contentDocument
    if (!win || !doc) {
      frame.remove()
      resolve()
      return
    }
    doc.open()
    doc.write(html)
    doc.close()

    const cleanup = () => setTimeout(() => frame.remove(), 500)
    win.addEventListener('afterprint', cleanup, { once: true })
    // บางเบราว์เซอร์ไม่ยิง afterprint — กันค้างไว้ใน DOM
    setTimeout(() => frame.remove(), 120_000)

    // รอฟอนต์ไทยและโลโก้โหลดก่อน ไม่งั้นใบแรกออกมาเป็นฟอนต์ระบบ/ไม่มีโลโก้ — แต่ไม่รอนานถ้าออฟไลน์
    const fontsReady = doc.fonts?.ready ?? Promise.resolve()
    const imagesReady = Promise.all(
      Array.from(doc.images).map((img) =>
        img.complete
          ? null
          : new Promise((r) => {
              // โลโก้โหลดไม่ขึ้นก็ยังพิมพ์ใบต่อได้ ไม่ต้องค้างรอ
              img.addEventListener('load', r)
              img.addEventListener('error', r)
            }),
      ),
    )
    void Promise.race([Promise.all([fontsReady, imagesReady]), new Promise((r) => setTimeout(r, 2500))]).then(() => {
      fitPageToContent(doc)
      try {
        win.focus()
        win.print()
      } catch {
        // ไม่มีเครื่องพิมพ์ / ถูกบล็อก — ผู้ใช้กดพิมพ์ซ้ำได้
      }
      resolve()
    })
  })
}

/**
 * ตั้งความยาวหน้ากระดาษให้เท่าเนื้อหาจริง
 *
 * CSS ไม่มี @page { size: 80mm auto } (ค่า auto ใช้กับความยาวไม่ได้ ทั้งกฎถูกทิ้ง
 * แล้วเบราว์เซอร์ใช้กระดาษ Letter แทน) ถ้าตั้งยาวตายตัว เครื่องพิมพ์ความร้อนจะ
 * ป้อนกระดาษเปล่าต่อท้ายจนครบความยาวนั้น จึงวัดหลังจัดหน้าเสร็จแล้วเขียนทับ
 */
function fitPageToContent(doc: Document) {
  const style = doc.getElementById('page')
  if (!style) return
  const width = /size:\s*(\d+)mm/.exec(style.textContent ?? '')?.[1] ?? '80'
  // วัดที่ body ไม่ใช่ documentElement — อันหลังคืนความสูงหน้าต่างถ้าเนื้อหาสั้นกว่า
  const px = doc.body.getBoundingClientRect().height
  const mm = Math.ceil((px * 25.4) / 96) + 2
  style.textContent = `@page { size: ${width}mm ${mm}mm; margin: 0; }`
}
