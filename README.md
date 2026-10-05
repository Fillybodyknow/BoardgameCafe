# 🎲 Boardgame Cafe

ระบบจัดการร้านบอร์ดเกม — คิดบิลตามเวลารายคน, รับออเดอร์, จองโต๊ะ, จัดการคลังเกม

**Demo:** https://fillybodyknow.github.io/BoardgameCafe/

แอปทำงานได้ 2 โหมด สลับอัตโนมัติตามตัวแปรแวดล้อม:

- **โหมดเดโม** (ไม่ตั้งค่าอะไร) — ข้อมูลอยู่ใน `localStorage` เปิดดูได้เลยไม่ต้องล็อกอิน
- **โหมดจริง** (ตั้ง `VITE_SUPABASE_*`) — Supabase + ล็อกอินพนักงาน + realtime

ตั้งค่าโหมดจริง: [supabase/README.md](supabase/README.md)

---

## แนวคิดหลัก

ร้านบอร์ดเกมไม่เหมือนร้านอาหาร ตรงที่คิดเงิน **ตามเวลา** และลูกค้า **เข้า-ออกไม่พร้อมกัน**
สถาปัตยกรรมจึงตั้งบนหลัก 3 ข้อ:

1. **หน่วยคิดค่าเล่นคือ `GuestPass` (รายคน) ไม่ใช่โต๊ะ**
   เพิ่มคนกลางคัน / คนกลับก่อน / ออกไปข้างนอกแล้วหยุดนับเวลา — ทำได้โดยไม่กระทบคนอื่น

2. **โต๊ะเป็นทรัพยากรที่ `Visit` ยืมใช้ผ่าน `Occupancy`**
   ย้ายโต๊ะ = ปิดแถวเดิม เปิดแถวใหม่ บิลไม่กระทบ ประวัติยังอยู่ครบ

3. **ทุก `BillLine` รู้ว่าเป็นของ pass ไหน**
   จึงแยกบิลได้ (`guestPassId = null` แปลว่าแชร์ทั้งโต๊ะ → หารเท่ากัน)

4. **ราคาถูก snapshot ไว้ทุกจุดที่กลายเป็นเงิน**
   `order_lines` เก็บราคาอาหาร ณ เวลาสั่ง และ `guest_passes` เก็บเรตค่าเล่น
   ณ เวลาเช็คอิน เจ้าของร้านขึ้นราคาตอนไหนก็ได้โดยไม่กระทบคนที่กำลังนั่งอยู่
   และไม่กระทบใบเสร็จเก่า

---

## Tech Stack

| ชั้น | ใช้ |
|---|---|
| Hosting | GitHub Pages (static) |
| Frontend | React 18 + TypeScript + Vite 6 |
| UI | Tailwind CSS v4 |
| Data | TanStack Query |
| Router | HashRouter (GH Pages ไม่มี rewrite rule) |
| Auth | Supabase Auth (ล็อกอินพนักงาน) |
| Backend | Supabase — Postgres + Realtime + RLS + RPC |
| Edge Function | `create-staff` (สร้างบัญชี), `notify-kitchen` (ส่ง Web Push) |
| Test | Vitest (client) + Postgres ใน Docker (SQL) |

---

## เริ่มใช้งาน

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 20 เทสต์ฝั่ง client (ตรรกะคิดเงิน + smoke test ทุกหน้า)
npm run test:sql          # รัน migration + เทสต์ SQL บน Postgres ใน Docker
npm run test:sql:upgrade  # ทดสอบเส้นทางอัปเกรดจากฐานข้อมูลเวอร์ชันก่อน
npm run build
```

---

## โครงสร้าง

```
src/
  domain/
    types.ts          โมเดลโดเมนทั้งหมด
    pricing.ts        เครื่องคิดเงิน (ปัดเวลา, เพดานเหมาวัน, VAT, แยกบิล)
    pricing.test.ts
  data/
    port.ts           ★ สัญญาระหว่างหน้าจอกับแหล่งข้อมูล
    index.ts          ★ จุดสลับ backend
    mock/             adapter จำลอง + ข้อมูลเดโม
    supabase/         adapter จริง + realtime
  auth/
    AuthGate.tsx      ด่านล็อกอินพนักงาน
  lib/
    image.ts          ย่อรูปเมนูก่อนอัปโหลด
  pages/
    FloorMap.tsx      ผังโต๊ะ (หน้าหลักของพนักงาน)
    PaymentDialog.tsx รับชำระเงิน (สด/โอน, จ่ายรวม/แยก/หาร)
    TableQR.tsx       สร้างและพิมพ์ QR ประจำโต๊ะ
    Owner.tsx         ตั้งค่าร้าน (ผู้จัดการ/เจ้าของ)
    guest/GuestApp.tsx   หน้าลูกค้าที่สแกน QR ที่โต๊ะ (ไม่ต้องล็อกอิน)
    guest/BookingApp.tsx หน้าจองโต๊ะล่วงหน้า (ไม่ต้องล็อกอิน)
    VisitDetail.tsx   ผู้เล่น + ตัวจับเวลา + ออเดอร์ + บิล + แยกบิล
    OrderDialog.tsx   รับออเดอร์
    Kitchen.tsx       จอครัว (KDS) พร้อม SLA
    Reservations.tsx  คิวจอง
    Games.tsx         คลังเกม

