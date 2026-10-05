/**
 * ส่งแจ้งเตือนขึ้นมือถือเมื่อมีออเดอร์เข้าครัว
 *
 * ถูกเรียกจาก trigger ของตาราง orders ผ่าน pg_net ไม่ได้ถูกเรียกจากเบราว์เซอร์
 * จึงยืนยันตัวด้วยรหัสลับที่แชร์กับฐานข้อมูล ไม่ใช่ JWT ของผู้ใช้
 *
 * ส่ง push แบบไม่มีเนื้อหา (payload-less) โดยตั้งใจ — Web Push ที่มี payload
 * ต้องเข้ารหัส aes128gcm ซึ่งซับซ้อนและพังง่าย ส่วนข้อความแจ้งเตือนเขียนไว้ใน
 * service worker อยู่แล้ว กดแล้วเปิดจอครัวเห็นรายละเอียดครบ
 *
 * ⚠️ ต้องปิด Verify JWT ของฟังก์ชันนี้ เพราะ pg_net ไม่ได้ส่ง JWT มา
 *    (Dashboard → Edge Functions → notify-kitchen → Details → Verify JWT = off)
 *    ด่านจริงคือรหัสลับใน header ซึ่งอยู่ในฐานข้อมูลที่ client อ่านไม่ได้
 */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:owner@boardgamecafe.local'
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET') ?? ''

// ---------------------------------------------------------------- base64url ----

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ------------------------------------------------------------------ VAPID ----

let signingKey: CryptoKey | null = null

async function getSigningKey(): Promise<CryptoKey> {
  signingKey ??= await crypto.subtle.importKey(
    'pkcs8',
    b64urlToBytes(VAPID_PRIVATE),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  return signingKey
}

/**
 * JWT ที่บริการ push ใช้ยืนยันว่าเราเป็นเจ้าของกุญแจจริง
 * aud ต้องเป็น origin ของ endpoint ปลายทาง ไม่ใช่ URL เต็ม
 */
async function vapidAuth(endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = bytesToB64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: VAPID_SUBJECT,
      }),
    ),
  )

  const data = new TextEncoder().encode(`${header}.${payload}`)
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await getSigningKey(),
    data,
  )

  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${VAPID_PUBLIC}`
}

// ------------------------------------------------------------------- main ----

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !NOTIFY_SECRET) {
    return Response.json({ error: 'ยังไม่ได้ตั้งค่า VAPID หรือ NOTIFY_SECRET' }, { status: 500 })
  }
  if (req.headers.get('x-notify-secret') !== NOTIFY_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // ให้ฐานข้อมูลเป็นคนตอบว่าใครควรได้รับ กติกา "ใครคือคนครัว" จะได้อยู่ที่เดียว
  const { data: targets, error } = await admin.rpc('kitchen_push_endpoints')
  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return await sendAll(admin, (targets ?? []) as { id: string; endpoint: string }[])
})

async function sendAll(
  admin: ReturnType<typeof createClient>,
  targets: { id: string; endpoint: string }[],
) {
  let sent = 0
  const expired: string[] = []

  await Promise.all(
    targets.map(async (t) => {
      try {
        const res = await fetch(t.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuth(t.endpoint),
            TTL: '120',
            Urgency: 'high',
            'Content-Length': '0',
          },
        })

        if (res.status === 404 || res.status === 410) {
          // อุปกรณ์ถอนการติดตั้งหรือล้างข้อมูลไปแล้ว เก็บกวาดทิ้ง
          expired.push(t.id)
        } else if (res.ok) {
          sent++
        }
      } catch {
        // ปลายทางล่มชั่วคราว ไม่ลบทิ้ง รอรอบหน้า
      }
    }),
  )

  if (expired.length > 0) {
    await admin.from('push_subscriptions').delete().in('id', expired)
  }
  if (sent > 0) {
    await admin
      .from('push_subscriptions')
      .update({ last_ok_at: new Date().toISOString() })
      .in('id', targets.filter((t) => !expired.includes(t.id)).map((t) => t.id))
  }

  return Response.json({ sent, expired: expired.length, targets: targets.length })
}
