import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { hasSupabase, supabase } from '../data'
import { Button, Card } from '../components/ui'

/**
 * ด่านล็อกอินพนักงาน
 *
 * ไม่ใช่ระบบความปลอดภัย — เป็นแค่ประตูหน้าจอ
 * ความปลอดภัยจริงอยู่ที่ RLS + assert_staff() ในฐานข้อมูล
 * ต่อให้ข้ามหน้านี้ไปได้ ก็ยังเรียก RPC อะไรไม่ได้อยู่ดี
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!supabase) {
      setReady(true)
      return
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // โหมดเดโม ไม่ต้องล็อกอิน
  if (!hasSupabase) return <>{children}</>

  if (!ready) {
    return <p className="p-8 text-center text-sm text-slate-500">กำลังตรวจสอบสิทธิ์…</p>
  }

  if (!session) return <LoginForm />

  return <>{children}</>
}

function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) setError(err.message)
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <h1 className="text-lg font-bold">🎲 เข้าสู่ระบบพนักงาน</h1>
        <form onSubmit={submit} className="mt-4 space-y-2">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="อีเมล"
            required
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="รหัสผ่าน"
            required
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
          />
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
          </Button>
        </form>
        <p className="mt-4 text-xs text-slate-500">
          บัญชีถูกสร้างโดยเจ้าของร้านใน Supabase แล้วเพิ่มลงตาราง <code>staff</code>
        </p>
      </Card>
    </div>
  )
}

export function SignOutButton() {
  if (!supabase) return null
  return (
    <Button onClick={() => void supabase!.auth.signOut()} className="!py-1 !text-xs">
      ออกจากระบบ
    </Button>
  )
}
