/**
 * กุญแจ VAPID และ JWT ที่บริการ push ใช้ยืนยันว่าเราเป็นเจ้าของกุญแจจริง
 *
 * ทำไมต้องแยกไฟล์: ของเดิมฝังไว้ใน index.ts แล้ว import แบบ pkcs8 อย่างเดียว
 * พอกุญแจที่เก็บใน Secrets เป็นแบบ raw 32 ไบต์ มันโยน DataError ออกมา และ
 * ถูก catch กลืนทิ้ง อาการที่เห็นคือ "แจ้งเตือนไม่ขึ้น" เฉย ๆ กว่าจะรู้ว่าพัง
 * ตรงไหนก็เสียเวลาไปมาก
 *
 * ไฟล์นี้ใช้แต่ Web Crypto ไม่มี API ของ Deno จึงทดสอบด้วย vitest ได้
 * — เรื่องกุญแจต้องพิสูจน์ด้วยการเซ็นแล้วตรวจให้ผ่าน ไม่ใช่อ่านโค้ดแล้วเชื่อ
 */

import { b64urlToBytes, bytesToB64url } from './webpush.ts'

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const

export interface VapidKeys {
  signingKey: CryptoKey
  /** กุญแจสาธารณะแบบ base64url ส่งไปใน header ให้ปลายทางใช้ตรวจลายเซ็น */
  publicKey: string
}

/**
 * รับกุญแจส่วนตัวได้สองรูปแบบ เพราะเครื่องมือสร้างกุญแจแต่ละเจ้าให้มาไม่เหมือนกัน
 *   - raw 32 ไบต์ (ที่เว็บสร้าง VAPID ส่วนใหญ่ให้มา)
 *   - PKCS#8 (ที่ openssl และ web-push ของ Node ให้มา ขึ้นต้นด้วย 0x30)
 *
 * แล้วพิสูจน์ว่าคู่กุญแจเข้าคู่กันจริงด้วยการเซ็นแล้วตรวจ ถ้าไม่เข้าคู่จะโยน
 * ข้อผิดพลาดที่อ่านรู้เรื่องตั้งแต่ตอนเริ่ม ดีกว่าปล่อยให้ปลายทางตอบ 403
 * ซึ่งไม่บอกสาเหตุอะไรเลย
 */
export async function importVapidKeys(
  privateB64: string,
  publicB64: string,
): Promise<VapidKeys> {
  const pub = b64urlToBytes(publicB64)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `VAPID_PUBLIC_KEY ไม่ใช่กุญแจ P-256 แบบ uncompressed (ต้องยาว 65 ไบต์ ขึ้นต้นด้วย 0x04 แต่ได้ ${pub.length} ไบต์)`,
    )
  }

  const priv = b64urlToBytes(privateB64)
  let signingKey: CryptoKey

  if (priv.length === 32) {
    // JWK ต้องการพิกัดของกุญแจสาธารณะมาด้วย ซึ่งแกะจากกุญแจสาธารณะได้ตรง ๆ
    // ผลพลอยได้คือถ้าคู่กุญแจไม่ตรงกัน การ import จะพังตรงนี้เลย แต่ข้อความ
    // ที่ได้คือ "Invalid keyData" ซึ่งไม่บอกอะไร จึงแปลงเป็นสาเหตุที่แท้จริง
    try {
      signingKey = await crypto.subtle.importKey(
        'jwk',
        {
          kty: 'EC',
          crv: 'P-256',
          x: bytesToB64url(pub.slice(1, 33)),
          y: bytesToB64url(pub.slice(33, 65)),
          d: bytesToB64url(priv),
          ext: true,
        },
        ALG,
        false,
        ['sign'],
      )
    } catch {
      throw new Error('VAPID_PUBLIC_KEY กับ VAPID_PRIVATE_KEY ไม่ใช่คู่เดียวกัน')
    }
  } else if (priv[0] === 0x30) {
    signingKey = await crypto.subtle.importKey('pkcs8', priv, ALG, false, ['sign'])
  } else if (priv.length === 65 && priv[0] === 0x04) {
    // เคสที่เกิดจริง: วางกุญแจสาธารณะลงในช่องกุญแจส่วนตัว
    throw new Error('VAPID_PRIVATE_KEY เป็นกุญแจสาธารณะ — สลับค่ากับ VAPID_PUBLIC_KEY อยู่')
  } else {
    throw new Error(
      `VAPID_PRIVATE_KEY อ่านไม่ออก — ต้องเป็น raw 32 ไบต์ หรือ PKCS#8 แต่ได้ ${priv.length} ไบต์ ขึ้นต้นด้วย 0x${priv[0]?.toString(16)}`,
    )
  }

  await assertKeysMatch(signingKey, pub)
  return { signingKey, publicKey: bytesToB64url(pub) }
}

/**
 * เซ็นข้อความทดสอบแล้วตรวจด้วยกุญแจสาธารณะ
 *
 * จำเป็นเพราะการ import สำเร็จไม่ได้แปลว่าคู่กุญแจตรงกัน ถ้าตั้ง Secret ไว้
 * คนละคู่ ทุกอย่างจะดูปกติจนถึงตอนปลายทางปฏิเสธ
 */
async function assertKeysMatch(signingKey: CryptoKey, pub: Uint8Array<ArrayBuffer>) {
  const verifyKey = await crypto.subtle.importKey('raw', pub, ALG, false, ['verify'])
  const probe = new TextEncoder().encode('vapid-keypair-check')
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, probe)

  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, probe)
  if (!ok) {
    throw new Error('VAPID_PUBLIC_KEY กับ VAPID_PRIVATE_KEY ไม่ใช่คู่เดียวกัน')
  }
}

/**
 * header Authorization สำหรับยิงไปที่ endpoint ของบริการ push
 *
 * aud ต้องเป็น origin ของ endpoint ปลายทาง ไม่ใช่ URL เต็ม
 */
export async function vapidAuth(
  endpoint: string,
  subject: string,
  keys: VapidKeys,
): Promise<string> {
  const enc = new TextEncoder()
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  )

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.signingKey,
    enc.encode(`${header}.${payload}`),
  )

  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${keys.publicKey}`
}
