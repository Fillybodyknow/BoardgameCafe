import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import FloorMap from './pages/FloorMap'
import VisitDetail from './pages/VisitDetail'
import Kitchen from './pages/Kitchen'
import Games from './pages/Games'
import Reservations from './pages/Reservations'
import TableQR from './pages/TableQR'
import Owner from './pages/Owner'
import GuestApp from './pages/guest/GuestApp'
import BookingApp from './pages/guest/BookingApp'
import { IS_MOCK, mockAdapter } from './data'
import AuthGate, { SignOutButton } from './auth/AuthGate'
import { Button, Empty, Icon, SealStamp, onCelebrate } from './components/ui'
import type { IconName } from './components/ui'
import { useNow } from './hooks/useData'

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

// ชื่อเมนูต้องไม่ซ้ำกับหัวหน้าเพจ — เทสต์หาหัวหน้าเพจด้วยข้อความตรงตัว
const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'ผังโต๊ะ', icon: 'castle', end: true },
  { to: '/kitchen', label: 'ครัว', icon: 'cauldron' },
  { to: '/reservations', label: 'การจอง', icon: 'scroll' },
  { to: '/games', label: 'คลังเกม', icon: 'dice' },
  { to: '/qr', label: 'QR โต๊ะ', icon: 'qr' },
  { to: '/owner', label: 'ตั้งค่า', icon: 'crown' },
]

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      {/* HashRouter: GitHub Pages ไม่มี rewrite rule ให้ deep link */}
      <HashRouter>
        <Routes>
          {/*
            หน้าลูกค้าอยู่นอกด่านล็อกอินโดยตั้งใจ — สิทธิ์มาจาก token ใน QR
            ไม่ใช่จากบัญชีผู้ใช้ ฝั่งฐานข้อมูลเปิดให้ anon เรียกเฉพาะ 4 ฟังก์ชัน
            ที่แปลง token เป็นโต๊ะเองเท่านั้น
          */}
          <Route path="/t/:token" element={<GuestApp />} />

          {/* หน้าจองโต๊ะ — ลูกค้ายังไม่ได้มาร้าน ไม่มีทั้งบัญชีและ QR token */}
          <Route path="/book" element={<BookingApp />} />

          <Route
            path="*"
            element={
              <AuthGate>
                <StaffShell />
              </AuthGate>
            }
          />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}

/**
 * โครงหน้าพนักงาน
 *
 * เมนูนำทาง render ครั้งเดียว แล้วใช้ CSS จัดตำแหน่งตามขนาดจอ:
 * จอใหญ่เป็นแถบผ้าทอด้านซ้าย มือถือ/แท็บเล็ตเป็นแถบแท็บติดขอบล่าง
 * (render สองชุดไม่ได้ — ข้อความเมนูจะซ้ำ ทำให้เทสต์ที่หาด้วยข้อความพัง)
 */
function StaffShell() {
  const location = useLocation()
  const [stamp, setStamp] = useState<string | null>(null)

  useEffect(
    () =>
      onCelebrate((message) => {
        setStamp(message)
        setTimeout(() => setStamp(null), 1800)
      }),
    [],
  )

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="tapestry sticky top-0 z-40 flex items-center gap-3 px-4 py-3 shadow-[0_4px_20px_-8px_rgb(40_10_12/0.6)] lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 lg:flex-col lg:items-stretch lg:gap-0 lg:p-0">
        <div className="flex min-w-0 flex-1 items-center gap-3 lg:flex-none lg:flex-col lg:px-6 lg:pt-8 lg:pb-6 lg:text-center">
          <div className="wax-seal h-10 w-10 shrink-0 text-xl lg:h-16 lg:w-16 lg:text-3xl">⚜</div>
          <div className="min-w-0">
            <div className="brand truncate text-lg lg:text-xl">Boardgame Cafe</div>
            <div className="hidden font-display text-[0.65rem] tracking-[0.3em] text-gold-light/60 uppercase lg:block">
              โรงเตี๊ยมนักเล่น
            </div>
          </div>
        </div>

        <div className="mx-6 hidden border-t border-gold-light/15 lg:block" />

        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gold-light/20 bg-wine/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:static lg:flex-1 lg:flex-col lg:gap-1 lg:border-0 lg:bg-transparent lg:px-3 lg:py-4 lg:backdrop-blur-none">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `nav-item flex-1 flex-col gap-0.5 py-2 text-[0.68rem] lg:flex-none lg:flex-row lg:gap-3 lg:rounded-lg lg:px-4 lg:py-2.5 lg:text-sm ${
                  isActive ? 'active' : ''
                }`
              }
            >
              <Icon name={item.icon} className="h-5 w-5 shrink-0" />
              <span className="whitespace-nowrap">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2 lg:flex-col lg:items-stretch lg:gap-3 lg:border-t lg:border-gold-light/15 lg:p-5">
          <ShopClock />
          <SignOutButton />
        </div>
      </aside>

      {IS_MOCK && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ember/30 bg-ember/10 px-4 py-2 text-xs text-ember-deep sm:px-8">
          <span className="flex items-center gap-2">
            <Icon name="flag" className="h-4 w-4 shrink-0" />
            โหมดเดโม — ข้อมูลอยู่ใน localStorage ของเบราว์เซอร์นี้เท่านั้น ยังไม่ได้ต่อฐานข้อมูลจริง
          </span>
          <Button
            variant="ghost"
            className="!px-2.5 !py-1 !text-xs"
            onClick={() => {
              if (confirm('ล้างข้อมูลเดโมและเริ่มใหม่?')) mockAdapter.reset()
            }}
          >
            รีเซ็ตข้อมูล
          </Button>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 pt-6 pb-28 sm:px-8 lg:pt-10 lg:pb-12">
        {/* key ตาม path ให้แอนิเมชันเข้าหน้าเล่นใหม่ทุกครั้งที่เปลี่ยนหน้า */}
        <div key={location.pathname} className="animate-page">
          <Routes>
            <Route path="/" element={<FloorMap />} />
            <Route path="/visit/:visitId" element={<VisitDetail />} />
            <Route path="/kitchen" element={<Kitchen />} />
            <Route path="/reservations" element={<Reservations />} />
            <Route path="/games" element={<Games />} />
            <Route path="/qr" element={<TableQR />} />
            <Route path="/owner" element={<Owner />} />
            <Route path="*" element={<Empty icon="⚔">ไม่พบหน้านี้ — ทางนี้ไม่มีปราสาท</Empty>} />
          </Routes>
        </div>
      </main>

      {stamp && <SealStamp message={stamp} />}
    </div>
  )
}

/** นาฬิกาประจำร้าน — แยก component ไว้ ไม่ให้ทั้งหน้า render ใหม่ทุกนาที */
function ShopClock() {
  const now = useNow(30_000)
  return (
    <div className="hidden text-center lg:block">
      <div className="tabular text-2xl font-semibold text-gold-light">
        {now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="text-xs text-gold-light/60">
        {now.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
    </div>
  )
}
