# ตั้งค่า Supabase

## 1. สร้างโปรเจกต์

Supabase → New project → เลือก region **Southeast Asia (Singapore)** (ใกล้ไทยที่สุด)
จดรหัสผ่านฐานข้อมูลไว้

## 2. รัน migration

Dashboard → **SQL Editor** → New query → วาง **`setup-all.sql`** ทั้งไฟล์ → Run

ไฟล์เดียวจบ (รวม migration ทั้ง 4 + seed ไว้แล้ว ตามลำดับที่ถูกต้อง)
เสร็จแล้วต้องได้ 17 ตาราง เปิด RLS ครบทุกตาราง

ตรวจว่าสำเร็จ — รันต่อใน SQL Editor:

```sql
select
  (select count(*) from information_schema.tables where table_schema = 'public') as tables,   -- 17
  (select count(*) from pg_tables where schemaname = 'public' and rowsecurity) as rls_on,     -- 17
  (select count(*) from menu_items)  as menu,        -- 10
  (select count(*) from cafe_tables) as cafe_tables; -- 8
```

<details>
<summary>หรือวางทีละไฟล์ (ถ้าอยากเห็นทีละขั้น)</summary>

1. `migrations/20260930000100_init.sql` — ตาราง
2. `migrations/20260930000200_pricing.sql` — เครื่องคิดเงิน
3. `migrations/20260930000300_operations.sql` — RPC
4. `migrations/20260930000400_rls.sql` — สิทธิ์ (**ห้ามข้าม**)
5. `seed.sql` — โต๊ะ เมนู เกม เรตราคา

ถ้ามี Supabase CLI: `supabase link --project-ref <ref> && supabase db push`

`setup-all.sql` สร้างใหม่ได้ด้วย `bash scripts/build-setup-sql.sh`
</details>

## 3. สร้างบัญชีพนักงาน

Dashboard → **Authentication → Users → Add user**
(ใส่อีเมล+รหัสผ่าน แล้วติ๊ก Auto Confirm User)

จากนั้นใน SQL Editor — การมีบัญชีเฉย ๆ ยังใช้งานไม่ได้ ต้องอยู่ในทะเบียนพนักงานด้วย:

```sql
insert into staff (user_id, display_name, role)
select id, 'ชื่อพนักงาน', 'owner'
from auth.users where email = 'you@example.com';
```

`role` มี 3 ระดับ: `staff` / `manager` / `owner`
(`manager` ขึ้นไปจึงจะอ่าน `audit_log` และทะเบียนพนักงานได้)

## 4. เปิด Realtime

Dashboard → **Database → Replication** → เปิด publication `supabase_realtime`
migration ข้อ 4 เพิ่มตารางที่ต้องใช้ให้แล้ว ถ้า publication ยังไม่มีตอนรัน ให้รันซ้ำอีกครั้ง

## 5. ต่อเข้าแอป

Project Settings → API → คัดลอก **Project URL** กับ **anon public key**

**ในเครื่อง** — สร้างไฟล์ `.env.local` ที่รากโปรเจกต์:

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
```

**บน GitHub** — Settings → Secrets and variables → Actions → แท็บ **Variables**
เพิ่มชื่อเดียวกันทั้งสองตัว

> ใช้ *Variables* ไม่ใช่ *Secrets* — ค่าพวกนี้ถูกฝังใน JavaScript ที่ทุกคนโหลดได้อยู่แล้ว
> การเก็บเป็น Secret ไม่ได้ทำให้ปลอดภัยขึ้น แค่ทำให้เข้าใจผิดว่าปลอดภัย

แอปจะสลับไปใช้ Supabase เองทันทีที่เจอตัวแปรทั้งสอง ถ้าไม่เจอจะกลับไปโหมดเดโม

---

## ทดสอบ

```bash
npm run test:sql     # ต้องเปิด Docker Desktop ก่อน
```

รัน migration ทั้งหมดบน Postgres 16 สะอาด ๆ แล้วตรวจ:

- **ตรรกะคิดเงิน** — เคสเดียวกับ `src/domain/pricing.test.ts` ทุกข้อ ยอดต้องตรงกัน
- **RPC** — เปิดโต๊ะ, เพิ่มคนกลางคัน, พัก/กลับก่อน, ย้ายโต๊ะ, idempotency, ลำดับสถานะออเดอร์, ปิดบิล
- **RLS** — ลูกค้าที่ไม่ได้ล็อกอินอ่านบิลไม่ได้ แก้ยอดไม่ได้ ปลอมการชำระเงินไม่ได้
  และคนที่ล็อกอินแล้วแต่ไม่อยู่ในทะเบียนพนักงาน ก็เปิดโต๊ะไม่ได้

---

## สถาปัตยกรรมความปลอดภัย

หน้าเว็บเป็น static บน GitHub Pages — anon key อยู่ในไฟล์ JS ที่ใครก็โหลดได้
ยิง PostgREST ตรงได้โดยไม่ผ่านหน้าจอเรา ดังนั้นด่านจริงมี 3 ชั้น:

1. **เพิกถอนสิทธิ์ก่อน** — `revoke all ... from anon, authenticated`
   แล้วค่อย `grant select` เฉพาะที่ตั้งใจ
   (Supabase ให้สิทธิ์ `ALL` กับตารางใหม่อัตโนมัติ ถ้าไม่เพิกถอน RLS อย่างเดียวไม่พอ —
   RLS คุมได้แค่ว่าเห็น *แถวไหน* ไม่ได้คุมว่า *ทำอะไรได้*)

2. **ไม่มี policy INSERT/UPDATE/DELETE ให้ใครเลย** แม้แต่พนักงาน
   การเขียนทุกอย่างผ่าน RPC ที่เป็น `SECURITY DEFINER` และเรียก `assert_staff()`

3. **ราคาและยอดมาจากฐานข้อมูลเสมอ**
   `place_order()` ไม่รับราคาจาก client — ดึงจาก `menu_items` เอง
   `preview_bill()` คำนวณใหม่ทุกครั้ง ไม่เชื่อตัวเลขที่ส่งมา

`src/domain/pricing.ts` ฝั่ง client ยังอยู่ แต่ใช้แค่กับโหมดเดโม
เมื่อต่อ Supabase แล้ว ยอดที่ใช้เก็บเงินจริงมาจาก `preview_bill()` เท่านั้น

---

## ยังไม่ได้ทำ

- **ลูกค้าสั่งเองผ่าน QR** — ต้องมี table token หมุนเวียน + policy สำหรับ anon
  ตอนนี้ `place_order()` ยังบังคับว่าต้องเป็นพนักงาน
- **ยืม-คืนเกม** — ตาราง `game_loans` มีแล้ว แต่ยังไม่มี RPC และหน้าจอ
- **ปล่อยโต๊ะจองอัตโนมัติ** — ต้องตั้ง `pg_cron`
- **รับชำระแบบแยกบิล** — `close_visit()` รับ `paidFor` ได้แล้ว แต่หน้าจอยังส่งมาไม่ครบ


---

## Edge Function: สร้างบัญชีพนักงาน

การสร้างบัญชีใน Supabase Auth ต้องใช้ **service_role key** ซึ่งมีอำนาจข้าม RLS
ทั้งหมด ถ้าอยู่ในเว็บ static ใครก็เปิด devtools อ่านแล้วยึดฐานข้อมูลทั้งก้อนได้
คีย์นั้นจึงต้องอยู่ฝั่งเซิร์ฟเวอร์ — เป็นที่มาของ Edge Function ตัวนี้

### Deploy (ทำผ่านหน้าเว็บ ไม่ต้องลง CLI)

1. Supabase Dashboard → **Edge Functions** → **Deploy a new function**
2. ตั้งชื่อ **`create-staff`** (ต้องตรงตัว หน้าแอปเรียกชื่อนี้)
3. วางเนื้อหาของ [`functions/create-staff/index.ts`](functions/create-staff/index.ts) ทั้งไฟล์
4. Deploy

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` ถูกใส่ให้อัตโนมัติ
ไม่ต้องตั้งเอง

