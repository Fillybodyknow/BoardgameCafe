// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disableSound,
  enableSound,
  playNewOrderChime,
  setTabBadge,
  soundEnabled,
  soundSupported,
} from './alert'

/**
 * happy-dom ไม่มี Web Audio จริง จึงจำลองขึ้นมา
 * สิ่งที่ทดสอบคือ "ตรรกะการตัดสินใจ" ไม่ใช่เสียงที่ออกมา —
 * โดยเฉพาะข้อที่พลาดแล้วครัวจะไม่ได้ยินอะไรเลยโดยไม่มี error:
 * เล่นเสียงทั้งที่ยังไม่ได้ปลดล็อก
 */
let started = 0
let bufferPlayed = 0
let decodable = true
let state: AudioContextState = 'suspended'
/** บางเบราว์เซอร์ไม่ยอม resume ถ้าไม่ได้มาจากการกดจริง */
let resumeWorks = true

class FakeAudioContext {
  currentTime = 0
  get state() {
    return state
  }
  async resume() {
    if (resumeWorks) state = 'running'
  }
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: () => {
        started++
      },
      stop: () => {},
    } as unknown as OscillatorNode
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: (n: unknown) => n,
      start: () => {
        bufferPlayed++
      },
    } as unknown as AudioBufferSourceNode
  }
  async decodeAudioData() {
    if (!decodable) throw new Error('decode failed')
    return {} as AudioBuffer
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: (n: unknown) => n,
    } as unknown as GainNode
  }
  get destination() {
    return {} as AudioDestinationNode
  }
}

describe('เสียงเตือนออเดอร์เข้าครัว', () => {
  beforeEach(() => {
    localStorage.clear()
    started = 0
    state = 'suspended'
    resumeWorks = true
    vi.stubGlobal('AudioContext', FakeAudioContext)
    // ★ ต้อง stub fetch ไว้เสมอ ไม่งั้นผลเทสต์ขึ้นกับว่ามี dev server รันอยู่ไหม
    //
    // happy-dom ตั้ง location เป็น http://localhost:3000 ซึ่งตรงกับพอร์ตของ
    // dev server พอดี และ dev server ตอบ index.html (200) ให้ทุก path
    // preloadSound จึงคิดว่าเจอไฟล์เสียงของร้าน แล้วไปเล่น buffer แทนเสียง
    // สังเคราะห์ — เทสต์ชุดนี้ทดสอบทางเสียงสังเคราะห์ จึงต้องบอกให้ชัดว่า
    // "ไม่มีไฟล์เสียง"
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
  })

  it('ตรวจเจอว่าเบราว์เซอร์รองรับเสียง', () => {
    expect(soundSupported()).toBe(true)
  })

  it('เบราว์เซอร์ที่ไม่มี Web Audio ต้องไม่ล้ม', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    expect(soundSupported()).toBe(false)
    expect(() => playNewOrderChime()).not.toThrow()
  })

  it('เริ่มต้นเสียงปิดไว้ก่อน', () => {
    expect(soundEnabled()).toBe(false)
  })

  // ★ ข้อสำคัญ: ถ้าเล่นทั้งที่ยังไม่ปลดล็อก จะเงียบสนิทโดยไม่มี error
  // ครัวจะคิดว่าเปิดเสียงแล้วทั้งที่ไม่ได้ยินอะไรเลย
  it('ยังไม่ได้เปิดเสียง ต้องไม่พยายามเล่น', () => {
    playNewOrderChime()
    expect(started).toBe(0)
  })

  it('เปิดเสียงแล้วจำไว้ และเล่นได้', async () => {
    expect(await enableSound()).toBe(true)
    expect(soundEnabled()).toBe(true)

    playNewOrderChime()
    expect(started).toBe(2) // ปี๊บสองจังหวะ
  })

  it('ปิดเสียงแล้วหยุดเล่น', async () => {
    await enableSound()
    disableSound()
    expect(soundEnabled()).toBe(false)

    started = 0
    playNewOrderChime()
    expect(started).toBe(0)
  })

  it('ปลดล็อกไม่สำเร็จต้องคืน false และไม่จำว่าเปิด', async () => {
    resumeWorks = false
    expect(await enableSound()).toBe(false)
    expect(soundEnabled()).toBe(false)

    // และต้องไม่พยายามเล่นเสียงต่อ ไม่งั้นครัวจะคิดว่าเปิดแล้วทั้งที่เงียบ
    started = 0
    playNewOrderChime()
    expect(started).toBe(0)
  })
})

