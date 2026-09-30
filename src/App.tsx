import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FloorMap from "./pages/FloorMap";
import VisitDetail from "./pages/VisitDetail";
import Kitchen from "./pages/Kitchen";
import Games from "./pages/Games";
import Reservations from "./pages/Reservations";
import { IS_MOCK, mockAdapter } from "./data";
import AuthGate, { SignOutButton } from "./auth/AuthGate";
import { Button } from "./components/ui";

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const NAV = [
  { to: "/", label: "ผังโต๊ะ", end: true },
  { to: "/kitchen", label: "ครัว" },
  { to: "/reservations", label: "การจอง" },
  { to: "/games", label: "คลังเกม" },
];

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthGate>
        {/* HashRouter: GitHub Pages ไม่มี rewrite rule ให้ deep link */}
        <HashRouter>
          <div className="mx-auto flex min-h-full max-w-6xl flex-col">
            <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
              <div className="flex items-center gap-4 px-4 py-3">
                <span className="font-bold whitespace-nowrap">
                  🎲 Boardgame Cafe
                </span>
                <nav className="flex gap-1 overflow-x-auto">
                  {NAV.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        `rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition ${
                          isActive
                            ? "bg-slate-800 text-slate-100"
                            : "text-slate-400 hover:text-slate-200"
                        }`
                      }
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </nav>
                <div className="ml-auto">
                  <SignOutButton />
                </div>
              </div>
            </header>

            {IS_MOCK && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
                <span>
                  โหมดเดโม — ข้อมูลอยู่ใน localStorage ของเบราว์เซอร์นี้เท่านั้น
                  ยังไม่ได้ต่อฐานข้อมูลจริง
                </span>
                <Button
                  variant="ghost"
                  className="!py-0.5 !text-xs"
                  onClick={() => {
                    if (confirm("ล้างข้อมูลเดโมและเริ่มใหม่?"))
                      mockAdapter.reset();
                  }}
                >
                  รีเซ็ตข้อมูล
                </Button>
              </div>
            )}

            <main className="flex-1 p-4">
              <Routes>
                <Route path="/" element={<FloorMap />} />
                <Route path="/visit/:visitId" element={<VisitDetail />} />
                <Route path="/kitchen" element={<Kitchen />} />
                <Route path="/reservations" element={<Reservations />} />
                <Route path="/games" element={<Games />} />
                <Route
                  path="*"
                  element={<p className="text-slate-400">ไม่พบหน้านี้</p>}
                />
              </Routes>
            </main>
          </div>
        </HashRouter>
      </AuthGate>
    </QueryClientProvider>
  );
}
