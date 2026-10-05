/**
 * เสียงเตือนออเดอร์เข้าครัว
 *
 * สร้างเสียงด้วย Web Audio ไม่ใช้ไฟล์เสียง เพราะ:
 *   - ไม่ต้องโหลดไฟล์ ดังทันทีแม้เน็ตร้านอืด
 *   - ไม่กินโควตา egress และไม่มีไฟล์ให้หายไปตอน deploy
 *
 * ข้อจำกัดที่ต้องรู้: เบราว์เซอร์ห้ามเล่นเสียงจนกว่าผู้ใช้จะกดอะไรสักอย่างในหน้า
 * ถ้าไม่ปลดล็อกก่อน เสียงจะเงียบสนิทโดยไม่มี error — ครัวจะพลาดออเดอร์โดยไม่รู้ตัว
 * จึงต้องให้กดปุ่ม "เปิดเสียง" หนึ่งครั้ง แล้วค่อยเล่นได้
 */

const STORAGE_KEY = 'bgcafe.kitchen.sound'

/**
 * ไฟล์เสียงของร้าน — วางไว้ที่ public/ ชื่อ order-sound.<นามสกุล>
 *
 * รับหลายนามสกุลเพื่อไม่ต้องแปลงไฟล์ก่อน ลองไล่จนกว่าจะเจอตัวที่เบราว์เซอร์
 * ถอดรหัสได้ ถ้าไม่เจอเลยจะใช้เสียงสังเคราะห์แทน — ครัวต้องไม่เงียบเพราะ
 * ลืมใส่ไฟล์หรือใส่ไฟล์ที่เปิดไม่ได้
 */
const SOUND_FILES = ['order-sound.mp3', 'order-sound.m4a', 'order-sound.wav', 'order-sound.ogg']

let ctx: AudioContext | null = null
let customBuffer: AudioBuffer | null = null
/** null = ยังไม่เคยลองโหลด */
let loadAttempted = false

type Ctor = typeof AudioContext
function audioContextCtor(): Ctor | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export function soundSupported(): boolean {
  return audioContextCtor() !== null
}

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

function remember(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // โหมดส่วนตัว/โควตาเต็ม — เสียงยังทำงานในรอบนี้ แค่ไม่ถูกจำไว้
  }
}

/**
 * ต้องเรียกจากใน event ของการกดเท่านั้น ไม่งั้นเบราว์เซอร์จะไม่ยอมปลดล็อก
 * คืน true ถ้าปลดล็อกสำเร็จ
 */
export async function enableSound(): Promise<boolean> {
  const Ctor = audioContextCtor()
  if (!Ctor) return false

  ctx ??= new Ctor()
  // Safari เริ่มมาในสถานะ suspended ต้อง resume ภายใน gesture เดียวกัน
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return false
    }
  }

  const ok = ctx.state === 'running'
  remember(ok)
  if (ok) await preloadSound()
  return ok
}

export function disableSound() {
  remember(false)
}

/**
 * โหลดไฟล์เสียงของร้านเข้าหน่วยความจำ
 *
 * โหลดล่วงหน้าตอนเปิดเสียง ไม่ใช่ตอนออเดอร์เข้า เพราะถ้ารอโหลดตอนนั้น
 * เสียงจะดังช้ากว่าที่ควร และถ้าเน็ตสะดุดก็จะไม่ดังเลย
 */
export async function preloadSound(): Promise<boolean> {
  if (loadAttempted) return customBuffer !== null
  loadAttempted = true
  if (!ctx) return false

  const base = import.meta.env.BASE_URL ?? '/'
  for (const name of SOUND_FILES) {
    try {
      const res = await fetch(`${base}${name}`)
      if (!res.ok) continue
      customBuffer = await ctx.decodeAudioData(await res.arrayBuffer())
      return true
    } catch {
      // ไฟล์ไม่มี หรือถอดรหัสไม่ได้ — ลองนามสกุลถัดไป
    }
  }
  return false
}

/** true = กำลังใช้ไฟล์เสียงของร้าน, false = ใช้เสียงสังเคราะห์ */
export function usingCustomSound(): boolean {
  return customBuffer !== null
}

export function playNewOrderChime() {
  if (!soundEnabled() || !ctx || ctx.state !== 'running') return

  if (customBuffer) {
    const src = ctx.createBufferSource()
    src.buffer = customBuffer
    src.connect(ctx.destination)
    src.start()
    return
  }

  synthChime()
}

/** เสียงสำรอง — ปี๊บสองจังหวะ สั้นและคมพอให้ได้ยินในครัวที่มีเสียงรบกวน */
function synthChime() {
  if (!ctx) return
  const now = ctx.currentTime
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.value = freq

    const at = now + i * 0.18
    // ไต่ขึ้นเร็วแล้วค่อย ๆ ลง กัน "ป๊อก" ตอนตัดเสียงกะทันหัน
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)

    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.18)
  }
}

/**
 * ตัวเลขบนแท็บเบราว์เซอร์
 *
 * ครัวมักเปิดหลายแท็บ ถ้าไม่ขึ้นตรงนี้ คนที่สลับไปแท็บอื่นจะไม่รู้เลยว่ามีงานเข้า
 */
let shopTitle = 'Boardgame Cafe'

/** ชื่อร้านจริง — App ตั้งให้ทุกครั้งที่โหลดชื่อร้านได้ */
export function setShopTitle(name: string) {
  shopTitle = name
}

export function setTabBadge(count: number, base = `ครัว · ${shopTitle}`) {
  document.title = count > 0 ? `(${count}) ${base}` : base
}
