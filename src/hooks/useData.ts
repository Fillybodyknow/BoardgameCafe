import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../data'
import type { Snapshot } from '../data/port'

export const SNAPSHOT_KEY = ['snapshot'] as const

/**
 * สถานะทั้งร้าน + สมัครรับการเปลี่ยนแปลง
 * ตอนต่อ Supabase แล้ว subscribe จะกลายเป็น Realtime channel โดยหน้าจอไม่ต้องแก้
 */
export function useSnapshot() {
  const qc = useQueryClient()

  useEffect(() => {
    return db.subscribe(() => {
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY })
    })
  }, [qc])

  return useQuery<Snapshot>({
    queryKey: SNAPSHOT_KEY,
    queryFn: () => db.getSnapshot(),
    staleTime: 0,
  })
}

/** นาฬิกาเดินสำหรับตัวจับเวลา — ของจริงต้องชดเชย offset กับเวลาเซิร์ฟเวอร์ */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
