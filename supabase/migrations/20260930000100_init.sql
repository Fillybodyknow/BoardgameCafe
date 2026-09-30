-- ============================================================================
-- Boardgame Cafe — schema เริ่มต้น
--
-- หลักการ:
--   1. GuestPass เป็นหน่วยคิดค่าเล่น ไม่ใช่โต๊ะ
--   2. Occupancy แยกโต๊ะออกจากบิล — ย้ายโต๊ะได้โดยยอดไม่กระทบ
--   3. ทุก bill_line ผูกกับ pass (null = แชร์ทั้งโต๊ะ) จึงแยกบิลได้
--
-- ความปลอดภัย: หน้าเว็บเป็น static บน GitHub Pages ทุกคนเห็น anon key
--   ดังนั้น RLS คือขอบเขตความปลอดภัยเดียวที่มี และการเขียนข้อมูลทุกอย่าง
--   ต้องผ่าน RPC ที่ตรวจสิทธิ์เอง ไม่เปิด INSERT/UPDATE ตรงให้ client
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums ----

create type visit_status       as enum ('open', 'billing', 'paid', 'closed', 'void');
create type pass_status        as enum ('active', 'paused', 'checked_out', 'billed');
create type table_status       as enum ('free', 'reserved', 'occupied', 'cleaning');
create type order_status       as enum ('placed', 'accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled');
create type split_mode         as enum ('owner', 'shared');
create type placed_by_actor    as enum ('guest', 'staff');
create type bill_line_source   as enum ('play_time', 'order_item', 'game_penalty', 'adjustment');
create type reservation_status as enum ('pending', 'confirmed', 'seated', 'no_show', 'cancelled');
create type menu_category      as enum ('drink', 'snack', 'food', 'dessert');
create type visit_source       as enum ('walkin', 'reservation');

-- ---------------------------------------------------------------- staff ----

