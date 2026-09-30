# ตั้งค่า Supabase

## 1. สร้างโปรเจกต์

Supabase → New project → เลือก region **Southeast Asia (Singapore)** (ใกล้ไทยที่สุด)
จดรหัสผ่านฐานข้อมูลไว้

## 2. รัน migration

Dashboard → **SQL Editor** → วางทีละไฟล์ **ตามลำดับนี้** แล้วกด Run:

1. `migrations/20260930000100_init.sql` — ตาราง
2. `migrations/20260930000200_pricing.sql` — เครื่องคิดเงิน
3. `migrations/20260930000300_operations.sql` — RPC
4. `migrations/20260930000400_rls.sql` — สิทธิ์ (**ห้ามข้าม**)
5. `seed.sql` — โต๊ะ เมนู เกม เรตราคา

> ถ้ามี Supabase CLI: `supabase link --project-ref <ref> && supabase db push`

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
