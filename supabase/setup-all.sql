-- ============================================================================
-- Boardgame Cafe — ติดตั้งครั้งเดียวจบ
--
-- วิธีใช้: Supabase Dashboard → SQL Editor → New query → วางไฟล์นี้ทั้งหมด → Run
--
-- ไฟล์นี้ถูกสร้างจาก supabase/migrations/*.sql + seed.sql
-- อย่าแก้ที่นี่ ให้แก้ที่ไฟล์ต้นทางแล้วสร้างใหม่ด้วย scripts/build-setup-sql.sh
-- ปลอดภัยที่จะรันซ้ำเฉพาะส่วน seed — ส่วน schema รันได้ครั้งเดียว
-- ============================================================================


-- ####################################################################
-- # supabase/migrations/20260930000100_init.sql
-- ####################################################################

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

-- ####################################################################
-- # supabase/migrations/20260930000200_pricing.sql
-- ####################################################################

-- ============================================================================
-- เครื่องคิดเงิน — ต้องให้ผลลัพธ์ตรงกับ src/domain/pricing.ts ทุกกรณี
--
-- ตั้งแต่ไฟล์นี้ถูก apply แล้ว pricing.ts ฝั่ง client เหลือหน้าที่แค่
-- "แสดงตัวเลขระหว่างรอ" เท่านั้น ยอดที่ใช้เก็บเงินจริงมาจากที่นี่
-- ============================================================================

-- อัตราภาษี — แก้ที่เดียว
create table tax_config (
  id                   int primary key default 1 check (id = 1),
  service_charge_rate  numeric(5,4) not null default 0,
  vat_rate             numeric(5,4) not null default 0.07,
  -- true = ราคาที่แสดงรวม VAT แล้ว (ถอดออกมาแสดงในใบเสร็จ)
  vat_included         boolean not null default true
);

insert into tax_config (id) values (1);

-- ---------------------------------------------------------------------------
-- นาทีที่คิดเงินได้ของ pass หนึ่งใบ
-- ตรงกับ billableMinutes() ใน pricing.ts
-- ---------------------------------------------------------------------------
create function billable_minutes(p guest_passes, p_now timestamptz default now())
returns int
language sql stable as $$
  select greatest(0,
    floor(extract(epoch from (coalesce(p.checked_out_at, p_now) - p.checked_in_at)) / 60)::int
    - p.paused_minutes
    -- กำลังพักอยู่ → หักช่วงที่พักมาจนถึงตอนนี้ด้วย
    - case
        when p.paused_at is not null
        then greatest(0, floor(extract(epoch from (p_now - p.paused_at)) / 60)::int)
        else 0
      end
  );
$$;

-- ---------------------------------------------------------------------------
-- ค่าเล่นจากจำนวนนาที
-- ปัดขึ้นตามช่วง → คิดขั้นต่ำ → เทียบเพดานเหมาวัน เลือกที่ถูกกว่าให้ลูกค้า
-- ตรงกับ playTimeCharge() ใน pricing.ts
-- ---------------------------------------------------------------------------
create function play_time_charge(p_minutes int, p_plan rate_plans)
returns numeric
language sql immutable as $$
  with charged as (
    select greatest(p_minutes, p_plan.minimum_minutes) as m
  ), raw as (
    select ceil(m::numeric / p_plan.round_to_minutes)
           * p_plan.round_to_minutes / 60.0
           * p_plan.price_per_hour as amount
    from charged
  )
  select round(
    case
      when p_plan.day_pass_cap is null then amount
      else least(amount, p_plan.day_pass_cap)
    end
  , 2)
  from raw;
$$;

-- ---------------------------------------------------------------------------
-- ยอดเรียลไทม์ของ visit — ไม่ commit อะไร
--
-- คืน jsonb แบบ camelCase ให้ตรงกับ type BillPreview ฝั่ง TypeScript
-- SECURITY DEFINER: อ่านข้ามตารางได้โดยไม่ต้องเปิด RLS ให้ client
-- ---------------------------------------------------------------------------
create function preview_bill(p_visit_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tax     tax_config;
  v_lines   jsonb;
  v_subtotal numeric(10,2);
  v_service numeric(10,2);
  v_base    numeric(10,2);
  v_vat     numeric(10,2);
  v_total   numeric(10,2);
begin
  if not exists (select 1 from visits where id = p_visit_id) then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;

  select * into v_tax from tax_config where id = 1;

  with play as (
    -- 1) ค่าเล่นรายคน
    select
      'bl-play-' || gp.id                          as id,
      'play_time'                                  as source,
      gp.id                                        as source_id,
      gp.id                                        as guest_pass_id,
      'ค่าเล่น · ' || gp.display_name               as label,
      1::numeric                                   as qty,
      play_time_charge(billable_minutes(gp, p_now), rp) as unit_price,
      play_time_charge(billable_minutes(gp, p_now), rp) as amount,
      1                                            as grp,
      gp.checked_in_at                             as ord
    from guest_passes gp
    join rate_plans rp on rp.id = gp.rate_plan_id
    where gp.visit_id = p_visit_id
  ), food as (
    -- 2) อาหาร/เครื่องดื่ม ใช้ราคา snapshot ตอนสั่ง
    --    ออเดอร์ที่ rejected/cancelled ไม่นับ
    select
      'bl-ord-' || ol.id                           as id,
      'order_item'                                 as source,
      ol.id                                        as source_id,
      case when o.split_mode = 'shared' then null else o.ordered_by_pass_id end as guest_pass_id,
      ol.name_snapshot                             as label,
      ol.qty::numeric                              as qty,
      ol.unit_price_snapshot                       as unit_price,
      round(ol.unit_price_snapshot * ol.qty, 2)    as amount,
      2                                            as grp,
      o.placed_at                                  as ord
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.visit_id = p_visit_id
      and o.status in ('placed', 'accepted', 'preparing', 'ready', 'served')
  ), penalty as (
    -- 3) ค่าปรับชิ้นส่วนเกมหาย
    select
      'bl-pen-' || gl.id                           as id,
      'game_penalty'                               as source,
      gl.id                                        as source_id,
      null::uuid                                   as guest_pass_id,
      'ค่าปรับ · ' || gt.name                       as label,
      1::numeric                                   as qty,
      gl.penalty                                   as unit_price,
      gl.penalty                                   as amount,
      3                                            as grp,
      gl.out_at                                    as ord
    from game_loans gl
    join game_titles gt on gt.id = gl.game_title_id
    where gl.visit_id = p_visit_id and gl.penalty > 0
  ), all_lines as (
    select * from play
    union all select * from food
    union all select * from penalty
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'source', source,
        'sourceId', source_id,
        'guestPassId', guest_pass_id,
        'label', label,
        'qty', qty,
        'unitPrice', unit_price,
        'amount', amount
      ) order by grp, ord
    ), '[]'::jsonb),
    coalesce(round(sum(amount), 2), 0)
  into v_lines, v_subtotal
  from all_lines;

  v_service := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base    := v_subtotal + v_service;

  if v_tax.vat_included then
    -- ราคารวม VAT แล้ว → ถอดออกมาแสดง ยอดสุทธิไม่เปลี่ยน
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'visitId',        p_visit_id,
    'lines',          v_lines,
    'subtotal',       v_subtotal,
    'serviceCharge',  v_service,
    'vat',            v_vat,
    'total',          v_total,
    'computedAt',     p_now
  );
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930000300_operations.sql
-- ####################################################################

-- ============================================================================
-- RPC สำหรับทุกการเปลี่ยนแปลงข้อมูล
--
-- client ไม่มีสิทธิ์ INSERT/UPDATE ตรงกับตารางใดเลย (ดู RLS ในไฟล์ถัดไป)
-- ทุกอย่างต้องผ่านฟังก์ชันที่นี่ ซึ่งตรวจสิทธิ์และกติกาธุรกิจเอง
-- ============================================================================

-- ปฏิเสธถ้าไม่ใช่พนักงาน — เรียกเป็นบรรทัดแรกของทุก RPC
create function assert_staff() returns void
language plpgsql stable as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- visit ----

create function open_visit(
  p_table_ids uuid[],
  p_guests    jsonb,          -- [{"name": "...", "ratePlanId": "..."}]
  p_source    visit_source default 'walkin'
) returns visits
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit  visits;
  v_table  cafe_tables;
  v_guest  jsonb;
  v_id     uuid;
begin
  perform assert_staff();

  if jsonb_typeof(p_guests) <> 'array' or jsonb_array_length(p_guests) = 0 then
    raise exception 'ต้องระบุผู้เล่นอย่างน้อย 1 คน' using errcode = '22023';
  end if;

  insert into visits (source) values (p_source) returning * into v_visit;

  foreach v_id in array coalesce(p_table_ids, '{}') loop
    select * into v_table from cafe_tables where id = v_id for update;
    if not found then
      raise exception 'ไม่พบโต๊ะ %', v_id using errcode = 'P0002';
    end if;

    insert into occupancies (visit_id, table_id, exclusive)
    values (v_visit.id, v_table.id, not v_table.allow_share);

    update cafe_tables set status = 'occupied' where id = v_table.id;
  end loop;

  for v_guest in select * from jsonb_array_elements(p_guests) loop
    insert into guest_passes (visit_id, display_name, rate_plan_id)
    values (
      v_visit.id,
      coalesce(nullif(trim(v_guest ->> 'name'), ''), 'ผู้เล่น'),
      (v_guest ->> 'ratePlanId')::uuid
    );
  end loop;

  return v_visit;
end;
$$;

create function add_pass(
  p_visit_id     uuid,
  p_name         text,
  p_rate_plan_id uuid
) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass guest_passes;
begin
  perform assert_staff();

  if not exists (select 1 from visits where id = p_visit_id and status = 'open') then
    raise exception 'visit นี้ไม่ได้เปิดอยู่' using errcode = '22023';
  end if;

  -- นาฬิกาของคนนี้เริ่มนับตอนนี้ ไม่กระทบคนที่มาก่อน
  insert into guest_passes (visit_id, display_name, rate_plan_id)
  values (p_visit_id, coalesce(nullif(trim(p_name), ''), 'ผู้เล่นใหม่'), p_rate_plan_id)
  returning * into v_pass;

  return v_pass;
end;
$$;

create function pause_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  update guest_passes
     set status = 'paused', paused_at = now()
   where id = p_pass_id and status = 'active'
  returning * into v_pass;

  if not found then
    raise exception 'พักได้เฉพาะคนที่กำลังเล่นอยู่' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function resume_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  update guest_passes
     set paused_minutes = paused_minutes
                          + greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int),
         paused_at = null,
         status = 'active'
   where id = p_pass_id and status = 'paused'
  returning * into v_pass;

  if not found then
    raise exception 'คนนี้ไม่ได้อยู่ในสถานะพัก' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function check_out_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  -- กลับก่อนขณะกำลังพัก → เก็บนาทีที่ค้างก่อน ไม่งั้นเวลาหาย
  update guest_passes
     set paused_minutes = paused_minutes + case
           when paused_at is not null
           then greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int)
           else 0 end,
         paused_at = null,
         checked_out_at = now(),
         status = 'checked_out'
   where id = p_pass_id and status in ('active', 'paused')
  returning * into v_pass;

  if not found then
    raise exception 'คนนี้เช็คเอาต์ไปแล้ว' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function move_visit_to_tables(p_visit_id uuid, p_table_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_id    uuid;
  v_old   uuid[];
begin
  perform assert_staff();

  if coalesce(array_length(p_table_ids, 1), 0) = 0 then
    raise exception 'ต้องเลือกอย่างน้อย 1 โต๊ะ' using errcode = '22023';
  end if;

  -- จำโต๊ะเดิมไว้ก่อนปิด occupancy ไม่งั้นหาย้อนกลับไม่เจอ
  select coalesce(array_agg(table_id), '{}') into v_old
    from occupancies where visit_id = p_visit_id and to_at is null;

  -- ปิด occupancy เดิม แล้วเปิดใหม่ — ประวัติยังอยู่ครบ บิลไม่กระทบ
  update occupancies set to_at = now()
   where visit_id = p_visit_id and to_at is null;

  update cafe_tables set status = 'cleaning' where id = any(v_old);

  foreach v_id in array p_table_ids loop
    select * into v_table from cafe_tables where id = v_id for update;
    if not found then
      raise exception 'ไม่พบโต๊ะ %', v_id using errcode = 'P0002';
    end if;

    insert into occupancies (visit_id, table_id, exclusive)
    values (p_visit_id, v_table.id, not v_table.allow_share);

    update cafe_tables set status = 'occupied' where id = v_table.id;
  end loop;
end;
$$;

-- -------------------------------------------------------------- ออเดอร์ ----

create function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb     -- [{"menuItemId": "...", "qty": 1, "note": "..."}]
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_item  jsonb;
  v_menu  menu_items;
  v_table uuid;
  v_qty   int;
begin
  perform assert_staff();

  -- retry จากมือถือที่เน็ตหลุด → คืนออเดอร์เดิม ไม่สร้างซ้ำ
  select * into v_order from orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if not exists (select 1 from visits where id = p_visit_id and status = 'open') then
    raise exception 'visit นี้ปิดแล้ว สั่งเพิ่มไม่ได้' using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ตะกร้าว่าง' using errcode = '22023';
  end if;

  if p_split_mode = 'owner' then
    if p_ordered_by_pass_id is null then
      raise exception 'ต้องระบุว่าใครสั่ง' using errcode = '22023';
    end if;
    -- คนที่กลับไปแล้วสั่งเพิ่มไม่ได้
    if not exists (
      select 1 from guest_passes
       where id = p_ordered_by_pass_id
         and visit_id = p_visit_id
         and status in ('active', 'paused')
    ) then
      raise exception 'ผู้สั่งไม่ได้อยู่ในกลุ่มนี้แล้ว' using errcode = '22023';
    end if;
  end if;

  select table_id into v_table
    from occupancies
   where visit_id = p_visit_id and to_at is null
   order by from_at
   limit 1;

  insert into orders (
    visit_id, ordered_by_pass_id, placed_by, split_mode,
    table_id_snapshot, idempotency_key
  ) values (
    p_visit_id,
    case when p_split_mode = 'shared' then null else p_ordered_by_pass_id end,
    p_placed_by, p_split_mode, v_table, p_idempotency_key
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_menu from menu_items where id = (v_item ->> 'menuItemId')::uuid;
    if not found then
      raise exception 'ไม่พบเมนู %', v_item ->> 'menuItemId' using errcode = 'P0002';
    end if;
    if not v_menu.available then
      raise exception '% หมดแล้ว', v_menu.name using errcode = '22023';
    end if;

    v_qty := coalesce((v_item ->> 'qty')::int, 0);
    if v_qty <= 0 then
      raise exception 'จำนวนต้องมากกว่า 0' using errcode = '22023';
    end if;

    -- ราคามาจาก DB เสมอ ไม่รับจาก client
    insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty, note)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, nullif(v_item ->> 'note', ''));
  end loop;

  return v_order;
end;
$$;

create function update_order_status(p_order_id uuid, p_status order_status)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_from  order_status;
  v_ok    boolean;
begin
  perform assert_staff();

  select status into v_from from orders where id = p_order_id for update;
  if not found then
    raise exception 'ไม่พบออเดอร์ %', p_order_id using errcode = 'P0002';
  end if;

  v_ok := case v_from
    when 'placed'    then p_status in ('accepted', 'rejected', 'cancelled')
    when 'accepted'  then p_status in ('preparing', 'cancelled')
    when 'preparing' then p_status = 'ready'
    when 'ready'     then p_status = 'served'
    else false
  end;

  if not v_ok then
    raise exception 'เปลี่ยนสถานะจาก % เป็น % ไม่ได้', v_from, p_status using errcode = '22023';
  end if;

  update orders set status = p_status where id = p_order_id returning * into v_order;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------- ปิดบิล ----

-- แช่แข็งยอดจาก preview_bill ลงตาราง bills/bill_lines แล้วปิด visit
-- หลังจากนี้ราคาเมนูหรือเรตจะเปลี่ยนยังไงก็ไม่กระทบใบเสร็จนี้อีก
create function close_visit(p_visit_id uuid, p_payments jsonb default '[]'::jsonb)
returns bills
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit   visits;
  v_preview jsonb;
  v_bill    bills;
  v_line    jsonb;
  v_pay     jsonb;
  v_paid    numeric(10,2);
begin
  perform assert_staff();

  select * into v_visit from visits where id = p_visit_id for update;
  if not found then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  v_preview := preview_bill(p_visit_id);

  insert into bills (visit_id, subtotal, service_charge, vat, total, closed_by)
  values (
    p_visit_id,
    (v_preview ->> 'subtotal')::numeric,
    (v_preview ->> 'serviceCharge')::numeric,
    (v_preview ->> 'vat')::numeric,
    (v_preview ->> 'total')::numeric,
    auth.uid()
  ) returning * into v_bill;

  for v_line in select * from jsonb_array_elements(v_preview -> 'lines') loop
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id,
      (v_line ->> 'source')::bill_line_source,
      (v_line ->> 'sourceId')::uuid,
      (v_line ->> 'guestPassId')::uuid,
      v_line ->> 'label',
      (v_line ->> 'qty')::numeric,
      (v_line ->> 'unitPrice')::numeric,
      (v_line ->> 'amount')::numeric
    );
  end loop;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into payments (bill_id, method, amount, paid_for, taken_by)
    values (
      v_bill.id,
      v_pay ->> 'method',
      (v_pay ->> 'amount')::numeric,
      coalesce(
        (select array_agg(value::uuid) from jsonb_array_elements_text(v_pay -> 'paidFor')),
        '{}'
      ),
      auth.uid()
    );
  end loop;

  select coalesce(sum(amount), 0) into v_paid from payments where bill_id = v_bill.id;
  if v_paid >= v_bill.total then
    update bills set status = 'paid' where id = v_bill.id returning * into v_bill;
  end if;

  -- ปิดผู้เล่นที่ยังค้างอยู่
  update guest_passes
     set checked_out_at = coalesce(checked_out_at, now()),
         paused_at = null,
         status = 'billed'
   where visit_id = p_visit_id;

  -- คืนโต๊ะเข้าสถานะรอเก็บ
  update cafe_tables set status = 'cleaning'
   where id in (select table_id from occupancies where visit_id = p_visit_id and to_at is null);

  update occupancies set to_at = now()
   where visit_id = p_visit_id and to_at is null;

  update visits
     set status = case when v_paid >= v_bill.total
                       then 'paid'::visit_status
                       else 'closed'::visit_status end,
         closed_at = now()
   where id = p_visit_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'close_visit', 'visit', p_visit_id,
          jsonb_build_object('billId', v_bill.id, 'total', v_bill.total, 'paid', v_paid));

  return v_bill;
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930000400_rls.sql
-- ####################################################################

-- ============================================================================
-- Row Level Security
--
-- ข้อเท็จจริงที่ทุก policy ตั้งอยู่บนนั้น:
--   เว็บเป็น static บน GitHub Pages → anon key เปิดเผยต่อสาธารณะ
--   ใครก็ยิง PostgREST ตรงได้ → RLS คือด่านเดียวที่กั้นอยู่
--
-- กติกา:
--   - ไม่มีตารางไหนเปิด INSERT / UPDATE / DELETE ให้ client เลย แม้แต่พนักงาน
--     การเขียนทุกอย่างผ่าน RPC (SECURITY DEFINER) ที่ตรวจกติกาธุรกิจเอง
--   - พนักงานที่ล็อกอินแล้วอ่านข้อมูลปฏิบัติการได้ทั้งหมด
--   - anon อ่านได้เฉพาะข้อมูลที่ติดหน้าร้านอยู่แล้ว (เมนู, คลังเกม, ผังโต๊ะ)
-- ============================================================================

-- ---------------------------------------------------------------- GRANT ----
-- Supabase ตั้ง default privileges ให้ตารางใหม่ทุกตารางได้สิทธิ์ ALL กับ
-- anon/authenticated อัตโนมัติ ถ้าไม่เพิกถอนก่อน การบอกว่า "ไม่เปิดให้เขียนตรง"
-- จะไม่เป็นจริง — RLS คุมได้แค่ "แถวไหน" ไม่ได้คุมว่า "ทำอะไรได้บ้าง"

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- อ่านอย่างเดียว ไม่มี INSERT/UPDATE/DELETE ให้ใครทั้งสิ้น
grant select on menu_items, game_titles, rate_plans, cafe_tables, tax_config
  to anon, authenticated;

grant select on visits, occupancies, guest_passes, orders, order_lines,
                game_loans, reservations, bills, bill_lines, payments,
                staff, audit_log
  to authenticated;

alter table staff         enable row level security;
alter table rate_plans    enable row level security;
alter table menu_items    enable row level security;
alter table cafe_tables   enable row level security;
alter table visits        enable row level security;
alter table occupancies   enable row level security;
alter table guest_passes  enable row level security;
alter table orders        enable row level security;
alter table order_lines   enable row level security;
alter table game_titles   enable row level security;
alter table game_loans    enable row level security;
alter table reservations  enable row level security;
alter table bills         enable row level security;
alter table bill_lines    enable row level security;
alter table payments      enable row level security;
alter table tax_config    enable row level security;
alter table audit_log     enable row level security;

-- ---------------------------------------------------- อ่านได้โดยไม่ล็อกอิน ----
-- ข้อมูลที่ติดอยู่บนกระดานหน้าร้านอยู่แล้ว ไม่มีอะไรต้องปิด

create policy public_read_menu on menu_items
  for select to anon, authenticated using (true);

create policy public_read_games on game_titles
  for select to anon, authenticated using (true);

create policy public_read_rate_plans on rate_plans
  for select to anon, authenticated using (active);

-- ผังโต๊ะ: บอกได้แค่ว่าโต๊ะไหนว่าง ไม่บอกว่าใครนั่ง
create policy public_read_tables on cafe_tables
  for select to anon, authenticated using (true);

create policy public_read_tax on tax_config
  for select to anon, authenticated using (true);

-- ------------------------------------------- ข้อมูลปฏิบัติการ เฉพาะพนักงาน ----

create policy staff_read_visits       on visits       for select to authenticated using (is_staff());
create policy staff_read_occupancies  on occupancies  for select to authenticated using (is_staff());
create policy staff_read_passes       on guest_passes for select to authenticated using (is_staff());
create policy staff_read_orders       on orders       for select to authenticated using (is_staff());
create policy staff_read_order_lines  on order_lines  for select to authenticated using (is_staff());
create policy staff_read_loans        on game_loans   for select to authenticated using (is_staff());
create policy staff_read_reservations on reservations for select to authenticated using (is_staff());

-- ------------------------------------------------------- เงิน: อ่านอย่างเดียว ----
-- ไม่มี policy INSERT/UPDATE เลยแม้แต่ของพนักงาน — เขียนได้ทางเดียวคือผ่าน
-- close_visit() ซึ่งเป็น SECURITY DEFINER และเขียน audit_log ทุกครั้ง

create policy staff_read_bills      on bills      for select to authenticated using (is_staff());
create policy staff_read_bill_lines on bill_lines for select to authenticated using (is_staff());
create policy staff_read_payments   on payments   for select to authenticated using (is_staff());

-- ------------------------------------------------------------------ staff ----

-- พนักงานเห็นโปรไฟล์ตัวเองได้เสมอ (ใช้เช็คว่าล็อกอินแล้วเป็นพนักงานจริงไหม)
create policy staff_read_self on staff
  for select to authenticated using (user_id = auth.uid());

create policy manager_read_staff on staff
  for select to authenticated using (
    exists (
      select 1 from staff s
      where s.user_id = auth.uid() and s.active and s.role in ('manager', 'owner')
    )
  );

-- audit_log: อ่านได้เฉพาะระดับจัดการ และไม่มีใครลบได้
create policy manager_read_audit on audit_log
  for select to authenticated using (
    exists (
      select 1 from staff s
      where s.user_id = auth.uid() and s.active and s.role in ('manager', 'owner')
    )
  );

-- ----------------------------------------------------------- สิทธิ์เรียก RPC ----

-- เพิกถอน EXECUTE ทั้งหมดไปแล้วข้างบน ที่นี่คืนให้เฉพาะที่ตั้งใจ

-- อ่านอย่างเดียว ไม่เปลี่ยนข้อมูล
grant execute on function preview_bill(uuid, timestamptz) to anon, authenticated;
grant execute on function is_staff() to authenticated;

-- ฟังก์ชันที่เปลี่ยนข้อมูล ให้เฉพาะคนที่ล็อกอิน
-- (ข้างในยังเรียก assert_staff() ซ้ำอีกชั้น — ล็อกอินเฉย ๆ ไม่พอ ต้องเป็นพนักงาน)
grant execute on function open_visit(uuid[], jsonb, visit_source)   to authenticated;
grant execute on function add_pass(uuid, text, uuid)                to authenticated;
grant execute on function pause_pass(uuid)                          to authenticated;
grant execute on function resume_pass(uuid)                         to authenticated;
grant execute on function check_out_pass(uuid)                      to authenticated;
grant execute on function move_visit_to_tables(uuid, uuid[])        to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb) to authenticated;
grant execute on function update_order_status(uuid, order_status)   to authenticated;
grant execute on function close_visit(uuid, jsonb)                  to authenticated;

-- ----------------------------------------------------------------- Realtime ----
-- จอครัวและผังโต๊ะต้องอัปเดตเอง ไม่ต้องกด refresh
-- Realtime เคารพ RLS อยู่แล้ว → anon จะไม่ได้รับ event ของตารางที่อ่านไม่ได้

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      visits, occupancies, guest_passes, orders, order_lines, cafe_tables, reservations;
  end if;
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930000500_guest_ordering.sql
-- ####################################################################

-- ============================================================================
-- ลูกค้าสั่งเองผ่าน QR ที่โต๊ะ
--
-- ปัญหา: ลูกค้าไม่ได้ล็อกอิน แต่ต้องสั่งของเข้าครัวได้ และต้องไม่เห็นข้อมูล
--        ของโต๊ะอื่นเลย
--
-- วิธี: QR ของแต่ละโต๊ะพก token ติดตัว (capability URL)
--       ทุก RPC ฝั่งลูกค้ารับ token แทนการล็อกอิน แล้วแปลง token → โต๊ะ → visit
--       ที่เปิดอยู่ ลูกค้าไม่เคยส่ง visit_id หรือ table_id มาเอง จึงอ้างถึง
--       โต๊ะอื่นไม่ได้
--
-- token ใช้ได้เฉพาะตอนที่โต๊ะนั้นมี visit เปิดอยู่จริง
-- พอปิดบิล QR เดิมก็ใช้สั่งอะไรไม่ได้อีกจนกว่าจะมีลูกค้าใหม่นั่ง
-- ============================================================================

alter table cafe_tables add column qr_token uuid not null default gen_random_uuid();
create unique index cafe_tables_qr_token_idx on cafe_tables (qr_token);

-- token ไม่ใช่ข้อมูลสาธารณะ — ใครได้ไปก็สั่งของลงโต๊ะนั้นได้
-- ก่อนหน้านี้ anon อ่าน cafe_tables ได้ทั้งแถว ถ้าปล่อยไว้ qr_token จะหลุด
-- ทันทีที่คนนอกเปิดผังโต๊ะ จึงตัดสิทธิ์อ่านตารางตรง แล้วเปิดเป็น view
-- ที่ไม่มีคอลัมน์ token แทน
drop policy public_read_tables on cafe_tables;
revoke select on cafe_tables from anon;

-- ไม่ใส่ security_invoker → view รันด้วยสิทธิ์เจ้าของ (พฤติกรรมปริยายของ Postgres)
-- ซึ่งจำเป็น เพราะ anon อ่านตารางต้นทางไม่ได้แล้ว
create view public_tables as
  select id, code, zone, seat_min, seat_max, allow_share, status, sort_order
    from cafe_tables;

grant select on public_tables to anon, authenticated;

-- พนักงานยังต้องอ่านตารางเต็ม (ต้องใช้ qr_token ไปสร้าง QR)
create policy staff_read_tables on cafe_tables
  for select to authenticated using (is_staff());

-- ปิดช่องที่เปิดไว้รอบก่อน: anon เรียก preview_bill ด้วย visit_id ของใครก็ได้
-- ต่อไปลูกค้าดูบิลได้ทางเดียวคือผ่าน guest_bill() ซึ่งต้องมี token ของโต๊ะตัวเอง
revoke execute on function preview_bill(uuid, timestamptz) from anon;

-- ---------------------------------------------------------------------------
-- แปลง token เป็น visit ที่เปิดอยู่ของโต๊ะนั้น
-- คืน null ถ้าโต๊ะยังไม่ได้เปิด (ลูกค้าต้องไปหาพนักงานก่อน)
-- ---------------------------------------------------------------------------
create function visit_for_token(p_token uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id
    from cafe_tables t
    join occupancies o on o.table_id = t.id and o.to_at is null
    join visits v on v.id = o.visit_id and v.status = 'open'
   where t.qr_token = p_token
   order by o.from_at desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- ข้อมูลที่ลูกค้าเห็นหลังสแกน QR
-- จงใจคืนเฉพาะสิ่งที่จำเป็น: โต๊ะไหน มีใครนั่งอยู่บ้าง (ชื่อเล่น) และเมนู
-- ไม่มียอดเงิน ไม่มีข้อมูลโต๊ะอื่น
-- ---------------------------------------------------------------------------
create function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token;
  if not found then
    raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
  end if;

  v_visit := visit_for_token(p_token);

  return jsonb_build_object(
    'tableCode', v_table.code,
    'zone',      v_table.zone,
    'visitId',   v_visit,
    'passes', coalesce((
      select jsonb_agg(jsonb_build_object('id', gp.id, 'displayName', gp.display_name)
                       order by gp.checked_in_at)
        from guest_passes gp
       where gp.visit_id = v_visit
         and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price, 'available', m.available)
             order by m.sort_order)
        from menu_items m
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- แกนกลางของการสั่งของ — ไม่ตรวจสิทธิ์เอง
-- ให้ place_order (พนักงาน) กับ guest_place_order (ลูกค้า) เรียกร่วมกัน
-- เพื่อไม่ให้กติกาแตกเป็นสองชุดแล้วเพี้ยนจากกันภายหลัง
-- ---------------------------------------------------------------------------
create function place_order_core(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_item  jsonb;
  v_menu  menu_items;
  v_table uuid;
  v_qty   int;
begin
  select * into v_order from orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if not exists (select 1 from visits where id = p_visit_id and status = 'open') then
    raise exception 'visit นี้ปิดแล้ว สั่งเพิ่มไม่ได้' using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ตะกร้าว่าง' using errcode = '22023';
  end if;

  if p_split_mode = 'owner' then
    if p_ordered_by_pass_id is null then
      raise exception 'ต้องระบุว่าใครสั่ง' using errcode = '22023';
    end if;
    if not exists (
      select 1 from guest_passes
       where id = p_ordered_by_pass_id
         and visit_id = p_visit_id
         and status in ('active', 'paused')
    ) then
      raise exception 'ผู้สั่งไม่ได้อยู่ในกลุ่มนี้แล้ว' using errcode = '22023';
    end if;
  end if;

  select table_id into v_table
    from occupancies
   where visit_id = p_visit_id and to_at is null
   order by from_at
   limit 1;

  insert into orders (
    visit_id, ordered_by_pass_id, placed_by, split_mode,
    table_id_snapshot, idempotency_key
  ) values (
    p_visit_id,
    case when p_split_mode = 'shared' then null else p_ordered_by_pass_id end,
    p_placed_by, p_split_mode, v_table, p_idempotency_key
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_menu from menu_items where id = (v_item ->> 'menuItemId')::uuid;
    if not found then
      raise exception 'ไม่พบเมนู %', v_item ->> 'menuItemId' using errcode = 'P0002';
    end if;
    if not v_menu.available then
      raise exception '% หมดแล้ว', v_menu.name using errcode = '22023';
    end if;

    v_qty := coalesce((v_item ->> 'qty')::int, 0);
    if v_qty <= 0 then
      raise exception 'จำนวนต้องมากกว่า 0' using errcode = '22023';
    end if;

    -- ราคามาจาก DB เสมอ ไม่ว่าใครเป็นคนสั่ง
    insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty, note)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, nullif(v_item ->> 'note', ''));
  end loop;

  return v_order;
end;
$$;

-- พนักงานสั่งแทนลูกค้า — เหลือแค่ตรวจสิทธิ์แล้วส่งต่อ
create or replace function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_staff();
  return place_order_core(
    p_idempotency_key, p_visit_id, p_ordered_by_pass_id,
    p_split_mode, p_placed_by, p_items
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าสั่งเอง — เข้าครัวทันที ไม่ต้องรอพนักงานอนุมัติ
-- ลูกค้าส่งมาแค่ token กับ pass ของตัวเอง visit_id มาจากฝั่งเซิร์ฟเวอร์เท่านั้น
-- ---------------------------------------------------------------------------
create function guest_place_order(
  p_token              uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_items              jsonb,
  p_idempotency_key    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_order orders;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_order := place_order_core(
    p_idempotency_key, v_visit, p_ordered_by_pass_id,
    p_split_mode, 'guest', p_items
  );

  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าดูออเดอร์ของโต๊ะตัวเอง (ติดตามสถานะ) และยอดปัจจุบัน
-- ---------------------------------------------------------------------------
create function guest_orders(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_visit uuid;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', o.id,
             'status', o.status,
             'placedAt', o.placed_at,
             'orderedByPassId', o.ordered_by_pass_id,
             'splitMode', o.split_mode,
             'lines', (
               select jsonb_agg(jsonb_build_object(
                        'id', ol.id, 'name', ol.name_snapshot,
                        'qty', ol.qty, 'amount', round(ol.unit_price_snapshot * ol.qty, 2)))
                 from order_lines ol where ol.order_id = o.id
             )
           ) order by o.placed_at desc)
      from orders o where o.visit_id = v_visit
  ), '[]'::jsonb);
end;
$$;

create function guest_bill(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_visit uuid;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด' using errcode = '22023';
  end if;
  return preview_bill(v_visit);
end;
$$;

-- ---------------------------------------------------------------------------
-- เปลี่ยน token ของโต๊ะ — ใช้เมื่อสงสัยว่า QR หลุดออกนอกร้าน
-- QR ใบเดิมใช้ไม่ได้ทันที ต้องพิมพ์ใหม่
-- ---------------------------------------------------------------------------
create function rotate_table_token(p_table_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid;
begin
  perform assert_staff();
  update cafe_tables set qr_token = gen_random_uuid()
   where id = p_table_id
  returning qr_token into v_token;

  if not found then
    raise exception 'ไม่พบโต๊ะ %', p_table_id using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id)
  values (auth.uid(), 'rotate_table_token', 'cafe_table', p_table_id);

  return v_token;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

grant execute on function guest_session(uuid)                                   to anon, authenticated;
grant execute on function guest_orders(uuid)                                    to anon, authenticated;
grant execute on function guest_bill(uuid)                                      to anon, authenticated;
grant execute on function guest_place_order(uuid, uuid, split_mode, jsonb, text) to anon, authenticated;

grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb) to authenticated;
grant execute on function rotate_table_token(uuid) to authenticated;

-- แกนกลางเรียกตรงไม่ได้ ต้องผ่าน place_order หรือ guest_place_order เท่านั้น
revoke execute on function place_order_core(text, uuid, uuid, split_mode, placed_by_actor, jsonb)
  from anon, authenticated, public;
revoke execute on function visit_for_token(uuid) from anon, authenticated, public;

-- ####################################################################
-- # supabase/migrations/20260930000600_harden_execute.sql
-- ####################################################################

-- ============================================================================
-- อุดช่อง: EXECUTE ถูกให้กับ PUBLIC โดยปริยาย
--
-- Postgres ให้สิทธิ์ EXECUTE ของฟังก์ชันใหม่กับ PUBLIC เสมอ
-- การ revoke จาก anon/authenticated อย่างเดียวจึงไม่มีผลใด ๆ — สิทธิ์ยังมาทาง
-- PUBLIC อยู่ดี ผลคือก่อนไฟล์นี้ ใครก็เรียก RPC ทุกตัวได้
--
-- ที่ยังไม่เกิดความเสียหายเพราะ assert_staff() ข้างในปฏิเสธไว้อีกชั้น
-- แต่ preview_bill ไม่มีชั้นนั้น → คนนอกที่รู้ visit id จึงเปิดดูบิลคนอื่นได้
--
-- ไฟล์นี้ตัดสิทธิ์จาก PUBLIC ให้หมดก่อน แล้วคืนเฉพาะที่ตั้งใจ
-- เป็นรายการสิทธิ์ที่เชื่อถือได้เพียงชุดเดียว ทับของเดิมทั้งหมด
-- ============================================================================

revoke all on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------- ลูกค้าที่ไม่ล็อกอิน ----
-- เข้าถึงได้ทางเดียวคือถือ QR token ของโต๊ะตัวเอง
-- ทุกตัวแปลง token → visit เองฝั่งเซิร์ฟเวอร์ ลูกค้าระบุโต๊ะอื่นไม่ได้

grant execute on function guest_session(uuid)                                    to anon, authenticated;
grant execute on function guest_orders(uuid)                                     to anon, authenticated;
grant execute on function guest_bill(uuid)                                       to anon, authenticated;
grant execute on function guest_place_order(uuid, uuid, split_mode, jsonb, text)  to anon, authenticated;

-- ------------------------------------------------------------- พนักงาน ----
-- ยังเรียก assert_staff() ข้างในอีกชั้น — ล็อกอินเฉย ๆ ไม่พอ

grant execute on function is_staff()                                  to authenticated;
grant execute on function preview_bill(uuid, timestamptz)             to authenticated;
grant execute on function open_visit(uuid[], jsonb, visit_source)     to authenticated;
grant execute on function add_pass(uuid, text, uuid)                  to authenticated;
grant execute on function pause_pass(uuid)                            to authenticated;
grant execute on function resume_pass(uuid)                           to authenticated;
grant execute on function check_out_pass(uuid)                        to authenticated;
grant execute on function move_visit_to_tables(uuid, uuid[])          to authenticated;
grant execute on function update_order_status(uuid, order_status)     to authenticated;
grant execute on function close_visit(uuid, jsonb)                    to authenticated;
grant execute on function rotate_table_token(uuid)                    to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb)
  to authenticated;

-- ----------------------------------------------------- ไม่ให้ใครเรียกตรง ----
-- ฟังก์ชันภายใน เรียกได้เฉพาะจากฟังก์ชันอื่นที่ตรวจสิทธิ์แล้ว
--   place_order_core  — ไม่ตรวจสิทธิ์เลย ถ้าเรียกตรงได้คือสั่งของลงโต๊ะใครก็ได้
--   visit_for_token   — แปลง token เป็น visit id
--   assert_staff      — ไม่มีประโยชน์กับ client
--   billable_minutes / play_time_charge — ฟังก์ชันคำนวณภายใน
-- (ไม่ต้อง revoke ซ้ำ เพราะบรรทัดบนสุดตัดไปหมดแล้ว และไม่ได้ grant คืนที่นี่)

-- ตารางที่ Supabase สร้างใหม่ในอนาคตต้องไม่ได้สิทธิ์อัตโนมัติอีก
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- ####################################################################
-- # supabase/seed.sql
-- ####################################################################

-- ข้อมูลตั้งต้นของร้าน — แก้ให้ตรงร้านจริงแล้วรันซ้ำได้ (idempotent)

insert into rate_plans (id, name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap, sort_order) values
  ('11111111-0000-4000-8000-000000000001', 'ทั่วไป',              60, 30, 60, 199, 1),
  ('11111111-0000-4000-8000-000000000002', 'สมาชิก',              48, 30, 60, 159, 2),
  ('11111111-0000-4000-8000-000000000003', 'นักเรียน/นักศึกษา',    40, 30, 60, 129, 3),
  ('11111111-0000-4000-8000-000000000004', 'แวะทักทาย (ไม่คิดเงิน)', 0, 30,  0,   0, 4)
on conflict (id) do nothing;

insert into cafe_tables (code, zone, seat_min, seat_max, allow_share, sort_order) values
  ('A1',  'โซนเงียบ',   2,  4, false, 1),
  ('A2',  'โซนเงียบ',   2,  4, false, 2),
  ('A3',  'โซนเงียบ',   2,  4, false, 3),
  ('B1',  'โซนกลาง',    4,  6, false, 4),
  ('B2',  'โซนกลาง',    4,  6, false, 5),
  ('B3',  'โซนกลาง',    4,  6, false, 6),
  ('C1',  'โต๊ะยาว',    6, 10, true,  7),
  ('BAR', 'เคาน์เตอร์', 1,  6, true,  8)
on conflict (code) do nothing;

insert into menu_items (sku, name, category, price, available, sort_order) values
  ('D01', 'อเมริกาโน่เย็น',        'drink',   65, true,  1),
  ('D02', 'ลาเต้ร้อน',             'drink',   70, true,  2),
  ('D03', 'ชาเขียวมัทฉะ',          'drink',   75, true,  3),
  ('D04', 'โซดามะนาว',             'drink',   55, true,  4),
  ('S01', 'เฟรนช์ฟรายส์',          'snack',   89, true,  5),
  ('S02', 'ป๊อปคอร์นคาราเมล',      'snack',   59, true,  6),
  ('S03', 'นักเก็ตไก่',             'snack',   95, false, 7),
  ('F01', 'สปาเก็ตตี้คาโบนาร่า',    'food',   149, true,  8),
  ('F02', 'ข้าวผัดกะเพราหมูกรอบ',  'food',   129, true,  9),
  ('K01', 'บราวนี่อุ่นไอศกรีม',     'dessert', 99, true, 10)
on conflict (sku) do nothing;

insert into game_titles (name, min_players, max_players, play_minutes, weight, copies) values
  ('Wingspan',           1, 5,  70, 3, 2),
  ('Codenames',          4, 8,  20, 1, 3),
  ('Terraforming Mars',  1, 5, 120, 5, 1),
  ('Splendor',           2, 4,  30, 2, 2),
  ('Everdell',           1, 4,  80, 4, 1),
  ('The Crew',           3, 5,  20, 2, 2)
on conflict do nothing;
