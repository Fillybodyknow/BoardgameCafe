import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ============================================================== พื้นผิว ====

export function Card({
  children,
  className = '',
  ornate = false,
}: {
  children: ReactNode
  className?: string
  /** กรอบปิดทองสี่มุม — ใช้กับการ์ดสำคัญเท่านั้น ใช้ทุกใบแล้วรก */
  ornate?: boolean
}) {
  return (
    <div className={`panel rounded-xl p-4 ${ornate ? 'ornate p-5' : ''} ${className}`}>
      {children}
    </div>
  )
}

/** หัวหน้าเพจ: คำโปรย + ชื่อหน้า + ปุ่มด้านขวา แล้วคั่นด้วยเส้นประดับ */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <p className="font-display text-[0.7rem] leading-loose tracking-[0.25em] text-gold-deep uppercase">
              {eyebrow}
            </p>
          )}
          <h1 className="text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-ink-soft">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="divider mt-4 text-xs" aria-hidden>
        ◆
      </div>
    </header>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flourish min-w-0 flex-1 text-sm font-semibold">{children}</h2>
      {action}
    </div>
  )
}

// =============================================================== ปุ่ม ====

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle' | 'forest'

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-gold font-semibold',
  ghost:
    'border border-line-strong bg-vellum/60 text-ink-soft hover:border-gold hover:bg-vellum hover:text-ink',
  danger:
    'border border-crimson/40 bg-transparent text-crimson hover:border-crimson hover:bg-crimson hover:text-vellum',
  subtle: 'border border-line bg-parchment-deep text-ink hover:bg-line',
  forest:
    'border border-forest-deep bg-forest text-vellum shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:bg-forest-deep',
}

/**
 * ข้อความในปุ่มต้องเป็น text ตรงๆ ไม่ห่อ span — เทสต์หาปุ่มด้วย getByText
 * แล้วเช็ค .disabled ถ้าห่อ span จะได้ span กลับมาแทนปุ่ม
 */
export function Button({
  variant = 'ghost',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn rounded-lg px-3.5 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 disabled:saturate-50 ${VARIANTS[variant]} ${className}`}
    />
  )
}

/** ตัวเลือกแบบแบ่งส่วน — ใช้แทนการเอาปุ่ม ghost/subtle มาเรียงกัน */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`seg ${className}`} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className="flex-1"
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ========================================================= ป้ายสถานะ ====

// Tailwind สแกนคลาสแบบ static เท่านั้น — ห้ามประกอบชื่อคลาสด้วย template string
const TONES = {
  neutral: 'border-line-strong/70 bg-ink/5 text-ink-soft',
  gold: 'border-gold/50 bg-gold/12 text-gold-deep',
  forest: 'border-forest/35 bg-forest/10 text-forest-deep',
  lapis: 'border-lapis/35 bg-lapis/10 text-lapis-deep',
  crimson: 'border-crimson/35 bg-crimson/10 text-crimson-deep',
  ember: 'border-ember/40 bg-ember/12 text-ember-deep',
  royal: 'border-royal/35 bg-royal/10 text-royal',
} as const

export type Tone = keyof typeof TONES

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}

/** จุดสีประจำสถานะ — ใช้ในคำอธิบายสัญลักษณ์ */
const DOTS: Record<Tone, string> = {
  neutral: 'bg-line-strong',
  gold: 'bg-gold',
  forest: 'bg-forest',
  lapis: 'bg-lapis',
  crimson: 'bg-crimson',
  ember: 'bg-ember',
  royal: 'bg-royal',
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${DOTS[tone]}`} aria-hidden />
}

export function Empty({ children, icon = '❦' }: { children: ReactNode; icon?: string }) {
  return (
    <div className="py-10 text-center">
      <div className="font-display text-3xl text-gold/70" aria-hidden>
        {icon}
      </div>
      <p className="mt-2 text-sm text-ink-faint italic">{children}</p>
    </div>
  )
}

// ============================================================ ฟอร์ม ====

/** คลาสช่องกรอกมาตรฐาน — ใช้ทั้งแอปให้หน้าตาเหมือนกัน */
export const INPUT = 'field'

export function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium tracking-wide text-ink-soft">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

// ========================================================== หน้าต่าง ====

/**
 * หน้าต่างลอยแบบม้วนกระดาษคลี่ออก
 * มือถือเลื่อนขึ้นจากขอบล่าง จอใหญ่อยู่กลางจอ — กด Esc หรือคลิกพื้นหลังเพื่อปิด
 */
/** ลำดับหน้าต่างที่เปิดอยู่ ใบท้ายสุดคือใบที่รับคีย์ */
const modalStack: symbol[] = []

