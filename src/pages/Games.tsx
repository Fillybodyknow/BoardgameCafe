import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from '../hooks/useData'
import type { GameTitle } from '../domain/types'
import { Badge, Button, Card, Empty, Icon, PageHeader } from '../components/ui'

const WEIGHT_LABEL = ['', 'เบามาก', 'เบา', 'กลาง', 'หนัก', 'หนักมาก']

// พื้นปกเกม — เลือกจากชื่อเกม ให้เกมเดิมได้สีเดิมทุกครั้ง
const COVERS = [
  'from-wine to-wine-light',
  'from-lapis-deep to-lapis',
  'from-forest-deep to-forest',
  'from-[#3b2a55] to-royal',
  'from-ember-deep to-ember',
  'from-[#3a2a1c] to-[#6b4f33]',
]

function coverOf(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COVERS[h % COVERS.length]!
}

export default function Games() {
  const { data } = useSnapshot()
  const [players, setPlayers] = useState(0)
  const [maxMinutes, setMaxMinutes] = useState(0)
  const [onlyAvailable, setOnlyAvailable] = useState(true)

  // ลูกเต๋าแห่งโชคชะตา — สุ่มเกมจากรายการที่กรองอยู่
  const [rolling, setRolling] = useState(false)
  const [pointer, setPointer] = useState<string | null>(null)
  const [chosen, setChosen] = useState<GameTitle | null>(null)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  if (!data) return null

  const games = data.games.filter((game) => {
    if (players > 0 && (players < game.minPlayers || players > game.maxPlayers)) return false
    if (maxMinutes > 0 && game.playMinutes > maxMinutes) return false
    if (onlyAvailable && game.copies - game.onLoan <= 0) return false
    return true
  })

  function roll() {
    if (games.length === 0) return
    timers.current.forEach(clearTimeout)
    timers.current = []
    setRolling(true)
    setChosen(null)

    // ไล่ไฮไลต์ไปเรื่อยๆ แล้วช้าลงจนหยุด เหมือนวงล้อ
    const winner = games[Math.floor(Math.random() * games.length)]!
    const steps = 14
    let t = 0
    for (let i = 0; i < steps; i++) {
      t += 50 + i * i * 2.2
      const g = i === steps - 1 ? winner : games[Math.floor(Math.random() * games.length)]!
      timers.current.push(window.setTimeout(() => setPointer(g.id), t))
    }
    timers.current.push(
      window.setTimeout(() => {
        setRolling(false)
        setChosen(winner)
        document.getElementById(`game-${winner.id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      }, t + 250),
    )
  }

  return (
    <div>
      <PageHeader
        eyebrow="ห้องสมุดของโรงเตี๊ยม"
        title="คลังเกม"
        subtitle={`${data.games.length} ชื่อเรื่อง · ตรงเงื่อนไข ${games.length}`}
        actions={
          <Button variant="primary" onClick={roll} disabled={rolling || games.length === 0}>
            <span className={`inline-block ${rolling ? 'dice-rolling' : ''}`} aria-hidden>
              🎲
            </span>
            ทอยลูกเต๋าเลือกเกม
          </Button>
        }
      />

      <Card className="mb-6 space-y-3">
        <FilterRow label="เล่นกี่คน">
          <Chip on={players === 0} onClick={() => setPlayers(0)}>ทั้งหมด</Chip>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <Chip key={n} on={players === n} onClick={() => setPlayers(n)}>
              {n} คน
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="เวลาไม่เกิน">
          <Chip on={maxMinutes === 0} onClick={() => setMaxMinutes(0)}>ไม่จำกัด</Chip>
          {[20, 30, 60, 90, 120].map((n) => (
            <Chip key={n} on={maxMinutes === n} onClick={() => setMaxMinutes(n)}>
              {n} นาที
            </Chip>
          ))}
        </FilterRow>
        <label className="flex cursor-pointer items-center gap-2 pt-1 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={onlyAvailable}
            onChange={(e) => setOnlyAvailable(e.target.checked)}
            className="h-4 w-4 accent-[#3d6b46]"
          />
          เฉพาะที่ว่างอยู่
        </label>
      </Card>

      {chosen && !rolling && (
        <div className="mb-6 flex animate-unroll items-center gap-4 rounded-xl border border-gold/50 bg-gold/10 p-4">
          <div className="wax-seal seal-stamp h-12 w-12 shrink-0 text-xl">🎲</div>
          <div className="min-w-0">
            <div className="text-xs tracking-wide text-gold-deep">โชคชะตาเลือกให้แล้ว</div>
            <div className="truncate font-display text-lg font-bold">คืนนี้เล่น “{chosen.name}”</div>
          </div>
          <button
            type="button"
            className="ml-auto text-sm text-ink-faint underline-offset-2 hover:underline"
            onClick={roll}
          >
            ทอยใหม่
          </button>
        </div>
      )}

      {games.length === 0 ? (
        <Empty icon="📚">ไม่มีเกมที่ตรงเงื่อนไข</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {games.map((game) => {
            const free = game.copies - game.onLoan
            const lit = pointer === game.id && (rolling || chosen?.id === game.id)
            return (
              <article
                id={`game-${game.id}`}
                key={game.id}
                className={`panel lift flex overflow-hidden rounded-xl transition duration-150 ${lit ? 'fate' : ''}`}
              >
                <div
                  className={`relative grid w-24 shrink-0 place-items-center bg-gradient-to-br ${coverOf(game.name)}`}
                  aria-hidden
                >
                  <span className="illuminated text-5xl">{game.name.slice(0, 1)}</span>
                  <span className="absolute inset-1.5 rounded border border-gold-light/30" />
                </div>
                <div className="min-w-0 flex-1 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 text-base leading-snug font-bold">{game.name}</h3>
                    <Badge tone={free > 0 ? 'forest' : 'crimson'}>{free > 0 ? `ว่าง ${free}` : 'ถูกยืมหมด'}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
                    <span className="flex items-center gap-1">
                      <Icon name="users" className="h-3.5 w-3.5" />
                      {game.minPlayers === game.maxPlayers
                        ? `${game.minPlayers} คน`
                        : `${game.minPlayers}–${game.maxPlayers} คน`}
                    </span>
                    <span className="flex items-center gap-1">
                      <Icon name="hourglass" className="h-3.5 w-3.5" />~{game.playMinutes} นาที
                    </span>
                  </div>
                  {/* ความยาก — แสดงเป็นลูกเต๋า 5 ลูก */}
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint" title="ความยาก">
                    <span className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span
                          key={n}
                          className={`h-2.5 w-2.5 rotate-45 rounded-[2px] ${
                            n <= game.weight ? 'bg-gold' : 'border border-line-strong'
                          }`}
                        />
                      ))}
                    </span>
                    {WEIGHT_LABEL[game.weight]}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-24 shrink-0 text-xs font-medium text-ink-soft">{label}</span>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">{children}</div>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  )
}
