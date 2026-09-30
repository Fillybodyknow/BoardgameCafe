import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { hasSupabase, supabase } from '../data'
import { Button, Card, Icon, INPUT } from '../components/ui'

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
    return <p className="p-8 text-center text-sm text-ink-faint italic">กำลังตรวจสอบสิทธิ์…</p>
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
      <div className="w-full max-w-sm animate-unroll">
        <div className="tapestry pennant relative z-10 mx-auto -mb-6 w-44 px-4 pt-6 pb-10 text-center">
          <div className="wax-seal mx-auto h-16 w-16 text-3xl">⚜</div>
          <div className="brand mt-3 text-sm">Boardgame Cafe</div>
        </div>
        <Card ornate className="pt-10">
          <h1 className="text-center text-lg font-bold">เข้าสู่ระบบพนักงาน</h1>
          <p className="mt-1 text-center text-xs text-ink-faint">แสดงตราผ่านทางก่อนเข้าโรงเตี๊ยม</p>
          <form onSubmit={submit} className="mt-5 space-y-3">
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="อีเมล"
              required
              className={INPUT}
            />
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="รหัสผ่าน"
              required
              className={INPUT}
            />
            {error && <p className="animate-shake text-sm text-crimson">{error}</p>}
            <Button type="submit" variant="primary" className="w-full !py-2.5" disabled={busy}>
              {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </Button>
          </form>
          <p className="mt-5 text-xs text-ink-faint">
            บัญชีถูกสร้างโดยเจ้าของร้านใน Supabase แล้วเพิ่มลงตาราง <code>staff</code>
          </p>
        </Card>
      </div>
    </div>
  )
}

export function SignOutButton() {
  if (!supabase) return null
  return (
    <button
      type="button"
      onClick={() => void supabase!.auth.signOut()}
      className="flex items-center justify-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-gold-light/80 transition hover:bg-white/5 hover:text-gold-light"
    >
      <Icon name="exit" className="h-4 w-4" />
      ออกจากระบบ
    </button>
  )
}