export function Modal({
  title,
  hint,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  title: ReactNode
  hint?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg'
  /** false ระหว่างกำลังบันทึก — กันปิดหน้าต่างกลางคัน */
  dismissible?: boolean
}) {
  // เก็บลำดับของหน้าต่างที่เปิดอยู่ — กด Escape ควรปิดแค่ใบบนสุด ไม่ใช่ปิดรวดเดียวหมด
  const idRef = useRef<symbol>(undefined)
  idRef.current ??= Symbol('modal')

  useEffect(() => {
    const id = idRef.current!
    modalStack.push(id)
    return () => {
      const at = modalStack.lastIndexOf(id)
      if (at >= 0) modalStack.splice(at, 1)
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !dismissible) return
      if (modalStack[modalStack.length - 1] !== idRef.current) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, dismissible])

  // แขวนที่ body ไม่ใช่ตรงที่ถูกเรียก — ถ้า element แม่ชั้นไหนมี opacity, transform
  // หรือ overflow หน้าต่างจะโดนด้วย แม้จะเป็น position: fixed ก็ตาม
  //
  // เกิดขึ้นจริงมาแล้ว: การ์ดของคนที่กลับไปแล้วมี opacity-60 หน้าต่างเก็บเงิน
  // ที่เด้งจากการ์ดนั้นจึงจางจนมองทะลุได้
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 animate-fade bg-[#2a1c12]/45 backdrop-blur-[2px]"
        onClick={() => dismissible && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`panel ornate relative flex max-h-[92vh] w-full animate-unroll flex-col rounded-t-2xl sm:rounded-2xl ${
          size === 'lg' ? 'max-w-lg' : 'max-w-md'
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 pt-6 pb-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold">{title}</h3>
            {hint && <p className="mt-1 text-sm text-ink-soft">{hint}</p>}
          </div>
          <button
            type="button"
            aria-label="ปิดหน้าต่าง"
            onClick={onClose}
            disabled={!dismissible}
            className="-mt-1 -mr-2 rounded-full p-1.5 text-ink-faint transition hover:bg-parchment-deep hover:text-ink disabled:opacity-30"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <div className="rounded-b-2xl border-t border-line bg-parchment/70 px-6 py-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ========================================================== ไอคอน ====

const ICONS = {
  castle: 'M3 21h18M5 21V9l2-1V4h2v2h2V4h2v2h2V4h2v4l2 1v12M10 21v-4a2 2 0 0 1 4 0v4',
  cauldron:
    'M3.5 10h17M5 10a7 7 0 0 0 14 0M8 19.5 7 22M16 19.5l1 2.5M9 7c0-1.2 1.2-1.2 1.2-2.4S9 3.4 9 2.2M14 7c0-1.2 1.2-1.2 1.2-2.4S14 3.4 14 2.2',
  scroll:
    'M8 4h10a2 2 0 0 1 2 2v11M8 4a2 2 0 0 0-2 2v12a2 2 0 0 1-2 2h11a2 2 0 0 0 2-2V8M8 4a2 2 0 0 1 2 2v1H6M10 11h5M10 14.5h4',
  dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2M18 16v2M7 7h.01M17 7h.01M7 17h.01',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8zM5 19h14',
  exit: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
  close: 'M6 6l12 12M18 6 6 18',
  hourglass: 'M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  coins:
    'M9 14c3.9 0 7-1.3 7-3s-3.1-3-7-3-7 1.3-7 3 3.1 3 7 3zM2 11v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4M8 7.1C8.9 5.3 12 4 15.5 4c3.9 0 6.5 1.3 6.5 3v4c0 1.3-1.6 2.4-4 2.8',
  table: 'M3 9h18M5 9v11M19 9v11M3 9l2-4h14l2 4M9 14h6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  plus: 'M12 5v14M5 12h14',
  flag: 'M4 22V4M4 4h13l-2 4 2 4H4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
} as const

export type IconName = keyof typeof ICONS

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  )
}

// ======================================================= ลูกเล่น ====

const CELEBRATE = 'bgc:celebrate'

/**
 * ประทับตราครั่งกลางจอ — เรียกจากหน้าไหนก็ได้ ตัว shell เป็นคนแสดง
 * แยกเป็น event เพราะหลังปิดบิลหน้าจะถูกเปลี่ยนทันที ตัว dialog ไม่อยู่ให้แสดงแล้ว
 */
export function celebrate(message: string) {
  window.dispatchEvent(new CustomEvent(CELEBRATE, { detail: message }))
}

export function onCelebrate(fn: (message: string) => void) {
  const handler = (e: Event) => fn((e as CustomEvent<string>).detail)
  window.addEventListener(CELEBRATE, handler)
  return () => window.removeEventListener(CELEBRATE, handler)
}

export function SealStamp({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[70] grid animate-fade place-items-center bg-parchment/40">
      <div className="seal-stamp text-center">
        <div className="wax-seal mx-auto h-32 w-32 text-5xl">⚜</div>
        <p className="panel mt-4 rounded-full px-5 py-2 font-display font-bold text-crimson-deep">
          {message}
        </p>
      </div>
    </div>
  )
}
