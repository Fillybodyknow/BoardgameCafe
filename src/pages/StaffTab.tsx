import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminDb } from '../data'
import type { StaffMember, StaffRole } from '../domain/types'
import { Badge, Button, Card, Empty } from '../components/ui'
import type { Tone } from '../components/ui'

export const ROLE_LABEL: Record<StaffRole, string> = {
  owner: 'เจ้าของร้าน',
  manager: 'ผู้จัดการ',
  staff: 'พนักงานทั่วไป',
  floor: 'หน้าร้าน',
  kitchen: 'ครัว',
}

const ROLE_HINT: Record<StaffRole, string> = {
  floor: 'ดูผังโต๊ะและการจอง เปิดโต๊ะ รับออเดอร์ เช็คบิล',
  kitchen: 'ดูจอครัวและเปลี่ยนสถานะออเดอร์เท่านั้น',
  staff: 'ทำได้ทั้งหน้าร้านและครัว',
  manager: 'เพิ่มการตั้งค่าร้าน (เมนู โต๊ะ ราคา เวลาทำการ)',
  owner: 'เพิ่มการจัดการบัญชีพนักงาน — ทำได้ทุกอย่าง',
}

/** เรียงจากสิทธิ์น้อยไปมาก ให้คนเลือกไล่อ่านได้ */
export const ROLE_ORDER: StaffRole[] = ['floor', 'kitchen', 'staff', 'manager', 'owner']

const ROLE_TONE: Record<StaffRole, Tone> = {
  owner: 'royal',
  manager: 'lapis',
  staff: 'forest',
  floor: 'gold',
  kitchen: 'ember',
}

const INPUT =
  'w-full rounded-lg border border-line-strong bg-vellum px-3 py-2 text-sm outline-none focus:border-gold'

const BLANK = {
  username: '',
  password: '',
  displayName: '',
  role: 'staff' as StaffRole,
}

