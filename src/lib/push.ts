import { supabase } from '../data'

/**
 * แจ้งเตือนขึ้นมือถือแม้ปิดแอป (Web Push)
 *
 * ต่างจากเสียงเตือนใน alert.ts ตรงที่อันนั้นต้องเปิดหน้าครัวค้างไว้
 * ส่วนอันนี้ทำงานได้แม้ปิดเบราว์เซอร์ แลกกับการตั้งค่าที่ยุ่งกว่า
 *
 * ข้อจำกัดที่ต้องบอกผู้ใช้ให้ชัด:
 *   - iPhone/iPad ต้อง "เพิ่มลงหน้าจอโฮม" ก่อน ถึงจะรับแจ้งเตือนได้
 *     (Safari ในแท็บปกติไม่รองรับ) — เป็นข้อจำกัดของ iOS ไม่ใช่ของแอป
 *   - ต้องเปิดผ่าน https ซึ่ง GitHub Pages ให้อยู่แล้ว
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

export type PushState =
  | 'unsupported' // เบราว์เซอร์ไม่รองรับ
  | 'ios-needs-install' // iOS ที่ยังไม่ได้ติดตั้งลงหน้าจอโฮม
  | 'not-configured' // ยังไม่ได้ตั้ง VAPID key ตอน build
  | 'denied' // ผู้ใช้ปฏิเสธไปแล้ว ต้องไปแก้ในตั้งค่าเบราว์เซอร์
  | 'off'
  | 'on'

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS รายงานตัวเป็น Mac ต้องดูที่การมี touch ประกอบ
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** คืน ArrayBuffer เพราะ pushManager.subscribe ไม่รับ Uint8Array ที่อาจอิง SharedArrayBuffer */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const buf = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buf
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // BASE_URL ลงท้ายด้วย / เสมอ — service worker ต้องอยู่ใต้ scope ของแอป
  return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  })
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) {
    // บน iOS การไม่รองรับมักเป็นเพราะยังไม่ได้ติดตั้งลงหน้าจอโฮม
    // ซึ่งผู้ใช้แก้ได้เอง ต่างจาก "ไม่รองรับ" ที่ทำอะไรไม่ได้เลย
    return isIOS() && !isStandalone() ? 'ios-needs-install' : 'unsupported'
  }
  if (!VAPID_PUBLIC_KEY) return 'not-configured'
  if (Notification.permission === 'denied') return 'denied'

  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'

  // มี subscription ในเครื่อง แต่ฝั่งเซิร์ฟเวอร์อาจถูกเก็บกวาดไปแล้ว
  // ถ้าไม่เช็ก หน้าจอจะบอกว่าเปิดอยู่ทั้งที่จะไม่มีอะไรส่งมา
  const { data } = await supabase!.rpc('has_push_subscription', { p_endpoint: sub.endpoint })
  return data === true ? 'on' : 'off'
}

/** ขออนุญาตและลงทะเบียนอุปกรณ์นี้ — ต้องเรียกจากในเหตุการณ์กดเท่านั้น */
export async function enablePush(): Promise<PushState> {
  const state = await pushState()
  if (state === 'unsupported' || state === 'ios-needs-install' || state === 'not-configured') {
    return state
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'

  const reg = await registration()
  await navigator.serviceWorker.ready

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // บังคับว่าทุก push ต้องแสดงให้ผู้ใช้เห็น — เบราว์เซอร์ไม่ยอมแบบเงียบ
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC_KEY!),
    }))

  const json = sub.toJSON()
  const { error } = await supabase!.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_user_agent: navigator.userAgent.slice(0, 200),
  })
  if (error) throw new Error(error.message)

  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'

  // ลบฝั่งเซิร์ฟเวอร์ก่อน ถ้าลบฝั่งเครื่องสำเร็จแต่ฝั่งเซิร์ฟเวอร์ล้ม
  // จะเหลือ endpoint ตายค้างอยู่แล้วไม่มีทางลบได้อีก
  await supabase!.rpc('delete_push_subscription', { p_endpoint: sub.endpoint })
  await sub.unsubscribe()
  return 'off'
}

export const PUSH_HINT: Record<PushState, string> = {
  unsupported: 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน',
  'ios-needs-install': 'บน iPhone ต้องกดแชร์ แล้วเลือก “เพิ่มลงหน้าจอโฮม” ก่อน จึงจะรับแจ้งเตือนได้',
  'not-configured': 'ยังไม่ได้ตั้งค่ากุญแจแจ้งเตือน (VITE_VAPID_PUBLIC_KEY) ตอน build',
  denied: 'เคยปฏิเสธการแจ้งเตือนไว้ ต้องไปเปิดใหม่ในตั้งค่าเว็บไซต์ของเบราว์เซอร์',
  off: 'ปิดอยู่ — เปิดแล้วจะเด้งขึ้นมือถือแม้ปิดแอป',
  on: 'เปิดอยู่ — อุปกรณ์นี้จะได้รับแจ้งเตือนเมื่อมีออเดอร์เข้าครัว',
}
