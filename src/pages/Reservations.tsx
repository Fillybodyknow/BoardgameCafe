import { useNow, useSnapshot } from '../hooks/useData'
import { Badge, Card, Empty, SectionTitle } from '../components/ui'
import type { ReservationStatus } from '../domain/types'
import type { Tone } from '../components/ui'

/** เลยเวลานัดเกินนี้แล้วยังไม่มา → เตือนพนักงานให้ปล่อยโต๊ะ */
const GRACE_MINUTES = 20

const TONE: Record<ReservationStatus, Tone> = {
  pending: 'amber', confirmed: 'sky', seated: 'emerald', no_show: 'rose', cancelled: 'slate',
}
const LABEL: Record<ReservationStatus, string> = {
  pending: 'รอยืนยัน', confirmed: 'ยืนยันแล้ว', seated: 'นั่งแล้ว', no_show: 'ไม่มา', cancelled: 'ยกเลิก',
}

export default function Reservations() {
  const { data } = useSnapshot()
  const now = useNow(30_000)

  if (!data) return null
  if (data.reservations.length === 0) return <Empty>ยังไม่มีการจอง</Empty>

  const sorted = [...data.reservations].sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  )

  return (
    <div className="space-y-4">
      <SectionTitle>คิวจองวันนี้</SectionTitle>
      <div className="space-y-2">
        {sorted.map((r) => {
          const start = new Date(r.startAt)
          const lateBy = Math.floor((now.getTime() - start.getTime()) / 60_000)
          const overdue = lateBy > GRACE_MINUTES && (r.status === 'confirmed' || r.status === 'pending')
          const tables = r.tableIds
            .map((id) => data.tables.find((t) => t.id === id)?.code)
            .filter(Boolean)

          return (
            <Card key={r.id} className={overdue ? 'border-rose-700/70 bg-rose-950/20' : ''}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{r.customerName}</span>
                    <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                    {overdue && <Badge tone="rose">เลยเวลา {lateBy} นาที</Badge>}
                  </div>
                  <div className="tabular mt-1 text-sm text-slate-400">
                    {r.partySize} คน · {r.durationMinutes / 60} ชม. · {r.phone}
                    {tables.length > 0 && <> · โต๊ะ {tables.join(', ')}</>}
                    {r.zonePreference && <> · ขอ{r.zonePreference}</>}
                  </div>
                </div>
                <div className="tabular text-right">
                  <div className="text-lg font-bold">
                    {start.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div className="text-xs text-slate-500">
                    {lateBy < 0 ? `อีก ${-lateBy} นาที` : `ผ่านมา ${lateBy} นาที`}
                  </div>
                </div>
              </div>
            </Card>
          )
        })}
      </div>
      <p className="text-xs text-slate-500">
        โต๊ะจะถูกปล่อยอัตโนมัติเมื่อเลยเวลานัด {GRACE_MINUTES} นาที — ของจริงทำด้วย pg_cron ฝั่ง Supabase
      </p>
    </div>
  )
}
