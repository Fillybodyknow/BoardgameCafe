import { describe, expect, it } from 'vitest'
import {
  b64urlToBytes,
  bytesToB64url,
  decryptPayload,
  encryptPayload,
} from '../../supabase/functions/notify-kitchen/webpush'

/**
 * การเข้ารหัสเนื้อหา Web Push
 *
 * ทดสอบด้วยการเข้ารหัสแล้วถอดกลับให้ได้ข้อความเดิม เพราะเรื่องรหัสลับ
 * อ่านโค้ดแล้วเชื่อไม่ได้ — ถ้าผิดนิดเดียว บริการ push จะปฏิเสธหรือเบราว์เซอร์
 * ถอดไม่ออก แล้วจะเห็นอาการแค่ "แจ้งเตือนไม่ขึ้น" ซึ่งไล่หาสาเหตุยากมาก
 *
 * ไฟล์ต้นทางใช้แต่ Web Crypto ไม่มี API ของ Deno จึงรันใน Node ได้ตรง ๆ
 */

/** จำลองอุปกรณ์ปลายทาง — ของจริงเบราว์เซอร์เป็นคนสร้างคู่กุญแจนี้ */
async function fakeSubscription() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))

  return {
    uaPrivate: kp.privateKey,
    uaPublic,
    authSecret,
    keys: { p256dh: bytesToB64url(uaPublic), auth: bytesToB64url(authSecret) },
  }
}

describe('เข้ารหัสเนื้อหา Web Push', () => {
  it('เข้ารหัสแล้วถอดกลับได้ข้อความเดิม', async () => {
    const sub = await fakeSubscription()
    const text = JSON.stringify({ title: 'ออเดอร์ใหม่', body: 'โต๊ะ A1 · กาแฟ ×2' })

    const body = await encryptPayload(text, sub.keys)
    const out = await decryptPayload(body, sub.uaPrivate, sub.uaPublic, sub.authSecret)

    expect(out).toBe(text)
  })

  it('ข้อความภาษาไทยยาว ๆ ก็ยังตรง', async () => {
    const sub = await fakeSubscription()
    const text = 'โต๊ะ บี๒ · สปาเก็ตตี้คาโบนาร่า ×3, ชาเขียวมัทฉะ ×1, บราวนี่อุ่นไอศกรีม ×2'

    const body = await encryptPayload(text, sub.keys)
    expect(await decryptPayload(body, sub.uaPrivate, sub.uaPublic, sub.authSecret)).toBe(text)
  })

  it('โครงของ body ตรงตามมาตรฐาน', async () => {
    const sub = await fakeSubscription()
    const salt = new Uint8Array(16).fill(7)

    const body = await encryptPayload('x', sub.keys, salt)

    expect(body.slice(0, 16)).toEqual(salt)
    // record size = 4096 เก็บเป็น uint32 big-endian
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096)
    // กุญแจชั่วคราวของผู้ส่งเป็นแบบ uncompressed ยาว 65 ไบต์
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(0x04)
  })

  it('ทุกครั้งที่ส่งได้ผลลัพธ์ไม่ซ้ำกัน แม้ข้อความเดิม', async () => {
    const sub = await fakeSubscription()
    const a = await encryptPayload('เหมือนกัน', sub.keys)
    const b = await encryptPayload('เหมือนกัน', sub.keys)
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b))
  })

  // ★ กุญแจของอุปกรณ์อื่นต้องถอดไม่ออก ไม่งั้นข้อความรั่วข้ามเครื่อง
  it('อุปกรณ์อื่นถอดรหัสไม่ได้', async () => {
    const mine = await fakeSubscription()
    const other = await fakeSubscription()

    const body = await encryptPayload('ความลับ', mine.keys)

    await expect(
      decryptPayload(body, other.uaPrivate, other.uaPublic, other.authSecret),
    ).rejects.toThrow()
  })

  it('แก้ไข ciphertext แล้วต้องถอดไม่ผ่าน (ตรวจความถูกต้องได้)', async () => {
    const sub = await fakeSubscription()
    const body = await encryptPayload('ของจริง', sub.keys)

    const tampered = new Uint8Array(body)
    tampered[tampered.length - 1] ^= 0xff

    await expect(
      decryptPayload(tampered, sub.uaPrivate, sub.uaPublic, sub.authSecret),
    ).rejects.toThrow()
  })

  it('ขนาดไม่เกินเพดาน 4KB ที่บริการ push รับได้', async () => {
    const sub = await fakeSubscription()
    const text = JSON.stringify({
      title: 'มีออเดอร์ใหม่เข้าครัว',
      body: 'โต๊ะ A1 · ' + 'เฟรนช์ฟรายส์ ×2, '.repeat(20),
    })
    const body = await encryptPayload(text, sub.keys)
    expect(body.length).toBeLessThan(4096)
  })
})

describe('แปลง base64url', () => {
  it('ไป-กลับได้ค่าเดิม', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(65))
    expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes)
  })

  it('ไม่มีอักขระที่ต้อง escape ใน URL', () => {
    for (let i = 0; i < 20; i++) {
      const s = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
      expect(s).not.toMatch(/[+/=]/)
    }
  })
})
