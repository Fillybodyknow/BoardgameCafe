/**
 * สร้างบัญชีพนักงาน
 *
 * ทำไมต้องมีไฟล์นี้: การสร้างบัญชีใน Supabase Auth ต้องใช้ service_role key
 * ซึ่งมีอำนาจข้าม RLS ทั้งหมด ถ้าเอาไปไว้ในเว็บ static ใครก็เปิด devtools
 * อ่านแล้วยึดฐานข้อมูลทั้งก้อนได้ คีย์นั้นจึงต้องอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
 *
 * ลำดับการทำงาน
 *   1. ตรวจว่าคนเรียกเป็นผู้จัดการหรือเจ้าของร้านจริง โดยใช้ token ของเขาเอง
 *      (ไม่ใช่ service_role) ให้ฐานข้อมูลเป็นคนตอบ
 *   2. สร้างบัญชี Auth ด้วย service_role
 *   3. เรียก register_staff() ซึ่งเป็นที่เก็บกติกา "ใครตั้งใครเป็นอะไรได้"
 *   4. ถ้าขั้น 3 ล้ม ให้ลบบัญชีที่เพิ่งสร้างทิ้ง ไม่ให้เหลือบัญชีลอยที่ล็อกอิน
 *      ได้แต่ไม่อยู่ในทะเบียนพนักงาน
 *
 * Deploy: Supabase Dashboard → Edge Functions → Deploy a new function
 *         ตั้งชื่อ create-staff แล้ววางไฟล์นี้ทั้งไฟล์
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

/** โดเมนของอีเมลภายใน พนักงานไม่เคยเห็นและไม่มีการส่งเมลไปที่นี่ */
const EMAIL_DOMAIN = Deno.env.get('STAFF_EMAIL_DOMAIN') ?? 'staff.boardgamecafe.local'

/** ว่าง = อนุญาตทุก origin — ด่านจริงคือการตรวจ token ไม่ใช่ CORS */
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/
const MIN_PASSWORD = 8

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = ALLOWED.length === 0 ? '*' : ALLOWED.includes(origin ?? '') ? origin! : ALLOWED[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) })
  }
  if (req.method !== 'POST') {
    return json({ error: 'ต้องเรียกด้วย POST' }, 405, origin)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader) {
    return json({ error: 'ต้องเข้าสู่ระบบก่อน' }, 401, origin)
  }

  // ---- 1. ตรวจสิทธิ์ด้วย token ของผู้เรียก ไม่ใช่ service_role ----
  // ให้ฐานข้อมูลเป็นคนตอบว่าคนนี้เป็นระดับไหน แทนที่จะถอด JWT อ่านเอง
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: me, error: meErr } = await caller.auth.getUser()
  if (meErr || !me?.user) {
    return json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, 401, origin)
  }

  const { data: role, error: roleErr } = await caller.rpc('my_staff_role')
  if (roleErr) {
    return json({ error: roleErr.message }, 500, origin)
  }
  if (role !== 'manager' && role !== 'owner') {
    return json({ error: 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' }, 403, origin)
  }

  // ---- 2. ตรวจข้อมูลก่อนสร้าง เพื่อไม่ให้เหลือบัญชีลอยถ้าข้อมูลผิด ----
  let body: {
    username?: string
    password?: string
    displayName?: string
    role?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }, 400, origin)
  }

  const username = (body.username ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const displayName = (body.displayName ?? '').trim()
  const newRole = body.role ?? 'staff'

  if (!USERNAME_RE.test(username)) {
    return json(
      {
        error:
          'ชื่อผู้ใช้ต้องยาว 3–30 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข',
      },
      400,
      origin,
    )
  }
  if (password.length < MIN_PASSWORD) {
    return json({ error: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัว` }, 400, origin)
  }
  if (!displayName) {
    return json({ error: 'ต้องใส่ชื่อพนักงาน' }, 400, origin)
  }
  if (!['staff', 'manager', 'owner'].includes(newRole)) {
    return json({ error: 'ระดับสิทธิ์ไม่ถูกต้อง' }, 400, origin)
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // เช็คชื่อซ้ำก่อน เพื่อให้ได้ข้อความที่อ่านรู้เรื่อง แทนที่จะไปล้มตอน insert
  const { data: taken } = await admin
    .from('staff')
    .select('user_id')
    .eq('username', username)
    .maybeSingle()
  if (taken) {
    return json({ error: `ชื่อผู้ใช้ "${username}" ถูกใช้ไปแล้ว` }, 409, origin)
  }

  // ---- 3. สร้างบัญชี Auth ----
  // email_confirm: true เพราะเป็นอีเมลภายใน ไม่มีใครไปกดยืนยันในกล่องจดหมาย
  const email = `${username}@${EMAIL_DOMAIN}`
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
  })

  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'สร้างบัญชีไม่สำเร็จ'
    const dup = msg.toLowerCase().includes('already')
    return json(
      { error: dup ? `ชื่อผู้ใช้ "${username}" ถูกใช้ไปแล้ว` : msg },
      dup ? 409 : 500,
      origin,
    )
  }

  // ---- 4. ใส่ลงทะเบียนพนักงาน กติกาทั้งหมดอยู่ในฟังก์ชันนี้ ----
  const { error: regErr } = await admin.rpc('register_staff', {
    p_user_id: created.user.id,
    p_username: username,
    p_name: displayName,
    p_role: newRole,
    p_actor: me.user.id,
  })

  if (regErr) {
    // ลบบัญชีที่เพิ่งสร้างทิ้ง ไม่ให้เหลือบัญชีที่ล็อกอินได้แต่ไม่มีสิทธิ์อะไรเลย
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: regErr.message }, 400, origin)
  }

  return json({ userId: created.user.id, username, displayName, role: newRole }, 200, origin)
})
