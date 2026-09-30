# 🎲 Boardgame Cafe

ระบบจัดการร้านบอร์ดเกม — คิดบิลตามเวลารายคน, รับออเดอร์, จองโต๊ะ, จัดการคลังเกม

**Demo:** https://fillybodyknow.github.io/BoardgameCafe/

> ⚠️ ตอนนี้อยู่ใน **โหมดเดโม** — ข้อมูลเก็บใน `localStorage` ของเบราว์เซอร์ ยังไม่ได้ต่อฐานข้อมูลจริง

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
| Test | Vitest + Testing Library + happy-dom |
| Backend | **ยังไม่มี** — วางแผนใช้ Supabase (Postgres + Realtime + RLS) |

---

## เริ่มใช้งาน

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 20 เทสต์ (ตรรกะคิดเงิน + smoke test ทุกหน้า)
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
  pages/
    FloorMap.tsx      ผังโต๊ะ (หน้าหลักของพนักงาน)
    VisitDetail.tsx   ผู้เล่น + ตัวจับเวลา + ออเดอร์ + บิล + แยกบิล
    OrderDialog.tsx   รับออเดอร์
    Kitchen.tsx       จอครัว (KDS) พร้อม SLA
    Reservations.tsx  คิวจอง
    Games.tsx         คลังเกม
```

---

## 🔴 สิ่งที่ต้องทำก่อนใช้เงินจริง

ระบบนี้ยัง **ไม่พร้อมรับเงินจริง** จนกว่าจะแก้ 4 ข้อนี้:

1. **ย้ายการคิดเงินไปฝั่งเซิร์ฟเวอร์**
   ตอนนี้ `src/domain/pricing.ts` รันในเบราว์เซอร์ → ลูกค้าแก้ยอดได้จาก devtools
   ต้องเป็น Postgres function `calculate_bill(visit_id)` แบบ `SECURITY DEFINER`
   (ไฟล์ปัจจุบันใช้เป็นสเปกอ้างอิงตอนเขียน SQL ได้เลย)

2. **เปิด RLS ทุกตาราง**
   เว็บ static = `anon key` เปิดเผยต่อสาธารณะ RLS คือขอบเขตความปลอดภัยเดียวที่มี
   ลูกค้า `SELECT` ได้เฉพาะ visit ตัวเอง, `INSERT/UPDATE` บน `bills`/`payments` ห้ามโดยสิ้นเชิง

3. **สั่งอาหารต้องผ่าน RPC**
   `place_order()` ตรวจว่า pass ยัง active, โต๊ะตรงกัน, และดึงราคาจาก DB — ไม่รับราคาจาก client

4. **QR โต๊ะใช้ token หมุนเวียน**
   ไม่ใช่ `?table=A1` ธรรมดา ไม่งั้นคนนอกร้านสั่งอาหารได้

---

## Roadmap

- [x] **Phase 0** — scaffold + CI/CD ขึ้น GitHub Pages
- [x] **Phase 1 (mock)** — ผังโต๊ะ, visit/pass, จับเวลา, ออเดอร์, บิล, แยกบิล, KDS
- [ ] **Phase 1.5** — ต่อ Supabase: schema + RLS + RPC คิดเงิน
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
