import { useState } from 'react'
import { useSnapshot } from '../hooks/useData'
import { Badge, Card, Empty, SectionTitle } from '../components/ui'

const WEIGHT_LABEL = ['', 'เบามาก', 'เบา', 'กลาง', 'หนัก', 'หนักมาก']

export default function Games() {
  const { data } = useSnapshot()
  const [players, setPlayers] = useState(0)
  const [maxMinutes, setMaxMinutes] = useState(0)
  const [onlyAvailable, setOnlyAvailable] = useState(true)

  if (!data) return null

  const games = data.games.filter((game) => {
    if (players > 0 && (players < game.minPlayers || players > game.maxPlayers)) return false
    if (maxMinutes > 0 && game.playMinutes > maxMinutes) return false
    if (onlyAvailable && game.copies - game.onLoan <= 0) return false
    return true
  })

  return (
    <div className="space-y-4">
      <SectionTitle>คลังเกม ({data.games.length} ชื่อเรื่อง)</SectionTitle>

      <Card className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-400">เล่นกี่คน</span>
          <select
            value={players}
            onChange={(e) => setPlayers(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 outline-none"
          >
            <option value={0}>ทั้งหมด</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>{n} คน</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-slate-400">เวลาไม่เกิน</span>
          <select
            value={maxMinutes}
            onChange={(e) => setMaxMinutes(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 outline-none"
          >
            <option value={0}>ไม่จำกัด</option>
            {[20, 30, 60, 90, 120].map((n) => (
              <option key={n} value={n}>{n} นาที</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={onlyAvailable}
            onChange={(e) => setOnlyAvailable(e.target.checked)}
            className="accent-emerald-500"
          />
          <span className="text-slate-400">เฉพาะที่ว่างอยู่</span>
        </label>
      </Card>

      {games.length === 0 ? (
        <Empty>ไม่มีเกมที่ตรงเงื่อนไข</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {games.map((game) => {
            const free = game.copies - game.onLoan
            return (
              <Card key={game.id}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{game.name}</h3>
                  <Badge tone={free > 0 ? 'emerald' : 'rose'}>
                    {free > 0 ? `ว่าง ${free}` : 'ถูกยืมหมด'}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-xs text-slate-400">
                  <span className="rounded bg-slate-800 px-1.5 py-0.5">
                    {game.minPlayers === game.maxPlayers
                      ? `${game.minPlayers} คน`
                      : `${game.minPlayers}–${game.maxPlayers} คน`}
                  </span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5">~{game.playMinutes} นาที</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5">
                    {WEIGHT_LABEL[game.weight]}
                  </span>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