supabase/
  migrations/       schema + RPC + RLS
  seed.sql          โต๊ะ เมนู เกม เรตราคา
  tests/            เทสต์ SQL (รันบน Postgres จริงใน Docker)
```

---

## ความปลอดภัย

เว็บ static = `anon key` อยู่ใน bundle ที่ทุกคนโหลดได้ ด่านจริงอยู่ในฐานข้อมูล:

- เพิกถอนสิทธิ์ทั้งหมดจาก `anon`/`authenticated` ก่อน แล้วค่อยให้ `select` เฉพาะที่ตั้งใจ
- ไม่มี policy `INSERT`/`UPDATE`/`DELETE` ให้ใครเลย — เขียนได้ทางเดียวคือผ่าน RPC ที่ตรวจสิทธิ์เอง
- ราคาและยอดคำนวณในฐานข้อมูลเสมอ ไม่รับตัวเลขจาก client

`npm run test:sql` พิสูจน์ข้อพวกนี้ด้วยการลองโจมตีจริง (แก้ยอดบิล, ปลอมการชำระเงิน,
เรียก RPC โดยไม่ใช่พนักงาน) รายละเอียด: [supabase/README.md](supabase/README.md)

### จองโต๊ะออนไลน์
ลูกค้าจองได้โดยไม่ต้องล็อกอิน แล้วได้ **รหัสจอง 6 ตัว** ไว้เปิดดูและยกเลิกเอง
ต้องใช้คู่กับเบอร์โทรเสมอ — รหัสอย่างเดียวไม่พอ กันคนสุ่มรหัสไล่ดูข้อมูลคนอื่น

ทุกรายการเข้ามาเป็น "รอยืนยัน" ให้พนักงานกดยืนยันอีกที และ `pg_cron` ปล่อยโต๊ะ
ของคนที่เลยเวลานัดเกิน 20 นาทีให้อัตโนมัติ

เวลาทำการและกติกาการจอง (ระยะเวลา, เวลาเก็บโต๊ะระหว่างรอบ, จองล่วงหน้าได้กี่วัน)
แก้ได้ในตาราง `shop_hours` กับ `reservation_config` ไม่ต้องแก้โค้ด

### ลูกค้าสั่งเองผ่าน QR
สิทธิ์มาจาก token ใน QR ไม่ใช่บัญชีผู้ใช้ ทุก RPC ฝั่งลูกค้ารับ token แล้วแปลง
เป็นโต๊ะเองฝั่งเซิร์ฟเวอร์ — ลูกค้าไม่เคยส่ง `visitId` หรือ `tableId` มา
จึงอ้างถึงโต๊ะอื่นไม่ได้แม้จะแก้ค่าที่ส่งไป

token ใช้สั่งของได้เฉพาะตอนที่โต๊ะนั้นเปิดบิลอยู่ และเปลี่ยนได้จากหน้า QR โต๊ะ
ถ้าสงสัยว่าใบที่พิมพ์หลุดออกนอกร้าน

---

## Roadmap

- [x] **Phase 0** — scaffold + CI/CD ขึ้น GitHub Pages
- [x] **Phase 1** — ผังโต๊ะ, visit/pass, จับเวลา, ออเดอร์, บิล, แยกบิล, KDS
- [x] **Phase 1.5** — Supabase: schema + RLS + RPC คิดเงิน + realtime + ล็อกอินพนักงาน
- [x] **Phase 2** — หน้ารับชำระเงิน + QR โต๊ะ + ลูกค้าสั่งเองจากมือถือ
- [x] **Phase 2.5** — จองโต๊ะออนไลน์ + คิวจองฝั่งพนักงาน + ปล่อยโต๊ะอัตโนมัติ
- [x] **Phase 2.6** — หน้าตั้งค่าเจ้าของร้าน (เมนู โต๊ะ เรตราคา เวลาทำการ)
- [x] **Phase 2.7** — รูปประกอบเมนู (ย่อฝั่ง client + Supabase Storage)
- [x] **Phase 2.8** — จัดการบัญชีพนักงานในแอป + ล็อกอินด้วยชื่อผู้ใช้
- [x] **Phase 2.9** — ระดับพนักงานแบบแยกสิทธิ์ (หน้าร้าน / ครัว / ตั้งค่า / บัญชี)
- [x] **Phase 2.95** — แจ้งเตือนออเดอร์เข้าครัว (เสียง + ป้ายแท็บ + Web Push)
- [ ] **Phase 3** — ยืม-คืนเกม + ใช้งานตอนเน็ตหลุด
- [ ] **Phase 3** — ยืม-คืนเกม + ค่าปรับชิ้นส่วนหาย, รวมบิลข้ามกลุ่ม, offline queue
- [ ] **Phase 4** — สมาชิก/แต้ม, โปรโมชัน, รายงาน, สต็อก

---

## การ Deploy

push ขึ้น `main` แล้ว GitHub Actions จะ test → build → deploy ให้อัตโนมัติ

ตั้งค่าครั้งแรก: **Settings → Pages → Source: GitHub Actions**

ตอนต่อ Supabase ให้ใส่ที่ **Settings → Secrets and variables → Actions → Variables**
(ใช้ *Variables* ไม่ใช่ *Secrets* — ค่าพวกนี้ไปโผล่ใน bundle อยู่แล้ว การซ่อนไว้ให้ความรู้สึกปลอดภัยผิด ๆ)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
