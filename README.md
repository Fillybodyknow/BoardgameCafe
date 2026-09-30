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
| Test | Vitest (client) + Postgres ใน Docker (SQL) |

---

## เริ่มใช้งาน

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 20 เทสต์ฝั่ง client (ตรรกะคิดเงิน + smoke test ทุกหน้า)
npm run test:sql   # รัน migration + เทสต์ SQL บน Postgres ใน Docker
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
  pages/
    FloorMap.tsx      ผังโต๊ะ (หน้าหลักของพนักงาน)
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

### ยังทำไม่ได้
ลูกค้าสั่งอาหารเองผ่าน QR — `place_order()` ยังบังคับว่าต้องเป็นพนักงาน
ต้องเพิ่ม table token หมุนเวียนก่อน ไม่งั้นคนนอกร้านสั่งได้

---

## Roadmap

- [x] **Phase 0** — scaffold + CI/CD ขึ้น GitHub Pages
- [x] **Phase 1** — ผังโต๊ะ, visit/pass, จับเวลา, ออเดอร์, บิล, แยกบิล, KDS
- [x] **Phase 1.5** — Supabase: schema + RLS + RPC คิดเงิน + realtime + ล็อกอินพนักงาน
- [ ] **Phase 2** — QR โต๊ะ + ลูกค้าสั่งเอง + จองออนไลน์ + PWA
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