create table staff (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text not null,
  role         text not null default 'staff' check (role in ('staff', 'manager', 'owner')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ตรวจสิทธิ์พนักงาน — ใช้ซ้ำในทุก policy และทุก RPC
-- SECURITY DEFINER เพื่อให้อ่าน staff ได้โดยไม่ต้องเปิด policy วนซ้ำกับตัวเอง
create function is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from staff
    where user_id = auth.uid() and active
  );
$$;

-- ------------------------------------------------------------ ราคา/เมนู ----

create table rate_plans (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  price_per_hour    numeric(10,2) not null check (price_per_hour >= 0),
  round_to_minutes  int not null default 30 check (round_to_minutes > 0),
  minimum_minutes   int not null default 60 check (minimum_minutes >= 0),
  -- เพดานเหมาจ่ายทั้งวัน — null = ไม่มีเพดาน
  day_pass_cap      numeric(10,2) check (day_pass_cap is null or day_pass_cap >= 0),
  active            boolean not null default true,
  sort_order        int not null default 0
);

create table menu_items (
  id         uuid primary key default gen_random_uuid(),
  sku        text not null unique,
  name       text not null,
  category   menu_category not null,
  price      numeric(10,2) not null check (price >= 0),
  available  boolean not null default true,
  sort_order int not null default 0
);

-- ---------------------------------------------------------------- โต๊ะ ----

create table cafe_tables (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  zone        text not null,
  seat_min    int not null check (seat_min > 0),
  seat_max    int not null,
  -- โต๊ะยาว/เคาน์เตอร์ ให้คนละกลุ่มนั่งร่วมกันได้
  allow_share boolean not null default false,
  status      table_status not null default 'free',
  sort_order  int not null default 0,
  constraint seat_range check (seat_max >= seat_min)
);

-- --------------------------------------------------------------- visit ----

create sequence visit_code_seq;

create table visits (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique default 'V-' || lpad(nextval('visit_code_seq')::text, 4, '0'),
  source        visit_source not null default 'walkin',
  status        visit_status not null default 'open',
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  -- ตัดรอบขายตามวันทำการ ไม่ใช่วันปฏิทิน (ร้านปิดหลังเที่ยงคืน)
  business_date date not null default ((now() at time zone 'Asia/Bangkok') - interval '5 hours')::date,
  note          text
);

create index visits_open_idx on visits (status) where status = 'open';
create index visits_business_date_idx on visits (business_date);

create table occupancies (
  id       uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits on delete cascade,
  table_id uuid not null references cafe_tables,
  from_at  timestamptz not null default now(),
  to_at    timestamptz,
  -- คัดลอกมาจาก cafe_tables.allow_share ตอนสร้าง เพื่อให้บังคับด้วย index ได้
  -- (index predicate อ้างตารางอื่นไม่ได้)
  exclusive boolean not null default true,
  constraint occupancy_range check (to_at is null or to_at >= from_at)
);

-- โต๊ะที่ห้ามนั่งร่วม มี occupancy เปิดอยู่ได้ครั้งละกลุ่มเดียว
-- โต๊ะยาว/เคาน์เตอร์ (allow_share) ไม่ติดข้อจำกัดนี้
create unique index occupancies_one_open_per_table
  on occupancies (table_id)
  where to_at is null and exclusive;

create index occupancies_visit_idx on occupancies (visit_id);

create table guest_passes (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid not null references visits on delete cascade,
  display_name    text not null,
  rate_plan_id    uuid not null references rate_plans,
  status          pass_status not null default 'active',
  checked_in_at   timestamptz not null default now(),
  checked_out_at  timestamptz,
  -- นาทีที่หักออกเพราะออกไปข้างนอกชั่วคราว
  paused_minutes  int not null default 0 check (paused_minutes >= 0),
  -- เวลาที่เริ่มพักครั้งล่าสุด — not null แปลว่ากำลังพักอยู่
  paused_at       timestamptz,
  constraint paused_consistency check (
    (status = 'paused' and paused_at is not null) or
    (status <> 'paused' and paused_at is null)
  )
);

create index guest_passes_visit_idx on guest_passes (visit_id);

-- -------------------------------------------------------------- ออเดอร์ ----

create table orders (
  id                 uuid primary key default gen_random_uuid(),
  visit_id           uuid not null references visits on delete cascade,
  -- ใครสั่ง — null = แชร์ทั้งโต๊ะ
  ordered_by_pass_id uuid references guest_passes on delete set null,
  placed_by          placed_by_actor not null default 'staff',
  split_mode         split_mode not null default 'owner',
  -- โต๊ะ ณ เวลาสั่ง เก็บไว้ดูย้อนหลัง จอครัวใช้โต๊ะปัจจุบันแทน
  table_id_snapshot  uuid references cafe_tables,
  status             order_status not null default 'placed',
  placed_at          timestamptz not null default now(),
  -- กันออเดอร์ซ้ำตอนเน็ตหลุดแล้วมือถือ retry
  idempotency_key    text unique,
  constraint shared_has_no_owner check (
    split_mode <> 'shared' or ordered_by_pass_id is null
  )
);

create index orders_visit_idx on orders (visit_id);
create index orders_kitchen_idx on orders (status)
  where status in ('placed', 'accepted', 'preparing', 'ready');

create table order_lines (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders on delete cascade,
  menu_item_id        uuid not null references menu_items,
  -- snapshot ชื่อ+ราคา ณ เวลาสั่ง — แก้เมนูทีหลังต้องไม่กระทบบิลเก่า
  name_snapshot       text not null,
  unit_price_snapshot numeric(10,2) not null check (unit_price_snapshot >= 0),
  qty                 int not null check (qty > 0),
  note                text
);

create index order_lines_order_idx on order_lines (order_id);

-- ---------------------------------------------------------------- เกม ----

create table game_titles (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  min_players  int not null check (min_players > 0),
  max_players  int not null,
  play_minutes int not null check (play_minutes > 0),
  weight       int not null check (weight between 1 and 5),
  copies       int not null default 1 check (copies >= 0),
  constraint player_range check (max_players >= min_players)
);

create table game_loans (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references visits on delete cascade,
  game_title_id uuid not null references game_titles,
  out_at        timestamptz not null default now(),
  returned_at   timestamptz,
  status        text not null default 'out'
                check (status in ('out', 'returned', 'returned_incomplete')),
  penalty       numeric(10,2) not null default 0 check (penalty >= 0),
  note          text
);

create index game_loans_open_idx on game_loans (game_title_id) where returned_at is null;

-- --------------------------------------------------------------- จอง ----

create table reservations (
  id               uuid primary key default gen_random_uuid(),
  customer_name    text not null,
  phone            text not null,
  party_size       int not null check (party_size > 0),
  start_at         timestamptz not null,
  duration_minutes int not null default 120 check (duration_minutes > 0),
  zone_preference  text,
  status           reservation_status not null default 'pending',
  table_ids        uuid[] not null default '{}',
  visit_id         uuid references visits on delete set null,
  note             text,
  created_at       timestamptz not null default now()
);

create index reservations_upcoming_idx on reservations (start_at)
  where status in ('pending', 'confirmed');

-- --------------------------------------------------------------- บิล ----

create table bills (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid not null references visits on delete cascade,
  subtotal        numeric(10,2) not null,
  service_charge  numeric(10,2) not null default 0,
  vat             numeric(10,2) not null default 0,
  total           numeric(10,2) not null,
  status          text not null default 'open' check (status in ('open', 'paid', 'void')),
  closed_at       timestamptz not null default now(),
  closed_by       uuid references auth.users
);

create index bills_visit_idx on bills (visit_id);

create table bill_lines (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills on delete cascade,
  source        bill_line_source not null,
  source_id     uuid,
  -- กุญแจของการแยกบิล — null = แชร์ทั้งโต๊ะ หารเท่ากัน
  guest_pass_id uuid references guest_passes on delete set null,
  label         text not null,
  qty           numeric(10,2) not null default 1,
  unit_price    numeric(10,2) not null,
  amount        numeric(10,2) not null
);

create index bill_lines_bill_idx on bill_lines (bill_id);

create table payments (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references bills on delete cascade,
  method     text not null check (method in ('cash', 'transfer', 'card', 'other')),
  amount     numeric(10,2) not null check (amount > 0),
  -- จ่ายแยกรายคน: ระบุว่าจ่ายแทน pass ไหนบ้าง
  paid_for   uuid[] not null default '{}',
  paid_at    timestamptz not null default now(),
  taken_by   uuid references auth.users,
  note       text
);

create index payments_bill_idx on payments (bill_id);

-- ------------------------------------------------------------- audit ----

-- ทุกการ void / ลดราคา / เปิดบิลใหม่ ต้องทิ้งร่องรอย — กันทุจริตหน้าร้าน
create table audit_log (
  id         bigserial primary key,
  actor      uuid references auth.users,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity, entity_id);