export default function StaffTab({ myRole }: { myRole: StaffRole }) {
  const qc = useQueryClient()
  const staff = useQuery({ queryKey: ['admin', 'staff'], queryFn: () => adminDb.listStaff() })
  const [draft, setDraft] = useState<typeof BLANK | null>(null)

  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'staff'] })

  const create = useMutation({
    mutationFn: (v: typeof BLANK) => adminDb.createStaff(v),
    onSuccess: refresh,
  })
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: StaffRole }) => adminDb.setStaffRole(v.userId, v.role),
    onSuccess: refresh,
  })
  const setActive = useMutation({
    mutationFn: (v: { userId: string; active: boolean }) =>
      adminDb.setStaffActive(v.userId, v.active),
    onSuccess: refresh,
  })

  useEffect(() => {
    if (create.isSuccess) setDraft(null)
  }, [create.isSuccess])

  if (staff.isPending) return <Empty icon="👤">กำลังโหลด…</Empty>
  if (staff.isError) {
    return <Empty icon="⚠">{(staff.error as Error).message}</Empty>
  }

  const list = staff.data ?? []
  const activeOwners = list.filter((m) => m.role === 'owner' && m.active).length

  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        onClick={() => {
          create.reset()
          setDraft({ ...BLANK })
        }}
      >
        + เพิ่มบัญชีพนักงาน
      </Button>

      <Card className="text-xs text-ink-faint">
        พนักงานเข้าสู่ระบบด้วย <b className="text-ink">ชื่อผู้ใช้</b> กับรหัสผ่านที่คุณตั้งให้
        ไม่ต้องใช้อีเมล · แจ้งรหัสให้เจ้าตัวแล้วบอกให้เปลี่ยนเองภายหลังได้ที่เจ้าของร้าน
      </Card>

      {list.map((m) => (
        <StaffRow
          key={m.userId}
          member={m}
          myRole={myRole}
          lastOwner={m.role === 'owner' && m.active && activeOwners <= 1}
          onRole={(role) => setRole.mutate({ userId: m.userId, role })}
          onActive={(active) => setActive.mutate({ userId: m.userId, active })}
          error={
            setRole.variables?.userId === m.userId
              ? (setRole.error as Error | null)
              : setActive.variables?.userId === m.userId
                ? (setActive.error as Error | null)
                : null
          }
        />
      ))}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-line-strong bg-parchment p-5 sm:rounded-2xl">
            <h3 className="text-lg font-bold">เพิ่มบัญชีพนักงาน</h3>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs text-ink-faint">ชื่อผู้ใช้ (ใช้เข้าสู่ระบบ)</span>
                <input
                  autoFocus
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder="somchai"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`${INPUT} mt-1`}
                />
                <span className="mt-1 block text-xs text-ink-faint">
                  a-z 0-9 . _ - ยาว 3–30 ตัว · เปลี่ยนทีหลังไม่ได้
                </span>
              </label>

              <label className="block">
                <span className="text-xs text-ink-faint">รหัสผ่าน</span>
                <input
                  type="text"
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  placeholder="อย่างน้อย 8 ตัว"
                  autoComplete="new-password"
                  className={`${INPUT} mt-1`}
                />
                <span className="mt-1 block text-xs text-ink-faint">
                  แสดงเป็นตัวอักษรเพื่อให้จดไปบอกเจ้าตัวได้
                </span>
              </label>

              <label className="block">
                <span className="text-xs text-ink-faint">ชื่อที่แสดงในระบบ</span>
                <input
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  placeholder="สมชาย"
                  className={`${INPUT} mt-1`}
                />
              </label>

              <div>
                <span className="text-xs text-ink-faint">ระดับสิทธิ์</span>
                <div className="mt-1 space-y-1">
                  {ROLE_ORDER
                    // ยกสิทธิ์จัดการบัญชีให้คนอื่นได้เฉพาะคนที่มีสิทธิ์นั้นเอง
                    .filter((r) => r !== 'owner' || myRole === 'owner')
                    .map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setDraft({ ...draft, role: r })}
                        className={`block w-full rounded-lg border p-2 text-left transition ${
                          draft.role === r
                            ? 'border-gold bg-gold/10'
                            : 'border-line hover:border-line-strong'
                        }`}
                      >
                        <div className="text-sm font-semibold">{ROLE_LABEL[r]}</div>
                        <div className="text-xs text-ink-faint">{ROLE_HINT[r]}</div>
                      </button>
                    ))}
                </div>
              </div>
            </div>

            {create.error && (
              <p className="mt-3 text-sm text-crimson">{(create.error as Error).message}</p>
            )}

            <div className="mt-5 flex gap-2">
              <Button className="flex-1" onClick={() => setDraft(null)} disabled={create.isPending}>
                ยกเลิก
              </Button>
              <Button
                className="flex-1"
                variant="primary"
                disabled={create.isPending}
                onClick={() => create.mutate(draft)}
              >
                {create.isPending ? 'กำลังสร้าง…' : 'สร้างบัญชี'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StaffRow({
  member: m,
  myRole,
  lastOwner,
  onRole,
  onActive,
  error,
}: {
  member: StaffMember
  myRole: StaffRole
  lastOwner: boolean
  onRole: (role: StaffRole) => void
  onActive: (active: boolean) => void
  error: Error | null
}) {
  // ตั้งเจ้าของร้านได้เฉพาะเจ้าของร้านด้วยกัน และเปลี่ยนสิทธิ์ตัวเองไม่ได้
  const canChangeRole = !m.isSelf && (myRole === 'owner' || m.role !== 'owner')

  return (
    <Card className={m.active ? '' : 'opacity-60'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{m.displayName}</span>
            <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
            {m.isSelf && <Badge tone="forest">คุณ</Badge>}
            {!m.active && <Badge tone="crimson">ปิดใช้งาน</Badge>}
          </div>
          <div className="mt-0.5 text-sm text-ink-faint">ชื่อผู้ใช้ {m.username}</div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <select
            value={m.role}
            disabled={!canChangeRole}
            onChange={(e) => onRole(e.target.value as StaffRole)}
            className="rounded-lg border border-line-strong bg-vellum px-2 py-1.5 text-sm outline-none disabled:opacity-40"
          >
            {ROLE_ORDER
              .filter((r) => r !== 'owner' || myRole === 'owner' || m.role === 'owner')
              .map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
          </select>

          {m.active ? (
            <Button
              variant="danger"
              disabled={m.isSelf || lastOwner}
              onClick={() => {
                if (confirm(`ปิดการใช้งานบัญชีของ ${m.displayName}? เข้าสู่ระบบไม่ได้อีก`)) {
                  onActive(false)
                }
              }}
            >
              ปิดใช้งาน
            </Button>
          ) : (
            <Button onClick={() => onActive(true)}>เปิดใช้งาน</Button>
          )}
        </div>
      </div>

      {m.isSelf && (
        <p className="mt-2 text-xs text-ink-faint">
          เปลี่ยนสิทธิ์หรือปิดบัญชีตัวเองไม่ได้ — ให้เจ้าของร้านคนอื่นทำให้
        </p>
      )}
      {lastOwner && !m.isSelf && (
        <p className="mt-2 text-xs text-ember-deep">
          เป็นเจ้าของร้านคนสุดท้ายที่ใช้งานได้ ปิดหรือลดสิทธิ์ไม่ได้
        </p>
      )}
      {error && <p className="mt-2 text-sm text-crimson">{error.message}</p>}
    </Card>
  )
}
