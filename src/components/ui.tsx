import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/60 p-4 ${className}`}>
      {children}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-slate-400 uppercase">{children}</h2>
      {action}
    </div>
  )
}

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 font-semibold',
  ghost: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
  danger: 'border border-rose-800 text-rose-300 hover:bg-rose-950',
  subtle: 'bg-slate-800 text-slate-200 hover:bg-slate-700',
}

export function Button({
  variant = 'ghost',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={`rounded-lg px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  )
}

// Tailwind สแกนคลาสแบบ static เท่านั้น — ห้ามประกอบชื่อคลาสด้วย template string
const TONES = {
  slate: 'bg-slate-500/15 text-slate-300',
  emerald: 'bg-emerald-500/15 text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-300',
  sky: 'bg-sky-500/15 text-sky-300',
  rose: 'bg-rose-500/15 text-rose-300',
  violet: 'bg-violet-500/15 text-violet-300',
} as const

export type Tone = keyof typeof TONES

export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`rounded-md px-1.5 py-0.5 text-xs ${TONES[tone]}`}>{children}</span>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>
}