### ตัวแปรเสริม (ไม่ตั้งก็ได้)

| ชื่อ | ค่าเริ่มต้น | ไว้ทำอะไร |
|---|---|---|
| `STAFF_EMAIL_DOMAIN` | `staff.boardgamecafe.local` | โดเมนของอีเมลภายใน พนักงานไม่เคยเห็นและไม่มีการส่งเมลไปที่นี่ |
| `ALLOWED_ORIGINS` | ทุก origin | จำกัดว่าเรียกจากเว็บไหนได้ คั่นด้วยจุลภาค |

> ไม่ตั้ง `ALLOWED_ORIGINS` ก็ไม่ได้เปิดช่องให้ใคร — ด่านจริงคือการตรวจ token
> ว่าเป็นผู้จัดการหรือเจ้าของร้าน ไม่ใช่ CORS

### ตรวจว่าใช้ได้จริง

เข้าแอป → ตั้งค่าร้าน → พนักงาน → เพิ่มบัญชี แล้วลองออกจากระบบและเข้าใหม่
ด้วยชื่อผู้ใช้/รหัสผ่านที่เพิ่งตั้ง

ถ้าขึ้นว่า "เรียกบริการสร้างบัญชีไม่สำเร็จ" แปลว่ายังไม่ได้ deploy หรือชื่อ
function ไม่ตรง — ส่วนที่เหลือ (ดูรายชื่อ เปลี่ยนสิทธิ์ เปิด/ปิดใช้งาน)
ใช้ RPC ปกติ จึงทำงานได้โดยไม่ต้องมี Edge Function

---

## เข้าสู่ระบบด้วยชื่อผู้ใช้

Supabase Auth ไม่มีการล็อกอินด้วย username ให้ มีแต่อีเมล/เบอร์/OAuth
ทุกบัญชีจึงมีอีเมลภายในที่พนักงานไม่เคยเห็น และตาราง `staff` เป็นตัวแมปกลับ
ผ่านฟังก์ชัน `login_email_for()`

ทำแบบนี้แทนที่จะต่อ `@โดเมน` เอาเองทั้งสองฝั่ง เพราะ:

1. ถ้าหน้าจอกับฝั่งสร้างบัญชีใช้โดเมนคนละตัว จะล็อกอินไม่ได้แบบเงียบ ๆ
2. บัญชีเดิมที่สร้างด้วยอีเมลจริงยังใช้ได้ ไม่ต้องสร้างใหม่ (พิมพ์อีเมลเต็มก็ยังเข้าได้)

ชื่อผู้ใช้ที่ไม่มีอยู่จะได้อีเมลปลอมกลับไปแล้วไปล้มที่ขั้นรหัสผ่าน — ตั้งใจให้
เป็นแบบนั้น จะได้ไม่บอกคนนอกว่ามีชื่อผู้ใช้ไหนอยู่ในระบบบ้าง

บัญชีที่มีอยู่ก่อน patch นี้จะได้ชื่อผู้ใช้จากส่วนหน้า `@` ของอีเมลอัตโนมัติ
(เช่น `somchai@gmail.com` → ชื่อผู้ใช้ `somchai`) ดูได้ที่หน้าตั้งค่า → พนักงาน
