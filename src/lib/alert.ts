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

let ctx: AudioContext | null = null

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
  return ok
}

export function disableSound() {
  remember(false)
}

/** ปี๊บสองจังหวะ สั้นและคมพอให้ได้ยินในครัวที่มีเสียงรบกวน */
export function playNewOrderChime() {
  if (!soundEnabled() || !ctx || ctx.state !== 'running') return

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
export function setTabBadge(count: number, base = 'ครัว · Boardgame Cafe') {
  document.title = count > 0 ? `(${count}) ${base}` : base
}
