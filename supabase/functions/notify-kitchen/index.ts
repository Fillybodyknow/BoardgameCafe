/**
 * ส่งแจ้งเตือนขึ้นมือถือเมื่อมีออเดอร์เข้าครัว
 *
 * ถูกเรียกจาก trigger ของตาราง orders ผ่าน pg_net ไม่ได้ถูกเรียกจากเบราว์เซอร์
 * จึงยืนยันตัวด้วยรหัสลับที่แชร์กับฐานข้อมูล ไม่ใช่ JWT ของผู้ใช้
 *
 * ส่งข้อความไปด้วย โดยเข้ารหัสตาม RFC 8291 (ดู webpush.ts) บริการ push เป็น
 * คนกลางที่อ่านเนื้อหาไม่ได้ ถ้าเข้ารหัสผิดจะถูกปฏิเสธหรือเบราว์เซอร์ถอดไม่ออก
 * ถ้าประกอบข้อความไม่สำเร็จจะถอยไปส่งแบบไม่มีเนื้อหา — service worker มีข้อความ
 * สำรองรออยู่ ดีกว่าไม่แจ้งเตือนเลย
 *
 * ⚠️ ต้องปิด Verify JWT ของฟังก์ชันนี้ เพราะ pg_net ไม่ได้ส่ง JWT มา
 *    (Dashboard → Edge Functions → notify-kitchen → Details → Verify JWT = off)
 *    ด่านจริงคือรหัสลับใน header ซึ่งอยู่ในฐานข้อมูลที่ client อ่านไม่ได้
 */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { encryptPayload } from './webpush.ts'
import { importVapidKeys, vapidAuth, type VapidKeys } from './vapid.ts'

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:owner@boardgamecafe.local'
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET') ?? ''

/** นำเข้ากุญแจครั้งเดียวแล้วใช้ซ้ำ แต่ถ้าพังต้องไม่จำความพังไว้ */
let keysPromise: Promise<VapidKeys> | null = null

function getVapidKeys(): Promise<VapidKeys> {
  keysPromise ??= importVapidKeys(VAPID_PRIVATE, VAPID_PUBLIC).catch((e) => {
    keysPromise = null
    throw e
  })
  return keysPromise
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

  // ตรวจกุญแจก่อนทำอย่างอื่น ถ้าตั้งค่าผิดจะได้รู้สาเหตุทันที ไม่ใช่เห็นแค่ sent:0
  let keys: VapidKeys
  try {
    keys = await getVapidKeys()
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
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

  // ข้อความประกอบจากฐานข้อมูล ถ้าดึงไม่ได้ก็ยังส่งแจ้งเตือน แค่ไม่มีรายละเอียด
  let payload: string | null = null
  try {
    const { orderId } = (await req.json()) as { orderId?: string }
    if (orderId) {
      const { data } = await admin.rpc('order_push_summary', { p_order_id: orderId })
      if (data) payload = JSON.stringify(data)
    }
  } catch {
    payload = null
  }

  return await sendAll(admin, (targets ?? []) as Target[], payload, keys)
})

interface Target {
  id: string
  endpoint: string
  p256dh?: string
  auth?: string
}

async function sendAll(
  admin: ReturnType<typeof createClient>,
  targets: Target[],
  payload: string | null,
  keys: VapidKeys,
) {
  let sent = 0
  const expired: string[] = []
  // เก็บสาเหตุที่ส่งไม่สำเร็จ — ถ้ากลืนทิ้ง อาการจะเหลือแค่ "แจ้งเตือนไม่ขึ้น" ซึ่งไล่หาสาเหตุไม่ได้เลย
  const failures: { service: string; status?: number; detail: string }[] = []

  await Promise.all(
    targets.map(async (t) => {
      try {
        const headers: Record<string, string> = {
          Authorization: await vapidAuth(t.endpoint, VAPID_SUBJECT, keys),
          TTL: '120',
          Urgency: 'high',
        }
        let body: BodyInit | undefined

        // เข้ารหัสด้วยกุญแจของอุปกรณ์เครื่องนั้นโดยเฉพาะ จึงต้องทำทีละเครื่อง
        if (payload && t.p256dh && t.auth) {
          const encrypted = await encryptPayload(payload, { p256dh: t.p256dh, auth: t.auth })
          headers['Content-Encoding'] = 'aes128gcm'
          headers['Content-Type'] = 'application/octet-stream'
          body = encrypted as unknown as BodyInit
        } else {
          headers['Content-Length'] = '0'
        }

        const res = await fetch(t.endpoint, { method: 'POST', headers, body })

        if (res.status === 404 || res.status === 410) {
          // อุปกรณ์ถอนการติดตั้งหรือล้างข้อมูลไปแล้ว เก็บกวาดทิ้ง
          expired.push(t.id)
        } else if (res.ok) {
          sent++
        } else {
          failures.push({
            service: new URL(t.endpoint).host,
            status: res.status,
            detail: (await res.text().catch(() => '')).slice(0, 200),
          })
        }
      } catch (e) {
        // ปลายทางล่มชั่วคราว หรือเข้ารหัสไม่ผ่าน — ไม่ลบทิ้ง รอรอบหน้า
        failures.push({ service: new URL(t.endpoint).host, detail: String(e).slice(0, 200) })
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

  return Response.json({
    sent,
    expired: expired.length,
    targets: targets.length,
    encrypted: payload !== null,
    ...(failures.length > 0 ? { failures } : {}),
  })
}
