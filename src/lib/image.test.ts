// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IMAGE_MAX_EDGE, formatBytes, resizeToJpeg } from './image'

/**
 * happy-dom ไม่มี canvas จริง จึงต้องจำลอง แต่สิ่งที่ทดสอบคือ "ตรรกะการตัดสินใจ"
 * ได้แก่ คำนวณขนาดถูกไหม ทาพื้นหลังก่อนวาดไหม และดักไฟล์ที่เปิดไม่ได้หรือเปล่า
 * ส่วนคุณภาพการบีบอัดจริงเป็นเรื่องของเบราว์เซอร์
 */

let drawnSize: { w: number; h: number } | null = null
let filledFirst = false
let blobSize = 1234

function mockCanvas() {
  drawnSize = null
  filledFirst = false
  const ops: string[] = []

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag !== 'canvas') return Object.create(HTMLElement.prototype) as HTMLElement
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => {
          ops.push('fill')
        },
        drawImage: (_img: unknown, _x: number, _y: number, w: number, h: number) => {
          ops.push('draw')
          filledFirst = ops[0] === 'fill'
          drawnSize = { w, h }
        },
      }),
      toBlob: (cb: (b: Blob | null) => void, type: string) => {
        cb({ size: blobSize, type } as Blob)
      },
      toDataURL: () => 'data:image/jpeg;base64,xxx',
    }
    return canvas as unknown as HTMLElement
  })
}

/** จำลองไฟล์ที่เบราว์เซอร์เปิดได้ พร้อมขนาดที่กำหนด */
function mockImageLoads(width: number, height: number) {
  Object.defineProperty(globalThis, 'Image', {
    writable: true,
    value: class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = width
      naturalHeight = height
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    },
  })
}

/** จำลองไฟล์ที่เบราว์เซอร์เปิดไม่ได้ เช่น .heic บนเครื่องที่ไม่รองรับ */
function mockImageFails() {
  Object.defineProperty(globalThis, 'Image', {
    writable: true,
    value: class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 0
      naturalHeight = 0
      set src(_v: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    },
  })
}

const file = (name: string, type: string) => new File(['x'], name, { type })

describe('ย่อรูปก่อนอัปโหลด', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockCanvas()
    URL.createObjectURL = () => 'blob:x'
    URL.revokeObjectURL = () => {}
  })

  it('รูปใหญ่ถูกย่อให้ด้านยาวสุดเท่ากับเพดาน และคงอัตราส่วน', async () => {
    mockImageLoads(4000, 3000)
    await resizeToJpeg(file('photo.jpg', 'image/jpeg'))
    expect(drawnSize).toEqual({ w: IMAGE_MAX_EDGE, h: 600 })
  })

  it('รูปแนวตั้งย่อจากด้านสูง', async () => {
    mockImageLoads(1000, 2000)
    await resizeToJpeg(file('photo.jpg', 'image/jpeg'))
    expect(drawnSize).toEqual({ w: 400, h: IMAGE_MAX_EDGE })
  })

  it('รูปที่เล็กอยู่แล้วไม่ถูกขยาย', async () => {
    mockImageLoads(320, 240)
    await resizeToJpeg(file('small.jpg', 'image/jpeg'))
    expect(drawnSize).toEqual({ w: 320, h: 240 })
  })

  it('ทาพื้นหลังขาวก่อนวาดเสมอ — กัน PNG โปร่งใสกลายเป็นพื้นดำ', async () => {
    mockImageLoads(500, 500)
    await resizeToJpeg(file('logo.png', 'image/png'))
    expect(filledFirst).toBe(true)
  })

  it('ผลลัพธ์เป็น JPEG', async () => {
    mockImageLoads(1000, 1000)
    const out = await resizeToJpeg(file('a.jpg', 'image/jpeg'))
    expect(out.blob.type).toBe('image/jpeg')
    expect(out.dataUrl.startsWith('data:image/jpeg')).toBe(true)
  })

  it('ไฟล์ที่ไม่ใช่รูปถูกปฏิเสธ', async () => {
    mockImageLoads(100, 100)
    await expect(resizeToJpeg(file('doc.pdf', 'application/pdf'))).rejects.toThrow(/ไม่ใช่รูป/)
  })

  it('ไฟล์ .heic ที่เปิดไม่ได้ บอกวิธีแก้ ไม่ใช่ปล่อยรูปเปล่าขึ้นไป', async () => {
    mockImageFails()
    await expect(resizeToJpeg(file('IMG_1234.HEIC', 'image/heic'))).rejects.toThrow(/\.heic/)
  })

  it('ไฟล์รูปที่เสียบอกให้ลองไฟล์อื่น', async () => {
    mockImageFails()
    await expect(resizeToJpeg(file('broken.jpg', 'image/jpeg'))).rejects.toThrow(/เปิดไฟล์รูปไม่ได้/)
  })
})

describe('formatBytes', () => {
  it('แสดง KB และ MB ให้อ่านง่าย', () => {
    expect(formatBytes(40 * 1024)).toBe('40 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })
})