/**
 * ไฟล์เสียงของร้าน
 *
 * โมดูลจำผลการโหลดไว้ (ตั้งใจ — จะได้ไม่ยิงซ้ำทุกออเดอร์) เทสต์จึงต้อง
 * โหลดโมดูลใหม่ทุกเคสด้วย resetModules ไม่งั้นเคสหลังจะเห็นผลของเคสก่อน
 */
describe('ใช้ไฟล์เสียงของร้านแทนเสียงสังเคราะห์', () => {
  async function freshModule() {
    vi.resetModules()
    return await import('./alert')
  }

  beforeEach(() => {
    localStorage.clear()
    started = 0
    bufferPlayed = 0
    state = 'suspended'
    resumeWorks = true
    decodable = true
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  it('มีไฟล์และถอดรหัสได้ → ใช้ไฟล์ของร้าน', async () => {
    vi.stubGlobal('fetch', async () => new Response(new ArrayBuffer(8), { status: 200 }))
    const m = await freshModule()

    expect(await m.enableSound()).toBe(true)
    expect(m.usingCustomSound()).toBe(true)

    m.playNewOrderChime()
    expect(bufferPlayed).toBe(1)
    expect(started).toBe(0) // ไม่ใช้เสียงสังเคราะห์
  })

  // ★ ครัวต้องไม่เงียบเพราะลืมใส่ไฟล์
  it('ไม่มีไฟล์ → ถอยไปใช้เสียงสังเคราะห์', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    const m = await freshModule()

    expect(await m.enableSound()).toBe(true)
    expect(m.usingCustomSound()).toBe(false)

    m.playNewOrderChime()
    expect(started).toBe(2)
    expect(bufferPlayed).toBe(0)
  })

  it('ไฟล์เปิดไม่ได้ (เช่นไฟล์เสีย) → ถอยไปใช้เสียงสังเคราะห์', async () => {
    decodable = false
    vi.stubGlobal('fetch', async () => new Response(new ArrayBuffer(8), { status: 200 }))
    const m = await freshModule()

    await m.enableSound()
    expect(m.usingCustomSound()).toBe(false)

    m.playNewOrderChime()
    expect(started).toBe(2)
  })

  it('เน็ตล่มตอนโหลด → ยังมีเสียงสำรองให้ได้ยิน', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const m = await freshModule()

    await m.enableSound()
    m.playNewOrderChime()
    expect(started).toBe(2)
  })

  it('โหลดครั้งเดียว ไม่ยิงซ้ำทุกออเดอร์', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return new Response(new ArrayBuffer(8), { status: 200 })
    })
    const m = await freshModule()

    await m.enableSound()
    await m.preloadSound()
    await m.preloadSound()
    expect(calls).toBe(1)
  })
})

describe('ตัวเลขบนแท็บ', () => {
  it('มีออเดอร์ค้างแล้วขึ้นตัวเลขนำหน้า', () => {
    setTabBadge(3, 'ครัว')
    expect(document.title).toBe('(3) ครัว')
  })

  it('ไม่มีออเดอร์แล้วกลับเป็นชื่อปกติ', () => {
    setTabBadge(3, 'ครัว')
    setTabBadge(0, 'ครัว')
    expect(document.title).toBe('ครัว')
  })
})
