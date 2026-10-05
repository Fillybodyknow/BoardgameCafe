import { describe, expect, it } from 'vitest'
import { importVapidKeys, vapidAuth } from '../../supabase/functions/notify-kitchen/vapid'
import { b64urlToBytes, bytesToB64url } from '../../supabase/functions/notify-kitchen/webpush'

/**
 * กุญแจ VAPID
 *
 * ชุดนี้มีเพราะของจริงเคยพังแบบเงียบ ๆ มาแล้ว — กุญแจส่วนตัวใน Secrets เป็น
 * raw 32 ไบต์ แต่โค้ด import แบบ pkcs8 อย่างเดียว อาการที่เห็นคือแจ้งเตือน
 * ไม่ขึ้น ไม่มี error ให้ดู ทดสอบจึงต้องครอบคลุมทั้งสองรูปแบบ และต้องพิสูจน์
 * ด้วยการตรวจลายเซ็นจริง ไม่ใช่แค่ import ผ่านแล้วถือว่าใช้ได้
 */

/** สร้างคู่กุญแจแล้วคืนออกมาทั้งสองรูปแบบที่เครื่องมือต่าง ๆ ให้มา */
async function makeKeypair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)

  return {
    publicKey: bytesToB64url(pub),
    rawPrivate: jwk.d!,
    pkcs8Private: bytesToB64url(pkcs8),
  }
}

/** ตรวจ JWT เหมือนที่บริการ push ทำ: แยกสามท่อน แล้วตรวจลายเซ็นด้วย k= */
async function verifyAuthHeader(auth: string) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth)
  if (!m) throw new Error('รูปแบบ header ไม่ถูกต้อง: ' + auth)
  const [, header, payload, sig, k] = m

  const verifyKey = await crypto.subtle.importKey(
    'raw',
    b64urlToBytes(k!),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    b64urlToBytes(sig!),
    new TextEncoder().encode(`${header}.${payload}`),
  )

  return { ok, claims: JSON.parse(new TextDecoder().decode(b64urlToBytes(payload!))) }
}

describe('กุญแจ VAPID', () => {
  it('รับกุญแจส่วนตัวแบบ raw 32 ไบต์ได้', async () => {
    const kp = await makeKeypair()
    expect(b64urlToBytes(kp.rawPrivate).length).toBe(32)

    const keys = await importVapidKeys(kp.rawPrivate, kp.publicKey)
    const { ok } = await verifyAuthHeader(await vapidAuth('https://fcm.googleapis.com/x/y', 'mailto:a@b.co', keys))

    expect(ok).toBe(true)
  })

  it('รับกุญแจส่วนตัวแบบ PKCS#8 ได้', async () => {
    const kp = await makeKeypair()
    expect(b64urlToBytes(kp.pkcs8Private)[0]).toBe(0x30)

    const keys = await importVapidKeys(kp.pkcs8Private, kp.publicKey)
    const { ok } = await verifyAuthHeader(await vapidAuth('https://fcm.googleapis.com/x/y', 'mailto:a@b.co', keys))

    expect(ok).toBe(true)
  })

  it('สองรูปแบบนั้นคือกุญแจดอกเดียวกัน', async () => {
    const kp = await makeKeypair()
    const a = await importVapidKeys(kp.rawPrivate, kp.publicKey)
    const b = await importVapidKeys(kp.pkcs8Private, kp.publicKey)
    expect(a.publicKey).toBe(b.publicKey)
  })

  // ★ ตั้ง Secret ไว้คนละคู่คือความผิดพลาดที่เกิดง่ายมาก และปลายทางจะตอบแค่ 403
  it('คู่กุญแจไม่ตรงกันต้องฟ้องตั้งแต่ตอนเริ่ม', async () => {
    const mine = await makeKeypair()
    const other = await makeKeypair()

    await expect(importVapidKeys(mine.rawPrivate, other.publicKey)).rejects.toThrow(
      /ไม่ใช่คู่เดียวกัน/,
    )
  })

  it('คู่กุญแจไม่ตรงกันแบบ PKCS#8 ก็ต้องฟ้อง', async () => {
    const mine = await makeKeypair()
    const other = await makeKeypair()

    // ทางนี้ import ผ่านได้ เพราะ PKCS#8 ไม่ได้เอากุญแจสาธารณะมาเทียบ
    // จับได้ด้วยการเซ็นแล้วตรวจเท่านั้น
    await expect(importVapidKeys(mine.pkcs8Private, other.publicKey)).rejects.toThrow(
      /ไม่ใช่คู่เดียวกัน/,
    )
  })

  it('กุญแจสาธารณะผิดรูปแบบต้องฟ้องว่าผิดตรงไหน', async () => {
    const kp = await makeKeypair()
    await expect(importVapidKeys(kp.rawPrivate, bytesToB64url(new Uint8Array(32)))).rejects.toThrow(
      /65 ไบต์/,
    )
  })

  it('กุญแจส่วนตัวผิดรูปแบบต้องฟ้องว่าผิดตรงไหน', async () => {
    const kp = await makeKeypair()
    await expect(importVapidKeys(bytesToB64url(new Uint8Array(10)), kp.publicKey)).rejects.toThrow(
      /อ่านไม่ออก/,
    )
  })
})

describe('JWT ที่ส่งให้บริการ push', () => {
  it('aud เป็น origin ของปลายทาง ไม่ใช่ URL เต็ม', async () => {
    const kp = await makeKeypair()
    const keys = await importVapidKeys(kp.rawPrivate, kp.publicKey)

    const { claims } = await verifyAuthHeader(
      await vapidAuth('https://web.push.apple.com/abc/def?x=1', 'mailto:a@b.co', keys),
    )

    expect(claims.aud).toBe('https://web.push.apple.com')
    expect(claims.sub).toBe('mailto:a@b.co')
  })

  it('ยังไม่หมดอายุ และไม่เกิน 24 ชั่วโมงตามที่มาตรฐานกำหนด', async () => {
    const kp = await makeKeypair()
    const keys = await importVapidKeys(kp.rawPrivate, kp.publicKey)

    const { claims } = await verifyAuthHeader(
      await vapidAuth('https://fcm.googleapis.com/x', 'mailto:a@b.co', keys),
    )

    const now = Math.floor(Date.now() / 1000)
    expect(claims.exp).toBeGreaterThan(now)
    expect(claims.exp).toBeLessThanOrEqual(now + 24 * 3600)
  })

  it('ปลายทางคนละเจ้าได้ JWT คนละใบ', async () => {
    const kp = await makeKeypair()
    const keys = await importVapidKeys(kp.rawPrivate, kp.publicKey)

    const a = await vapidAuth('https://fcm.googleapis.com/x', 'mailto:a@b.co', keys)
    const b = await vapidAuth('https://web.push.apple.com/x', 'mailto:a@b.co', keys)

    expect(a).not.toBe(b)
  })
})
