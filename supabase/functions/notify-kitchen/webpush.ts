/**
 * เข้ารหัสเนื้อหาของ Web Push ตาม RFC 8291 (aes128gcm)
 *
 * ทำไมต้องเข้ารหัส: บริการ push ของ Google/Apple/Mozilla เป็นคนกลางที่ส่งต่อ
 * ข้อความให้ มาตรฐานจึงบังคับว่าเนื้อหาต้องถูกเข้ารหัสด้วยกุญแจของอุปกรณ์
 * ปลายทาง คนกลางอ่านไม่ได้ ถ้าส่งข้อความเปล่า ๆ ไปจะถูกปฏิเสธทันที
 *
 * แยกเป็นไฟล์ของตัวเองเพราะไม่ได้ใช้ API ของ Deno เลย ใช้แต่ Web Crypto
 * จึงทดสอบด้วย vitest ได้ — เรื่องรหัสลับแบบนี้ต้องพิสูจน์ด้วยการเข้ารหัส
 * แล้วถอดกลับให้ได้ข้อความเดิม ไม่ใช่อ่านโค้ดแล้วเชื่อ
 */

const EC = { name: 'ECDH', namedCurve: 'P-256' } as const

export function b64urlToBytes(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length)) as Bytes
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(input: ArrayBuffer | Uint8Array): string {
  const arr = input instanceof Uint8Array ? input : new Uint8Array(input)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * ประกาศชนิดเป็น Uint8Array<ArrayBuffer> ให้ชัด เพราะ Web Crypto ไม่รับ
 * Uint8Array ที่อาจอิง SharedArrayBuffer
 */
type Bytes = Uint8Array<ArrayBuffer>

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0))) as Bytes
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const utf8 = (s: string): Bytes => new TextEncoder().encode(s) as Bytes

/** HKDF (extract + expand รวมในครั้งเดียว ตามที่ Web Crypto ให้มา) */
async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  bytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits) as Bytes
}

export interface PushKeys {
  /** กุญแจสาธารณะของอุปกรณ์ (p256dh) แบบ base64url */
  p256dh: string
  /** ความลับร่วมของอุปกรณ์ (auth) แบบ base64url */
  auth: string
}

/**
 * คืน body ที่พร้อมส่งไปยัง endpoint ของบริการ push
 *
 * โครงตาม RFC 8188:
 *   salt(16) | recordSize(4) | idLen(1) | ephemeralPublicKey(65) | ciphertext
 */
export async function encryptPayload(
  plaintext: string,
  keys: PushKeys,
  /** ใส่เองได้เพื่อให้ผลลัพธ์คาดเดาได้ตอนทดสอบ ปกติปล่อยให้สุ่ม */
  fixedSalt?: Bytes,
): Promise<Bytes> {
  const uaPublic = b64urlToBytes(keys.p256dh)
  const authSecret = b64urlToBytes(keys.auth)

  // กุญแจชั่วคราวของฝั่งเรา ใช้ครั้งเดียวต่อหนึ่งข้อความ
  const asKeys = await crypto.subtle.generateKey(EC, true, ['deriveBits'])
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', asKeys.publicKey),
  ) as Bytes

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, EC, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  ) as Bytes

  // RFC 8291 §3.4 — ผูกกุญแจเข้ากับคู่สนทนาคู่นี้โดยเฉพาะ
  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)

  const salt = fixedSalt ?? (crypto.getRandomValues(new Uint8Array(16)) as Bytes)
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  // 0x02 บอกว่าเป็นเรคอร์ดสุดท้าย (มีเรคอร์ดเดียวอยู่แล้ว)
  const padded = concat(utf8(plaintext), new Uint8Array([2]))

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  ) as Bytes

  const recordSize = new Uint8Array(new ArrayBuffer(4)) as Bytes
  new DataView(recordSize.buffer).setUint32(0, 4096)

  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

/**
 * ถอดรหัสกลับ — มีไว้สำหรับทดสอบเท่านั้น ของจริงเบราว์เซอร์เป็นคนถอด
 *
 * รับกุญแจส่วนตัวของอุปกรณ์ ซึ่งในโลกจริงอยู่ในเบราว์เซอร์และไม่มีใครเห็น
 */
export async function decryptPayload(
  body: Bytes,
  uaPrivate: CryptoKey,
  uaPublic: Bytes,
  authSecret: Bytes,
): Promise<string> {
  const salt = body.slice(0, 16) as Bytes
  const idLen = body[20]!
  const asPublic = body.slice(21, 21 + idLen) as Bytes
  const ciphertext = body.slice(21 + idLen) as Bytes

  const asKey = await crypto.subtle.importKey('raw', asPublic, EC, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256),
  ) as Bytes

  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)

  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  )

  // ตัดไบต์บอกท้ายเรคอร์ดออก
  let end = padded.length
  while (end > 0 && padded[end - 1] === 0) end--
  return new TextDecoder().decode(padded.slice(0, end - 1))
}
