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
