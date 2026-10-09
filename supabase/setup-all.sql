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
-- # supabase/migrations/20260930000700_reservations.sql
-- ####################################################################

-- ============================================================================
-- จองโต๊ะออนไลน์
--
-- กติกาที่ตกลงไว้:
--   - ลูกค้าจองแล้วได้สถานะ "รอยืนยัน" พนักงานกดยืนยันอีกที
--   - ลูกค้าเลือกโต๊ะเองจากผัง (เห็นว่าโต๊ะไหนว่างในช่วงเวลาที่เลือก)
--   - ไม่มี OTP — ลูกค้าได้ "รหัสจอง" ไว้เปิดดูและยกเลิกเอง
--   - ร้านเปิด 11:00–23:00 ทุกวัน (แก้ได้ในตาราง shop_hours)
--
-- ความปลอดภัย: ลูกค้าไม่ได้ล็อกอิน จึงอ่านตาราง reservations ตรงไม่ได้เลย
--   ต้องมีทั้งรหัสจองและเบอร์โทรจึงจะเปิดดูรายการของตัวเองได้
--   (รหัสอย่างเดียวไม่พอ กันคนสุ่มรหัสแล้วไล่ดูข้อมูลคนอื่น)
-- ============================================================================

-- ------------------------------------------------------------ เวลาทำการ ----

create table shop_hours (
  weekday    smallint primary key check (weekday between 0 and 6),  -- 0 = อาทิตย์
  open_time  time not null,
  close_time time not null,
  closed     boolean not null default false
);

insert into shop_hours (weekday, open_time, close_time)
select g, '11:00', '23:00' from generate_series(0, 6) g;

create table reservation_config (
  id                       int primary key default 1 check (id = 1),
  -- ลูกค้าเลือกเวลาได้ทีละกี่นาที
  slot_minutes             int not null default 30,
  default_duration_minutes int not null default 120,
  min_duration_minutes     int not null default 60,
  max_duration_minutes     int not null default 300,
  -- เลยเวลานัดเท่านี้แล้วยังไม่มา ถือว่าไม่มา แล้วปล่อยโต๊ะ
  grace_minutes            int not null default 20,
  -- เผื่อเวลาเก็บโต๊ะระหว่างรอบ
  buffer_minutes           int not null default 15,
  -- จองล่วงหน้าได้ไม่เกินกี่วัน
  max_advance_days         int not null default 30,
  -- ต้องจองล่วงหน้าอย่างน้อยกี่นาที (กันจองตอนยืนอยู่หน้าร้าน)
  min_advance_minutes      int not null default 30,
  -- โต๊ะที่มีลูกค้านั่งอยู่ ไม่รับจองในช่วงกี่นาทีข้างหน้า
  occupied_hold_minutes    int not null default 90,
  -- กันจองมั่ว: เบอร์เดียวจองค้างได้กี่รายการ
  max_pending_per_phone    int not null default 3
);

insert into reservation_config (id) values (1);

-- --------------------------------------------------------- reservations ----

alter table reservations
  add column code         text unique,
  -- เก็บเป็นคอลัมน์จริงแล้วให้ trigger ดูแล ใช้ generated column ไม่ได้
  -- เพราะ timestamptz + interval เป็น STABLE ไม่ใช่ IMMUTABLE (เรื่อง DST)
  add column end_at       timestamptz,
  add column source       text not null default 'staff'
                          check (source in ('staff', 'online')),
  add column confirmed_at timestamptz,
  add column closed_at    timestamptz,
  add column staff_note   text;

create function reservations_set_end_at() returns trigger
language plpgsql as $$
begin
  new.end_at := new.start_at + make_interval(mins => new.duration_minutes);
  return new;
end;
$$;

create trigger reservations_end_at
  before insert or update of start_at, duration_minutes on reservations
  for each row execute function reservations_set_end_at();

-- เติมให้แถวที่มีอยู่ก่อนหน้า
update reservations set start_at = start_at;

create index reservations_window_idx on reservations (start_at, end_at)
  where status in ('pending', 'confirmed', 'seated');

create index reservations_tables_idx on reservations using gin (table_ids);

-- รหัสจอง: อ่านง่าย พูดทางโทรศัพท์ได้ ไม่มีตัวที่สับสน (0/O, 1/I)
create function new_reservation_code() returns text
language plpgsql volatile as $$
declare
  v_chars constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code  text;
  v_i     int;
begin
  loop
    v_code := '';
    for v_i in 1..6 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from reservations where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- โต๊ะว่างในช่วงเวลาที่ขอหรือเปล่า
--
-- ติด 2 กรณี:
--   1. มีการจองอื่นคาบเกี่ยว (เผื่อ buffer เก็บโต๊ะหัวท้าย)
--   2. ตอนนี้มีลูกค้านั่งอยู่ และเวลาที่ขอใกล้เกินกว่าจะรับปากได้
--      (จองไกลกว่านั้นได้ เพราะกลุ่มปัจจุบันน่าจะกลับก่อน)
-- โต๊ะที่นั่งร่วมกันได้ (allow_share) ไม่ติดทั้งสองกรณี
-- ---------------------------------------------------------------------------
create function table_available(
  p_table_id uuid,
  p_start    timestamptz,
  p_end      timestamptz,
  p_exclude_reservation uuid default null
) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg   reservation_config;
  v_table cafe_tables;
begin
  select * into v_cfg from reservation_config where id = 1;
  select * into v_table from cafe_tables where id = p_table_id;
  if not found then return false; end if;

  if not v_table.allow_share and exists (
    select 1 from reservations r
     where r.status in ('pending', 'confirmed', 'seated')
       and p_table_id = any(r.table_ids)
       and (p_exclude_reservation is null or r.id <> p_exclude_reservation)
       -- คาบเกี่ยวกันเมื่อขยายช่วงของการจองเดิมออกหัวท้ายด้วย buffer
       and tstzrange(r.start_at - make_interval(mins => v_cfg.buffer_minutes),
                     r.end_at   + make_interval(mins => v_cfg.buffer_minutes))
           && tstzrange(p_start, p_end)
  ) then
    return false;
  end if;

  if not v_table.allow_share
     and p_start < now() + make_interval(mins => v_cfg.occupied_hold_minutes)
     and exists (
       select 1 from occupancies o
        where o.table_id = p_table_id and o.to_at is null
     ) then
    return false;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- ผังโต๊ะพร้อมสถานะว่าง/ไม่ว่าง สำหรับช่วงเวลาที่ลูกค้าเลือก
-- ลูกค้าเรียกได้โดยไม่ล็อกอิน — ไม่มี qr_token และไม่บอกว่าใครจอง
-- ---------------------------------------------------------------------------
create function available_tables(
  p_start    timestamptz,
  p_duration int default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg reservation_config;
  v_end timestamptz;
begin
  select * into v_cfg from reservation_config where id = 1;
  v_end := p_start + make_interval(mins => coalesce(p_duration, v_cfg.default_duration_minutes));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id,
             'code', t.code,
             'zone', t.zone,
             'seatMin', t.seat_min,
             'seatMax', t.seat_max,
             'allowShare', t.allow_share,
             'available', table_available(t.id, p_start, v_end)
           ) order by t.sort_order)
      from cafe_tables t
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- ตรวจว่าเวลาที่ขออยู่ในเวลาทำการและอยู่ในกรอบที่รับจอง
-- แยกออกมาเพื่อให้ทั้งฝั่งลูกค้าและพนักงานใช้กติกาชุดเดียวกัน
-- ---------------------------------------------------------------------------
create function assert_bookable(p_start timestamptz, p_duration int)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg    reservation_config;
  v_hours  shop_hours;
  v_local  timestamp;
  v_end    timestamp;
begin
  select * into v_cfg from reservation_config where id = 1;

  if p_duration < v_cfg.min_duration_minutes or p_duration > v_cfg.max_duration_minutes then
    raise exception 'จองได้ครั้งละ %–% นาที',
      v_cfg.min_duration_minutes, v_cfg.max_duration_minutes using errcode = '22023';
  end if;

  if p_start < now() + make_interval(mins => v_cfg.min_advance_minutes) then
    raise exception 'ต้องจองล่วงหน้าอย่างน้อย % นาที', v_cfg.min_advance_minutes
      using errcode = '22023';
  end if;

  if p_start > now() + make_interval(days => v_cfg.max_advance_days) then
    raise exception 'จองล่วงหน้าได้ไม่เกิน % วัน', v_cfg.max_advance_days
      using errcode = '22023';
  end if;

  -- เทียบกับเวลาทำการตามเวลาไทย ไม่ใช่ UTC
  v_local := p_start at time zone 'Asia/Bangkok';
  v_end   := v_local + make_interval(mins => p_duration);

  select * into v_hours from shop_hours where weekday = extract(dow from v_local)::smallint;
  if not found or v_hours.closed then
    raise exception 'วันนั้นร้านปิด' using errcode = '22023';
  end if;

  if v_local::time < v_hours.open_time then
    raise exception 'ร้านเปิด % น.', to_char(v_hours.open_time, 'HH24:MI') using errcode = '22023';
  end if;

  -- ต้องเล่นจบก่อนร้านปิด และห้ามข้ามวัน
  if v_end::date <> v_local::date or v_end::time > v_hours.close_time then
    raise exception 'ต้องจบก่อนร้านปิด % น.', to_char(v_hours.close_time, 'HH24:MI')
      using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าจองเอง — ได้สถานะ "รอยืนยัน" และรหัสจองกลับไป
-- ---------------------------------------------------------------------------
create function create_reservation(
  p_customer_name text,
  p_phone         text,
  p_party_size    int,
  p_start_at      timestamptz,
  p_duration      int,
  p_table_ids     uuid[],
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg   reservation_config;
  v_res   reservations;
  v_end   timestamptz;
  v_id    uuid;
  v_seats int;
  v_phone text;
begin
  select * into v_cfg from reservation_config where id = 1;

  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_phone) < 9 then
    raise exception 'เบอร์โทรไม่ถูกต้อง' using errcode = '22023';
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    raise exception 'กรุณาใส่ชื่อผู้จอง' using errcode = '22023';
  end if;
  if p_party_size < 1 then
    raise exception 'จำนวนคนไม่ถูกต้อง' using errcode = '22023';
  end if;
  if coalesce(array_length(p_table_ids, 1), 0) = 0 then
    raise exception 'กรุณาเลือกโต๊ะ' using errcode = '22023';
  end if;

  perform assert_bookable(p_start_at, p_duration);

  -- กันจองมั่ว: เบอร์เดียวค้างได้ไม่เกินที่ตั้งไว้
  if (select count(*) from reservations
       where regexp_replace(phone, '[^0-9]', '', 'g') = v_phone
         and status in ('pending', 'confirmed')) >= v_cfg.max_pending_per_phone then
    raise exception 'เบอร์นี้มีรายการจองค้างอยู่ % รายการแล้ว กรุณาติดต่อร้าน',
      v_cfg.max_pending_per_phone using errcode = '22023';
  end if;

  v_end := p_start_at + make_interval(mins => p_duration);

  v_seats := 0;
  foreach v_id in array p_table_ids loop
    if not table_available(v_id, p_start_at, v_end) then
      raise exception 'โต๊ะ % ไม่ว่างในช่วงเวลานี้แล้ว',
        (select code from cafe_tables where id = v_id) using errcode = '22023';
    end if;
    v_seats := v_seats + (select seat_max from cafe_tables where id = v_id);
  end loop;

  if p_party_size > v_seats then
    raise exception 'โต๊ะที่เลือกนั่งได้ % คน แต่จอง % คน', v_seats, p_party_size
      using errcode = '22023';
  end if;

  insert into reservations (
    code, customer_name, phone, party_size, start_at, duration_minutes,
    table_ids, status, source, note
  ) values (
    new_reservation_code(), trim(p_customer_name), p_phone, p_party_size,
    p_start_at, p_duration, p_table_ids, 'pending', 'online', nullif(trim(p_note), '')
  ) returning * into v_res;

  return jsonb_build_object(
    'code', v_res.code,
    'status', v_res.status,
    'startAt', v_res.start_at,
    'durationMinutes', v_res.duration_minutes,
    'tables', (select jsonb_agg(code order by code) from cafe_tables where id = any(v_res.table_ids))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าเปิดดูรายการของตัวเอง — ต้องมีทั้งรหัสจองและเบอร์โทร
-- รหัสอย่างเดียวไม่พอ กันคนสุ่มรหัสไล่ดูข้อมูลคนอื่น
-- ---------------------------------------------------------------------------
create function reservation_by_code(p_code text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  select * into v_res from reservations
   where upper(code) = upper(trim(p_code))
     and regexp_replace(phone, '[^0-9]', '', 'g')
         = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  if not found then
    raise exception 'ไม่พบรายการจอง ตรวจรหัสและเบอร์โทรอีกครั้ง' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'code', v_res.code,
    'customerName', v_res.customer_name,
    'partySize', v_res.party_size,
    'startAt', v_res.start_at,
    'durationMinutes', v_res.duration_minutes,
    'status', v_res.status,
    'note', v_res.note,
    'tables', coalesce((select jsonb_agg(code order by code)
                          from cafe_tables where id = any(v_res.table_ids)), '[]'::jsonb)
  );
end;
$$;

create function cancel_reservation_by_code(p_code text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  select * into v_res from reservations
   where upper(code) = upper(trim(p_code))
     and regexp_replace(phone, '[^0-9]', '', 'g')
         = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
   for update;

  if not found then
    raise exception 'ไม่พบรายการจอง' using errcode = 'P0002';
  end if;
  if v_res.status not in ('pending', 'confirmed') then
    raise exception 'รายการนี้ยกเลิกไม่ได้แล้ว' using errcode = '22023';
  end if;

  update reservations
     set status = 'cancelled', closed_at = now()
   where id = v_res.id;

  insert into audit_log (action, entity, entity_id, detail)
  values ('cancel_reservation', 'reservation', v_res.id,
          jsonb_build_object('by', 'guest', 'code', v_res.code));

  return jsonb_build_object('code', v_res.code, 'status', 'cancelled');
end;
$$;

-- --------------------------------------------------------------- พนักงาน ----

create function confirm_reservation(p_id uuid)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'confirmed', confirmed_at = now()
   where id = p_id and status = 'pending'
  returning * into v_res;

  if not found then
    raise exception 'ยืนยันได้เฉพาะรายการที่รอยืนยัน' using errcode = '22023';
  end if;
  return v_res;
end;
$$;

create function reject_reservation(p_id uuid, p_reason text default null)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'cancelled', closed_at = now(), staff_note = nullif(trim(p_reason), '')
   where id = p_id and status in ('pending', 'confirmed')
  returning * into v_res;

  if not found then
    raise exception 'รายการนี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'reject_reservation', 'reservation', p_id,
          jsonb_build_object('reason', p_reason));
  return v_res;
end;
$$;

create function mark_no_show(p_id uuid)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'no_show', closed_at = now()
   where id = p_id and status in ('pending', 'confirmed')
  returning * into v_res;

  if not found then
    raise exception 'รายการนี้ปิดไปแล้ว' using errcode = '22023';
  end if;
  return v_res;
end;
$$;

-- เช็คอินลูกค้าที่จองไว้ → เปิด visit จากโต๊ะที่จองไว้
--
-- p_table_ids: ใส่มาเพื่อย้ายไปโต๊ะอื่นตอนเช็คอิน เช่นกลุ่มก่อนหน้านั่งเลยเวลา
-- หรือลูกค้ามาไม่ครบ ไม่ใส่ = ใช้โต๊ะที่จองไว้
create function seat_reservation(
  p_id        uuid,
  p_guests    jsonb,
  p_table_ids uuid[] default null
) returns visits
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res    reservations;
  v_visit  visits;
  v_tables uuid[];
  v_busy   text;
begin
  perform assert_staff();

  select * into v_res from reservations where id = p_id for update;
  if not found then
    raise exception 'ไม่พบรายการจอง' using errcode = 'P0002';
  end if;
  if v_res.status not in ('pending', 'confirmed') then
    raise exception 'รายการนี้เช็คอินไม่ได้แล้ว' using errcode = '22023';
  end if;

  v_tables := coalesce(p_table_ids, v_res.table_ids);

  -- โต๊ะที่จองไว้อาจยังมีกลุ่มก่อนหน้านั่งอยู่ (นั่งเลยเวลา)
  -- บอกให้ชัดว่าโต๊ะไหนติด ดีกว่าปล่อยให้ชน constraint แล้วขึ้น error ที่อ่านไม่รู้เรื่อง
  select string_agg(t.code, ', ' order by t.code) into v_busy
    from cafe_tables t
    join occupancies o on o.table_id = t.id and o.to_at is null
   where t.id = any(v_tables) and not t.allow_share;

  if v_busy is not null then
    raise exception 'โต๊ะ % ยังมีลูกค้าอยู่ ปิดบิลโต๊ะเดิมก่อน หรือเลือกโต๊ะอื่นให้', v_busy
      using errcode = '22023';
  end if;

  v_visit := open_visit(v_tables, p_guests, 'reservation');

  update reservations
     set status = 'seated', visit_id = v_visit.id, closed_at = now(),
         -- บันทึกโต๊ะที่นั่งจริง ไม่ใช่โต๊ะที่จองไว้ตอนแรก
         table_ids = v_tables
   where id = p_id;

  return v_visit;
end;
$$;

-- ---------------------------------------------------------------------------
-- ปล่อยโต๊ะของคนที่เลยเวลานัดแล้วยังไม่มา
-- ตั้งให้ pg_cron เรียกทุก 5 นาที (ดูท้ายไฟล์)
-- ---------------------------------------------------------------------------
create function release_overdue_reservations()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg reservation_config;
  v_n   int;
begin
  select * into v_cfg from reservation_config where id = 1;

  with released as (
    update reservations
       set status = 'no_show', closed_at = now()
     where status in ('pending', 'confirmed')
       and start_at + make_interval(mins => v_cfg.grace_minutes) < now()
    returning id
  )
  select count(*) into v_n from released;

  return v_n;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----
--
-- ⚠️ ทุก migration ที่สร้างฟังก์ชันใหม่ต้องมีบล็อกแบบนี้
-- Postgres ให้ EXECUTE กับ PUBLIC ทุกฟังก์ชันที่สร้างใหม่ การตัดสิทธิ์ใน
-- migration ก่อนหน้าจึงไม่คุ้มถึงฟังก์ชันที่เพิ่มทีหลัง
-- (เทสต์ตรวจสิทธิ์ใน 20_operations_test.sql จะจับได้ถ้าลืม)

revoke all on function
  new_reservation_code(),
  reservations_set_end_at(),
  table_available(uuid, timestamptz, timestamptz, uuid),
  assert_bookable(timestamptz, int),
  available_tables(timestamptz, int),
  create_reservation(text, text, int, timestamptz, int, uuid[], text),
  reservation_by_code(text, text),
  cancel_reservation_by_code(text, text),
  confirm_reservation(uuid),
  reject_reservation(uuid, text),
  mark_no_show(uuid),
  seat_reservation(uuid, jsonb, uuid[]),
  release_overdue_reservations()
from public, anon, authenticated;

-- ลูกค้าที่ไม่ล็อกอิน: ดูโต๊ะว่าง จอง และจัดการรายการของตัวเองด้วยรหัส+เบอร์
grant execute on function available_tables(timestamptz, int)                      to anon, authenticated;
grant execute on function create_reservation(text, text, int, timestamptz, int, uuid[], text)
  to anon, authenticated;
grant execute on function reservation_by_code(text, text)                         to anon, authenticated;
grant execute on function cancel_reservation_by_code(text, text)                  to anon, authenticated;

-- พนักงาน (ข้างในเรียก assert_staff() อีกชั้น)
grant execute on function confirm_reservation(uuid)        to authenticated;
grant execute on function reject_reservation(uuid, text)   to authenticated;
grant execute on function mark_no_show(uuid)               to authenticated;
grant execute on function seat_reservation(uuid, jsonb, uuid[]) to authenticated;

-- ไม่เปิดให้ใครเรียกตรง: table_available, assert_bookable, new_reservation_code,
-- reservations_set_end_at (trigger), release_overdue_reservations (cron เรียกเอง)

alter table shop_hours         enable row level security;
alter table reservation_config enable row level security;

grant select on shop_hours, reservation_config to anon, authenticated;

create policy public_read_hours on shop_hours
  for select to anon, authenticated using (true);
create policy public_read_reservation_config on reservation_config
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------------ cron ----

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'release-overdue-reservations', '*/5 * * * *',
      'select release_overdue_reservations()'
    );
  else
    raise notice 'ไม่มี pg_cron — ต้องเรียก release_overdue_reservations() เองเป็นระยะ';
  end if;
exception when others then
  raise notice 'ตั้ง pg_cron ไม่สำเร็จ (%) — ตั้งเองได้ที่ Dashboard → Database → Cron', sqlerrm;
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930000800_drop_cleaning_status.sql
-- ####################################################################

-- ============================================================================
-- เลิกใช้สถานะ "กำลังเก็บ" (cleaning)
--
-- ปัญหา: close_visit กับ move_visit_to_tables ตั้งโต๊ะเป็น 'cleaning' แต่ไม่มี
--        โค้ดไหนตั้งกลับเป็น 'free' เลยสักที่ โต๊ะจึงค้างสถานะนั้นถาวร
--        แล้วเปิดโต๊ะใหม่ไม่ได้อีก เพราะหน้าผังโต๊ะรับเฉพาะโต๊ะที่ว่าง
--
-- ทางแก้ที่ร้านเลือก: ไม่ต้องมีสถานะนี้ — ปิดบิลแล้วโต๊ะกลับมาว่างทันที
--   ร้านเล็กที่พนักงานเก็บโต๊ะเสร็จในไม่กี่นาที การให้กดยืนยันอีกทีคือภาระเปล่า
--
-- ไม่ลบค่าออกจาก enum เพราะ Postgres ลบค่า enum ไม่ได้ตรง ๆ และการมีค่าที่
-- ไม่ถูกใช้ไม่ได้ทำให้เสียหาย แค่ต้องไม่มีใครตั้งมันอีก
-- ============================================================================

-- โต๊ะที่ค้างอยู่จากบั๊กนี้ ปล่อยกลับมาว่าง
update cafe_tables set status = 'free' where status = 'cleaning';

-- ---------------------------------------------------------------------------
-- ย้าย/เพิ่มโต๊ะ — โต๊ะเดิมกลับมาว่างทันที
-- ---------------------------------------------------------------------------
create or replace function move_visit_to_tables(p_visit_id uuid, p_table_ids uuid[])
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

  update cafe_tables set status = 'free' where id = any(v_old);

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

-- ---------------------------------------------------------------------------
-- ปิดบิล — โต๊ะกลับมาว่างทันที รับลูกค้าคิวถัดไปได้เลย
-- ---------------------------------------------------------------------------
create or replace function close_visit(p_visit_id uuid, p_payments jsonb default '[]'::jsonb)
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

  update guest_passes
     set checked_out_at = coalesce(checked_out_at, now()),
         paused_at = null,
         status = 'billed'
   where visit_id = p_visit_id;

  -- โต๊ะกลับมาว่างทันที ไม่ต้องรอใครกดยืนยันว่าเก็บเสร็จ
  update cafe_tables set status = 'free'
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

-- create or replace รักษาสิทธิ์เดิมไว้ แต่ประกาศซ้ำให้ชัด กันกรณีถูกรันบน
-- ฐานข้อมูลที่สิทธิ์เพี้ยน (เทสต์ตรวจสิทธิ์จะจับได้ถ้าหลุด)
revoke all on function
  move_visit_to_tables(uuid, uuid[]),
  close_visit(uuid, jsonb)
from public, anon, authenticated;

grant execute on function move_visit_to_tables(uuid, uuid[]) to authenticated;
grant execute on function close_visit(uuid, jsonb)           to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930000900_owner_settings.sql
-- ####################################################################

-- ============================================================================
-- หน้าตั้งค่าสำหรับเจ้าของร้าน: เมนู โต๊ะ เรตราคา เวลาทำการ
--
-- ก่อนเปิดให้แก้ค่าพวกนี้ได้ ต้องอุดสองเรื่องก่อน ไม่งั้นหน้านี้จะพังข้อมูลเงิน
--
-- 1) ค่าเล่นไม่ได้ snapshot ไว้
--    preview_bill join rate_plans สด ๆ ทุกครั้ง ถ้าเจ้าของขึ้นราคาตอนบ่าย
--    บิลของทุกคนที่กำลังนั่งอยู่จะเปลี่ยนย้อนหลังทั้งเซสชัน ลูกค้าที่เข้ามา
--    ตอนเช้าโดนคิดราคาใหม่ ซึ่งผิดทั้งทางบัญชีและทางความรู้สึก
--    → คัดลอกเรตลงใน guest_pass ตอนเช็คอิน เหมือนที่ order_lines ทำกับราคาอาหาร
--
-- 2) ลบเมนู/โต๊ะที่เคยถูกใช้แล้วไม่ได้ เพราะติด FK จาก order_lines / occupancies
--    → ใช้การเก็บเข้ากรุ (archived) ไม่ลบจริง ประวัติและใบเสร็จเก่าจึงอยู่ครบ
-- ============================================================================

-- ------------------------------------------------------- เก็บเข้ากรุ ----

alter table menu_items  add column archived boolean not null default false;
alter table cafe_tables add column archived boolean not null default false;

create index menu_items_active_idx  on menu_items  (sort_order) where not archived;
create index cafe_tables_active_idx on cafe_tables (sort_order) where not archived;

-- --------------------------------------------- snapshot เรตค่าเล่น ----

alter table guest_passes
  add column rate_name             text,
  add column rate_price_per_hour   numeric(10,2),
  add column rate_round_to_minutes int,
  add column rate_minimum_minutes  int,
  add column rate_day_pass_cap     numeric(10,2);

-- เติมให้ pass ที่มีอยู่แล้ว ใช้ค่าปัจจุบันของเรตที่ผูกไว้
update guest_passes gp
   set rate_name             = rp.name,
       rate_price_per_hour   = rp.price_per_hour,
       rate_round_to_minutes = rp.round_to_minutes,
       rate_minimum_minutes  = rp.minimum_minutes,
       rate_day_pass_cap     = rp.day_pass_cap
  from rate_plans rp
 where rp.id = gp.rate_plan_id;

-- ตั้งแต่นี้ไป ทุก pass ที่เปิดใหม่จะถือเรตของตัวเองติดตัว
create function guest_passes_snapshot_rate() returns trigger
language plpgsql as $$
declare v_plan rate_plans;
begin
  if new.rate_price_per_hour is null then
    select * into v_plan from rate_plans where id = new.rate_plan_id;
    if not found then
      raise exception 'ไม่พบเรตราคา %', new.rate_plan_id using errcode = 'P0002';
    end if;
    new.rate_name             := v_plan.name;
    new.rate_price_per_hour   := v_plan.price_per_hour;
    new.rate_round_to_minutes := v_plan.round_to_minutes;
    new.rate_minimum_minutes  := v_plan.minimum_minutes;
    new.rate_day_pass_cap     := v_plan.day_pass_cap;
  end if;
  return new;
end;
$$;

create trigger guest_passes_rate_snapshot
  before insert on guest_passes
  for each row execute function guest_passes_snapshot_rate();

alter table guest_passes
  alter column rate_price_per_hour   set not null,
  alter column rate_round_to_minutes set not null,
  alter column rate_minimum_minutes  set not null;

-- คิดค่าเล่นจากค่าที่ snapshot ไว้ ไม่ต้องมีแถว rate_plans อยู่แล้วก็คิดได้
create function play_time_charge(
  p_minutes   int,
  p_per_hour  numeric,
  p_round_to  int,
  p_minimum   int,
  p_cap       numeric
) returns numeric
language sql immutable as $$
  with charged as (
    select greatest(p_minutes, p_minimum) as m
  ), raw as (
    select ceil(m::numeric / p_round_to) * p_round_to / 60.0 * p_per_hour as amount
    from charged
  )
  select round(case when p_cap is null then amount else least(amount, p_cap) end, 2)
  from raw;
$$;

-- preview_bill: เลิก join rate_plans ใช้ค่าที่ติดตัว pass มาแทน
create or replace function preview_bill(p_visit_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tax      tax_config;
  v_lines    jsonb;
  v_subtotal numeric(10,2);
  v_service  numeric(10,2);
  v_base     numeric(10,2);
  v_vat      numeric(10,2);
  v_total    numeric(10,2);
begin
  if not exists (select 1 from visits where id = p_visit_id) then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;

  select * into v_tax from tax_config where id = 1;

  with play as (
    select
      'bl-play-' || gp.id  as id,
      'play_time'          as source,
      gp.id                as source_id,
      gp.id                as guest_pass_id,
      'ค่าเล่น · ' || gp.display_name as label,
      1::numeric           as qty,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as unit_price,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as amount,
      1                    as grp,
      gp.checked_in_at     as ord
    from guest_passes gp
    where gp.visit_id = p_visit_id
  ), food as (
    select
      'bl-ord-' || ol.id  as id,
      'order_item'        as source,
      ol.id               as source_id,
      case when o.split_mode = 'shared' then null else o.ordered_by_pass_id end as guest_pass_id,
      ol.name_snapshot    as label,
      ol.qty::numeric     as qty,
      ol.unit_price_snapshot as unit_price,
      round(ol.unit_price_snapshot * ol.qty, 2) as amount,
      2                   as grp,
      o.placed_at         as ord
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.visit_id = p_visit_id
      and o.status in ('placed', 'accepted', 'preparing', 'ready', 'served')
  ), penalty as (
    select
      'bl-pen-' || gl.id  as id,
      'game_penalty'      as source,
      gl.id               as source_id,
      null::uuid          as guest_pass_id,
      'ค่าปรับ · ' || gt.name as label,
      1::numeric          as qty,
      gl.penalty          as unit_price,
      gl.penalty          as amount,
      3                   as grp,
      gl.out_at           as ord
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
        'id', id, 'source', source, 'sourceId', source_id,
        'guestPassId', guest_pass_id, 'label', label,
        'qty', qty, 'unitPrice', unit_price, 'amount', amount
      ) order by grp, ord
    ), '[]'::jsonb),
    coalesce(round(sum(amount), 2), 0)
  into v_lines, v_subtotal
  from all_lines;

  v_service := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base    := v_subtotal + v_service;

  if v_tax.vat_included then
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'visitId', p_visit_id, 'lines', v_lines, 'subtotal', v_subtotal,
    'serviceCharge', v_service, 'vat', v_vat, 'total', v_total,
    'computedAt', p_now
  );
end;
$$;

-- ------------------------------------------------------- สิทธิ์ระดับจัดการ ----

-- ตั้งค่าร้านทำได้ตั้งแต่ระดับ manager ขึ้นไป (manager, owner)
-- ถ้าอยากให้เฉพาะ owner แก้บรรทัดเดียวที่นี่
create function assert_manager() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from staff
     where user_id = auth.uid() and active and role in ('manager', 'owner')
  ) then
    raise exception 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' using errcode = '42501';
  end if;
end;
$$;

/** บอกหน้าจอว่าผู้ใช้ปัจจุบันเป็นระดับไหน เพื่อซ่อน/แสดงเมนูตั้งค่า */
create function my_staff_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from staff where user_id = auth.uid() and active;
$$;

-- ------------------------------------------------------------------ เมนู ----

create function upsert_menu_item(
  p_id         uuid,
  p_sku        text,
  p_name       text,
  p_category   menu_category,
  p_price      numeric,
  p_available  boolean,
  p_sort_order int default 0
) returns menu_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row menu_items;
begin
  perform assert_manager();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อเมนู' using errcode = '22023';
  end if;
  if coalesce(trim(p_sku), '') = '' then
    raise exception 'ต้องใส่รหัสเมนู' using errcode = '22023';
  end if;
  if p_price < 0 then
    raise exception 'ราคาติดลบไม่ได้' using errcode = '22023';
  end if;

  if p_id is null then
    insert into menu_items (sku, name, category, price, available, sort_order)
    values (upper(trim(p_sku)), trim(p_name), p_category, p_price, p_available, p_sort_order)
    returning * into v_row;
  else
    update menu_items
       set sku = upper(trim(p_sku)), name = trim(p_name), category = p_category,
           price = p_price, available = p_available, sort_order = p_sort_order
     where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'ไม่พบเมนู %', p_id using errcode = 'P0002';
    end if;
  end if;

  -- ราคาที่แก้มีผลกับออเดอร์ใหม่เท่านั้น ใบเสร็จเก่าใช้ราคา snapshot ตอนสั่ง
  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_menu_item', 'menu_item', v_row.id,
          jsonb_build_object('name', v_row.name, 'price', v_row.price));

  return v_row;
end;
$$;

create function archive_menu_item(p_id uuid, p_archived boolean default true)
returns menu_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row menu_items;
begin
  perform assert_manager();
  -- ไม่ลบจริง เพราะ order_lines อ้างถึงอยู่ ใบเสร็จเก่าต้องอ่านได้ตลอดไป
  update menu_items
     set archived = p_archived,
         available = case when p_archived then false else available end
   where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'ไม่พบเมนู %', p_id using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'archive_menu_item', 'menu_item', p_id,
          jsonb_build_object('archived', p_archived));
  return v_row;
end;
$$;

-- ------------------------------------------------------------------ โต๊ะ ----

create function upsert_table(
  p_id          uuid,
  p_code        text,
  p_zone        text,
  p_seat_min    int,
  p_seat_max    int,
  p_allow_share boolean,
  p_sort_order  int default 0
) returns cafe_tables
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row cafe_tables;
begin
  perform assert_manager();

  if coalesce(trim(p_code), '') = '' then
    raise exception 'ต้องใส่รหัสโต๊ะ' using errcode = '22023';
  end if;
  if p_seat_min < 1 or p_seat_max < p_seat_min then
    raise exception 'จำนวนที่นั่งไม่ถูกต้อง' using errcode = '22023';
  end if;

  if p_id is null then
    insert into cafe_tables (code, zone, seat_min, seat_max, allow_share, sort_order)
    values (upper(trim(p_code)), trim(p_zone), p_seat_min, p_seat_max, p_allow_share, p_sort_order)
    returning * into v_row;
  else
    -- ห้ามเปลี่ยน allow_share ตอนมีคนนั่งอยู่ เพราะ occupancies.exclusive
    -- ถูกคัดลอกไปตอนเปิดโต๊ะ ค่าจะไม่ตรงกันจนกติกาโต๊ะซ้อนเพี้ยน
    if exists (
      select 1 from occupancies o
       join cafe_tables t on t.id = o.table_id
      where o.table_id = p_id and o.to_at is null and t.allow_share <> p_allow_share
    ) then
      raise exception 'เปลี่ยนการนั่งร่วมตอนมีลูกค้าอยู่ไม่ได้ ปิดบิลก่อน'
        using errcode = '22023';
    end if;

    update cafe_tables
       set code = upper(trim(p_code)), zone = trim(p_zone),
           seat_min = p_seat_min, seat_max = p_seat_max,
           allow_share = p_allow_share, sort_order = p_sort_order
     where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'ไม่พบโต๊ะ %', p_id using errcode = 'P0002';
    end if;
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_table', 'cafe_table', v_row.id,
          jsonb_build_object('code', v_row.code));
  return v_row;
end;
$$;

create function archive_table(p_id uuid, p_archived boolean default true)
returns cafe_tables
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row cafe_tables;
  v_n   int;
begin
  perform assert_manager();

  if p_archived then
    if exists (select 1 from occupancies where table_id = p_id and to_at is null) then
      raise exception 'โต๊ะนี้มีลูกค้านั่งอยู่ ปิดบิลก่อน' using errcode = '22023';
    end if;

    select count(*) into v_n from reservations
     where status in ('pending', 'confirmed') and p_id = any(table_ids);
    if v_n > 0 then
      raise exception 'โต๊ะนี้มีคิวจองค้างอยู่ % รายการ จัดการคิวก่อน', v_n
        using errcode = '22023';
    end if;
  end if;

  update cafe_tables
     set archived = p_archived,
         status = case when p_archived then status else 'free'::table_status end
   where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'ไม่พบโต๊ะ %', p_id using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'archive_table', 'cafe_table', p_id,
          jsonb_build_object('archived', p_archived, 'code', v_row.code));
  return v_row;
end;
$$;

-- ------------------------------------------------------------- เรตราคา ----

create function upsert_rate_plan(
  p_id         uuid,
  p_name       text,
  p_per_hour   numeric,
  p_round_to   int,
  p_minimum    int,
  p_cap        numeric,
  p_active     boolean default true,
  p_sort_order int default 0
) returns rate_plans
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row rate_plans;
begin
  perform assert_manager();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อเรต' using errcode = '22023';
  end if;
  if p_per_hour < 0 or p_round_to < 1 or p_minimum < 0 then
    raise exception 'ค่าที่กรอกไม่ถูกต้อง' using errcode = '22023';
  end if;
  if p_cap is not null and p_cap < 0 then
    raise exception 'เพดานเหมาวันติดลบไม่ได้' using errcode = '22023';
  end if;

  if p_id is null then
    insert into rate_plans (name, price_per_hour, round_to_minutes, minimum_minutes,
                            day_pass_cap, active, sort_order)
    values (trim(p_name), p_per_hour, p_round_to, p_minimum, p_cap, p_active, p_sort_order)
    returning * into v_row;
  else
    update rate_plans
       set name = trim(p_name), price_per_hour = p_per_hour,
           round_to_minutes = p_round_to, minimum_minutes = p_minimum,
           day_pass_cap = p_cap, active = p_active, sort_order = p_sort_order
     where id = p_id
    returning * into v_row;
    if not found then
      raise exception 'ไม่พบเรตราคา %', p_id using errcode = 'P0002';
    end if;
  end if;

  -- ไม่กระทบคนที่กำลังนั่งอยู่ เพราะ guest_passes เก็บเรตของตัวเองไว้แล้ว
  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_rate_plan', 'rate_plan', v_row.id,
          jsonb_build_object('name', v_row.name, 'pricePerHour', v_row.price_per_hour));
  return v_row;
end;
$$;

-- ---------------------------------------------------------- เวลาทำการ ----

create function upsert_shop_hours(
  p_weekday smallint,
  p_open    time,
  p_close   time,
  p_closed  boolean
) returns shop_hours
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row shop_hours;
begin
  perform assert_manager();

  if p_weekday < 0 or p_weekday > 6 then
    raise exception 'วันไม่ถูกต้อง' using errcode = '22023';
  end if;
  -- ร้านที่ปิดหลังเที่ยงคืนยังไม่รองรับ เพราะ assert_bookable ห้ามการจองข้ามวัน
  if not p_closed and p_close <= p_open then
    raise exception 'เวลาปิดต้องหลังเวลาเปิด (ยังไม่รองรับร้านที่ปิดข้ามวัน)'
      using errcode = '22023';
  end if;

  insert into shop_hours (weekday, open_time, close_time, closed)
  values (p_weekday, p_open, p_close, p_closed)
  on conflict (weekday) do update
    set open_time = excluded.open_time,
        close_time = excluded.close_time,
        closed = excluded.closed
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_shop_hours', 'shop_hours', null,
          jsonb_build_object('weekday', p_weekday, 'open', p_open,
                             'close', p_close, 'closed', p_closed));
  return v_row;
end;
$$;

create function update_tax_config(
  p_service_charge_rate numeric,
  p_vat_rate            numeric,
  p_vat_included        boolean
) returns tax_config
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row tax_config;
begin
  perform assert_manager();

  if p_service_charge_rate < 0 or p_service_charge_rate > 1
     or p_vat_rate < 0 or p_vat_rate > 1 then
    raise exception 'อัตราต้องอยู่ระหว่าง 0 ถึง 1 (เช่น 0.07 = 7%%)' using errcode = '22023';
  end if;

  update tax_config
     set service_charge_rate = p_service_charge_rate,
         vat_rate = p_vat_rate,
         vat_included = p_vat_included
   where id = 1
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'update_tax_config', 'tax_config', null, to_jsonb(v_row));
  return v_row;
end;
$$;

-- --------------------------------------- ซ่อนของที่เก็บเข้ากรุจากหน้าร้าน ----

create or replace view public_tables as
  select id, code, zone, seat_min, seat_max, allow_share, status, sort_order
    from cafe_tables
   where not archived;

create or replace function available_tables(
  p_start    timestamptz,
  p_duration int default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg reservation_config;
  v_end timestamptz;
begin
  select * into v_cfg from reservation_config where id = 1;
  v_end := p_start + make_interval(mins => coalesce(p_duration, v_cfg.default_duration_minutes));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'code', t.code, 'zone', t.zone,
             'seatMin', t.seat_min, 'seatMax', t.seat_max,
             'allowShare', t.allow_share,
             'available', table_available(t.id, p_start, v_end)
           ) order by t.sort_order)
      from cafe_tables t
     where not t.archived
  ), '[]'::jsonb);
end;
$$;

-- เมนูที่ลูกค้าเห็นหลังสแกน QR ต้องไม่มีของที่เก็บเข้ากรุแล้ว
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token and not archived;
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
       where gp.visit_id = v_visit and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price, 'available', m.available)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----
-- ฟังก์ชันใหม่ทุกตัวได้ EXECUTE จาก PUBLIC มาโดยปริยาย ต้องตัดก่อนเสมอ

revoke all on function
  assert_manager(),
  my_staff_role(),
  guest_passes_snapshot_rate(),
  play_time_charge(int, numeric, int, int, numeric),
  upsert_menu_item(uuid, text, text, menu_category, numeric, boolean, int),
  archive_menu_item(uuid, boolean),
  upsert_table(uuid, text, text, int, int, boolean, int),
  archive_table(uuid, boolean),
  upsert_rate_plan(uuid, text, numeric, int, int, numeric, boolean, int),
  upsert_shop_hours(smallint, time, time, boolean),
  update_tax_config(numeric, numeric, boolean)
from public, anon, authenticated;

grant execute on function my_staff_role() to authenticated;
grant execute on function upsert_menu_item(uuid, text, text, menu_category, numeric, boolean, int) to authenticated;
grant execute on function archive_menu_item(uuid, boolean)                    to authenticated;
grant execute on function upsert_table(uuid, text, text, int, int, boolean, int) to authenticated;
grant execute on function archive_table(uuid, boolean)                        to authenticated;
grant execute on function upsert_rate_plan(uuid, text, numeric, int, int, numeric, boolean, int) to authenticated;
grant execute on function upsert_shop_hours(smallint, time, time, boolean)    to authenticated;
grant execute on function update_tax_config(numeric, numeric, boolean)        to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930001000_menu_images.sql
-- ####################################################################

-- ============================================================================
-- รูปประกอบเมนู
--
-- เก็บไฟล์ใน Supabase Storage bucket 'menu-images' และเก็บเฉพาะ "path"
-- ลงตาราง ไม่เก็บ URL เต็ม เพราะโดเมนของโปรเจกต์เปลี่ยนได้ (ย้ายโปรเจกต์
-- ย้าย region) ถ้าเก็บ URL เต็มไว้ รูปทั้งร้านจะตายพร้อมกัน
--
-- ความปลอดภัย: Storage มี RLS เป็นของตัวเองบน storage.objects ซึ่งเป็นคนละ
-- พื้นผิวกับ RLS ของตารางปกติ เทสต์ตรวจสิทธิ์ฟังก์ชันที่มีอยู่ไม่ครอบถึงตรงนี้
-- จึงต้องเขียน policy และเทสต์แยกต่างหาก
--
-- ด่านกันไฟล์ใหญ่/ผิดชนิดอยู่ที่ bucket ไม่ใช่ที่หน้าจอ — การย่อรูปฝั่ง client
-- เป็นเรื่องประสบการณ์ใช้งานและค่า egress ไม่ใช่ความปลอดภัย
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
alter table menu_items add column if not exists image_path text;

-- ---------------------------------------------------------------------------
-- is_manager() คืนค่า boolean ไว้ใช้ใน policy ของ storage
-- (assert_manager() โยน exception ซึ่งใช้ใน policy ไม่ได้)
-- ---------------------------------------------------------------------------
create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from staff
     where user_id = auth.uid() and active and role in ('manager', 'owner')
  );
$$;

create or replace function assert_manager() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_manager() then
    raise exception 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ผูก/ถอดรูปออกจากเมนู
--
-- คืน path เดิมกลับไปให้หน้าจอเอาไปลบไฟล์เก่าทิ้ง ถ้าไม่คืน ไฟล์เก่าจะค้าง
-- เป็นขยะทุกครั้งที่เปลี่ยนรูป
-- ---------------------------------------------------------------------------
create or replace function set_menu_image(p_id uuid, p_path text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform assert_manager();

  select image_path into v_old from menu_items where id = p_id;
  if not found then
    raise exception 'ไม่พบเมนู %', p_id using errcode = 'P0002';
  end if;

  -- กันไม่ให้ชี้ไปไฟล์นอก bucket ของเรา หรือยัด URL เต็มเข้ามา
  if p_path is not null and p_path !~ '^menu/[0-9a-zA-Z._-]+$' then
    raise exception 'path รูปไม่ถูกต้อง' using errcode = '22023';
  end if;

  update menu_items set image_path = p_path where id = p_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_menu_image', 'menu_item', p_id,
          jsonb_build_object('from', v_old, 'to', p_path));

  return v_old;
end;
$$;

-- เมนูที่ลูกค้าเห็นหลังสแกน QR ต้องมีรูปด้วย
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token and not archived;
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
       where gp.visit_id = v_visit and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function
  is_manager(),
  set_menu_image(uuid, text)
from public, anon, authenticated;

grant execute on function set_menu_image(uuid, text) to authenticated;

-- is_manager() ถูกเรียกจาก policy ของ storage.objects ซึ่งประเมินด้วยสิทธิ์
-- ของผู้ใช้ที่ยิงคำสั่ง ถ้าไม่ให้ EXECUTE การอัปโหลดจะพังด้วย
-- "permission denied for function is_manager" ทั้งที่ policy เขียนถูก
-- (เป็น SECURITY DEFINER และบอกแค่สถานะของตัวผู้เรียกเอง จึงไม่รั่วอะไร)
grant execute on function is_manager() to authenticated;

-- ------------------------------------------------------------- Storage ----
-- ข้ามได้ถ้ารันบน Postgres เปล่าที่ไม่มี Supabase Storage (เช่นตอนทดสอบ)

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'ไม่มี Supabase Storage — ข้ามการตั้งค่า bucket';
    return;
  end if;

  -- public = true ให้ลูกค้าเปิดรูปได้โดยไม่ต้องล็อกอิน
  -- ขนาดและชนิดไฟล์ถูกบังคับที่นี่ เป็นด่านจริง ไม่ใช่ที่หน้าจอ
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg'])
  on conflict (id) do update
    set public = true,
        file_size_limit = 2097152,
        allowed_mime_types = array['image/jpeg'];

  -- ลบ policy เดิมก่อน เพื่อให้รันไฟล์นี้ซ้ำได้
  drop policy if exists menu_images_public_read on storage.objects;
  drop policy if exists menu_images_manager_insert on storage.objects;
  drop policy if exists menu_images_manager_update on storage.objects;
  drop policy if exists menu_images_manager_delete on storage.objects;

  -- ใครก็ดูรูปเมนูได้ เหมือนเมนูที่ติดอยู่หน้าร้าน
  create policy menu_images_public_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'menu-images');

  -- แต่เขียนได้เฉพาะระดับผู้จัดการ และเฉพาะใน bucket นี้
  create policy menu_images_manager_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'menu-images' and is_manager());

  create policy menu_images_manager_update on storage.objects
    for update to authenticated
    using (bucket_id = 'menu-images' and is_manager())
    with check (bucket_id = 'menu-images' and is_manager());

  create policy menu_images_manager_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'menu-images' and is_manager());
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930001100_staff_management.sql
-- ####################################################################

-- ============================================================================
-- จัดการบัญชีพนักงานจากในแอป + เข้าสู่ระบบด้วย username
--
-- Supabase Auth ไม่มีการล็อกอินด้วย username ให้ มีแต่อีเมล/เบอร์/OAuth
-- วิธีที่ใช้คือให้ทุกบัญชีมีอีเมลภายในที่พนักงานไม่เคยเห็น แล้วเก็บ username
-- ไว้ในตาราง staff เป็นตัวแมปกลับไปหาอีเมลนั้น
--
-- ทำไมต้องแมปผ่านตาราง แทนที่จะต่อ "@โดเมน" เอาเองทั้งสองฝั่ง:
--   1. ถ้าฝั่งหน้าจอกับฝั่งสร้างบัญชีใช้โดเมนคนละตัว จะล็อกอินไม่ได้แบบเงียบ ๆ
--   2. บัญชีเดิมที่สร้างด้วยอีเมลจริงจะยังใช้ได้ ไม่ต้องสร้างใหม่
--
-- ส่วน "สร้างบัญชี" ต้องใช้ service_role key ซึ่งอยู่ในเว็บ static ไม่ได้
-- จึงอยู่ใน Edge Function — ดู supabase/functions/create-staff/
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
alter table staff add column if not exists username text;

-- เทียบ username แบบไม่สนตัวพิมพ์ แต่เก็บตามที่พิมพ์มา
create unique index if not exists staff_username_key on staff (lower(username));

-- บัญชีที่มีอยู่แล้วต้องยังล็อกอินได้ ตั้ง username จากส่วนหน้า @ ของอีเมล
-- ถ้าชนกันให้ต่อเลขท้าย เพื่อให้ unique index ผ่าน
with numbered as (
  select s.user_id,
         lower(split_part(u.email, '@', 1)) as base,
         row_number() over (
           partition by lower(split_part(u.email, '@', 1))
           order by s.created_at
         ) as n
    from staff s
    join auth.users u on u.id = s.user_id
)
update staff s
   set username = case when n.n = 1 then n.base else n.base || n.n::text end
  from numbered n
 where n.user_id = s.user_id
   and s.username is null;   -- รันซ้ำแล้วไม่ทับของเดิม

alter table staff drop constraint if exists staff_username_format;
alter table staff
  add constraint staff_username_format
  check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,29}$');

-- ---------------------------------------------------------------------------
-- เติม username ให้อัตโนมัติถ้าไม่ได้ระบุมา
--
-- จำเป็นเพราะแถวใน staff ถูกสร้างได้หลายทาง ไม่ใช่แค่ผ่านหน้าแอป — บัญชีแรก
-- ของร้านสร้างด้วย SQL มือใน Dashboard ตามคู่มือติดตั้ง ถ้าปล่อยให้ username
-- เป็น null คนนั้นจะล็อกอินด้วยชื่อผู้ใช้ไม่ได้เลย และไม่มีอะไรบอกว่าทำไม
-- (เติมย้อนหลังครั้งเดียวตอน migration ไม่พอ เพราะครอบเฉพาะแถวที่มีอยู่ตอนนั้น)
-- ---------------------------------------------------------------------------
create or replace function staff_default_username() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_base text;
  v_try  text;
  v_n    int := 1;
begin
  if new.username is not null then
    new.username := lower(trim(new.username));
    return new;
  end if;

  select lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9._-]', '', 'g'))
    into v_base
    from auth.users where id = new.user_id;

  -- อีเมลบางแบบเหลือสั้นเกินกฎหลังตัดอักขระต้องห้าม ต้องมีชื่อสำรองเสมอ
  if v_base is null or length(v_base) < 3 then
    v_base := 'staff' || substr(replace(new.user_id::text, '-', ''), 1, 6);
  end if;

  v_try := v_base;
  while exists (select 1 from staff where lower(username) = v_try) loop
    v_n := v_n + 1;
    v_try := v_base || v_n::text;
  end loop;

  new.username := v_try;
  return new;
end;
$$;

drop trigger if exists staff_username_default on staff;
create trigger staff_username_default
  before insert on staff
  for each row execute function staff_default_username();

-- ---------------------------------------------------------------------------
-- หาอีเมลที่ใช้ล็อกอินจาก username
--
-- เรียกได้โดยไม่ต้องล็อกอิน เพราะต้องใช้ "ก่อน" ล็อกอิน
-- คืนอีเมลปลอมเมื่อหาไม่เจอ เพื่อไม่ให้ใครไล่เดาได้ว่ามี username ไหนอยู่บ้าง
-- — ไม่ว่าจะใส่ชื่อถูกหรือผิด ผลที่ได้คือ "รหัสผ่านไม่ถูกต้อง" เหมือนกัน
-- ---------------------------------------------------------------------------
create or replace function login_email_for(p_username text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_input text := lower(trim(coalesce(p_username, '')));
  v_email text;
begin
  -- พิมพ์อีเมลเต็มมาก็ให้ผ่านไปตรง ๆ รองรับบัญชีที่สร้างไว้ก่อนมีระบบ username
  if v_input like '%@%' then
    return v_input;
  end if;

  select u.email into v_email
    from staff s
    join auth.users u on u.id = s.user_id
   where lower(s.username) = v_input;

  return coalesce(v_email, 'unknown-' || v_input || '@invalid.local');
end;
$$;

-- ---------------------------------------------------------------------------
-- รายชื่อพนักงาน
--
-- อีเมลอยู่ใน auth.users ซึ่ง client อ่านตรงไม่ได้ จึงต้องผ่าน SECURITY DEFINER
-- ที่ตรวจสิทธิ์เองก่อน
-- ---------------------------------------------------------------------------
create or replace function list_staff()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_manager();

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', s.user_id,
             'username', s.username,
             'displayName', s.display_name,
             'role', s.role,
             'active', s.active,
             'email', u.email,
             'createdAt', s.created_at,
             'isSelf', s.user_id = auth.uid()
           ) order by
             -- เรียงตามอำนาจ แล้วค่อยตามชื่อ
             case s.role when 'owner' then 0 when 'manager' then 1 else 2 end,
             s.display_name)
      from staff s
      join auth.users u on u.id = s.user_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- กันร้านล็อกตัวเอง: ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คน
-- ไม่งั้นจะไม่มีใครเข้าไปแก้อะไรได้อีก และกู้คืนได้ทางเดียวคือเข้า Dashboard
-- ไปแก้ SQL เอง
-- ---------------------------------------------------------------------------
create or replace function assert_owner_remains(p_user_id uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from staff where user_id = p_user_id and role = 'owner' and active
  ) and (select count(*) from staff where role = 'owner' and active) <= 1 then
    raise exception 'ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คน'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function set_staff_role(p_user_id uuid, p_role text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if p_role not in ('staff', 'manager', 'owner') then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  -- ตั้งคนเป็นเจ้าของร้านได้เฉพาะเจ้าของร้านด้วยกัน
  -- ไม่งั้นผู้จัดการจะเลื่อนคนอื่น (หรือวางหมากให้ตัวเอง) ขึ้นเป็นเจ้าของได้
  if p_role = 'owner' and my_staff_role() <> 'owner' then
    raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่ตั้งเจ้าของร้านคนใหม่ได้'
      using errcode = '42501';
  end if;

  -- เปลี่ยนสิทธิ์ตัวเองไม่ได้ กันกดพลาดแล้วหลุดออกจากหน้าตั้งค่าของตัวเอง
  if p_user_id = auth.uid() and p_role <> my_staff_role() then
    raise exception 'เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้ ให้คนอื่นเปลี่ยนให้'
      using errcode = '22023';
  end if;

  if p_role <> 'owner' then
    perform assert_owner_remains(p_user_id);
  end if;

  update staff set role = p_role where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_role', 'staff', p_user_id,
          jsonb_build_object('role', p_role));
  return v_row;
end;
$$;

create or replace function set_staff_active(p_user_id uuid, p_active boolean)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if p_user_id = auth.uid() and not p_active then
    raise exception 'ปิดการใช้งานบัญชีตัวเองไม่ได้' using errcode = '22023';
  end if;

  if not p_active then
    perform assert_owner_remains(p_user_id);
  end if;

  update staff set active = p_active where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_active', 'staff', p_user_id,
          jsonb_build_object('active', p_active));
  return v_row;
end;
$$;

create or replace function rename_staff(p_user_id uuid, p_name text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อ' using errcode = '22023';
  end if;

  update staff set display_name = trim(p_name)
   where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edge Function เรียกตัวนี้หลังสร้างบัญชี Auth เสร็จ
--
-- แยกออกมาเพื่อให้กติกา "ใครตั้งใครเป็นอะไรได้" อยู่ในฐานข้อมูลที่เดียว
-- ไม่กระจายไปอยู่ในโค้ด Edge Function ด้วย
--
-- p_actor ส่งมาจาก Edge Function เพราะเวลาเรียกด้วย service_role นั้น
-- auth.uid() เป็น null — ถ้าไม่บอกว่าใครสั่ง audit_log จะว่างเปล่า
-- ---------------------------------------------------------------------------
create or replace function register_staff(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_role     text,
  p_actor    uuid
) returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row        staff;
  v_actor_role text;
  v_username   text := lower(trim(coalesce(p_username, '')));
begin
  select role into v_actor_role from staff where user_id = p_actor and active;
  if v_actor_role is null or v_actor_role not in ('manager', 'owner') then
    raise exception 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' using errcode = '42501';
  end if;

  if p_role not in ('staff', 'manager', 'owner') then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  if p_role = 'owner' and v_actor_role <> 'owner' then
    raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่ตั้งเจ้าของร้านคนใหม่ได้'
      using errcode = '42501';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อพนักงาน' using errcode = '22023';
  end if;

  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'ชื่อผู้ใช้ต้องยาว 3–30 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข'
      using errcode = '22023';
  end if;

  if exists (select 1 from staff where lower(username) = v_username) then
    raise exception 'ชื่อผู้ใช้ "%" ถูกใช้ไปแล้ว', v_username using errcode = '23505';
  end if;

  insert into staff (user_id, username, display_name, role)
  values (p_user_id, v_username, trim(p_name), p_role)
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (p_actor, 'register_staff', 'staff', p_user_id,
          jsonb_build_object('username', v_username, 'name', v_row.display_name,
                             'role', p_role));

  return v_row;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function
  staff_default_username(),
  login_email_for(text),
  list_staff(),
  assert_owner_remains(uuid),
  set_staff_role(uuid, text),
  set_staff_active(uuid, boolean),
  rename_staff(uuid, text),
  register_staff(uuid, text, text, text, uuid)
from public, anon, authenticated;

-- ต้องเรียกได้ก่อนล็อกอิน จึงเปิดให้ anon
grant execute on function login_email_for(text)           to anon, authenticated;

grant execute on function list_staff()                    to authenticated;
grant execute on function set_staff_role(uuid, text)      to authenticated;
grant execute on function set_staff_active(uuid, boolean) to authenticated;
grant execute on function rename_staff(uuid, text)        to authenticated;

-- register_staff ไม่เปิดให้เรียกจากเบราว์เซอร์เลย — Edge Function เรียกด้วย
-- service_role ซึ่งข้ามการตรวจสิทธิ์ของ Postgres อยู่แล้ว

-- ####################################################################
-- # supabase/migrations/20260930001200_role_capabilities.sql
-- ####################################################################

-- ============================================================================
-- แยกสิทธิ์เป็น 4 อย่าง แล้วให้ระดับพนักงานเป็นชุดสำเร็จของสิทธิ์เหล่านั้น
--
-- ทำไมไม่เพิ่มเป็น role ตายตัวไปเรื่อย ๆ: ระดับที่ร้านอยากได้คือการจับคู่ของ
-- สิทธิ์ย่อย (ดูโต๊ะ / ดูครัว / ตั้งค่า / จัดการบัญชี) ถ้าทำเป็น role ล้วน ๆ
-- พอวันหน้าอยากได้ "ครัว + ตั้งค่า" ก็ต้องเพิ่ม role ใหม่และแก้ทุกฟังก์ชันอีกรอบ
-- เก็บเป็นตารางแทน ทำให้เพิ่ม/ปรับชุดสิทธิ์ได้โดยไม่ต้องแก้โค้ดเลย
--
--   floor     เปิดโต๊ะ รับออเดอร์ เช็คบิล จัดการคิวจอง
--   kitchen   จอครัว เปลี่ยนสถานะออเดอร์
--   settings  ตั้งค่าร้าน (เมนู โต๊ะ เรตราคา เวลาทำการ รูป)
--   accounts  เพิ่ม/แก้บัญชีพนักงาน
--
-- ระดับเดิมทั้งสามได้สิทธิ์เท่าเดิมเป๊ะ ไม่มีใครได้เพิ่มหรือถูกตัดจากการ migrate
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
create table if not exists role_capabilities (
  role       text not null,
  capability text not null check (capability in ('floor', 'kitchen', 'settings', 'accounts')),
  primary key (role, capability)
);

insert into role_capabilities (role, capability) values
  -- ดูโต๊ะและการจอง
  ('floor',   'floor'),
  -- ดูเฉพาะห้องครัว
  ('kitchen', 'kitchen'),
  -- ดูได้ทั้งหน้าร้านและครัว (ความหมายเดิมของ staff)
  ('staff',   'floor'), ('staff',   'kitchen'),
  -- เพิ่มการตั้งค่าร้าน (ความหมายเดิมของ manager)
  ('manager', 'floor'), ('manager', 'kitchen'), ('manager', 'settings'),
  -- เพิ่มการจัดการบัญชีพนักงาน (ความหมายเดิมของ owner)
  ('owner',   'floor'), ('owner',   'kitchen'), ('owner',   'settings'), ('owner', 'accounts')
on conflict do nothing;

alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('floor', 'kitchen', 'staff', 'manager', 'owner'));

-- ---------------------------------------------------------------------------
-- ตรวจสิทธิ์รายข้อ
-- ---------------------------------------------------------------------------
create or replace function has_cap(p_cap text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = auth.uid() and s.active and rc.capability = p_cap
  );
$$;

create or replace function assert_cap(p_cap text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_cap(p_cap) then
    raise exception '%', case p_cap
      when 'floor'    then 'ต้องมีสิทธิ์ดูแลหน้าร้าน'
      when 'kitchen'  then 'ต้องมีสิทธิ์ดูแลห้องครัว'
      when 'settings' then 'ต้องมีสิทธิ์ตั้งค่าร้าน'
      when 'accounts' then 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน'
      else 'ไม่มีสิทธิ์ทำรายการนี้'
    end using errcode = '42501';
  end if;
end;
$$;

/** หน้าจอใช้ซ่อน/แสดงเมนู — การซ่อนเมนูไม่ใช่กำแพง ด่านจริงอยู่ที่ RPC */
create or replace function my_capabilities() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(rc.capability order by rc.capability), '{}')
    from staff s
    join role_capabilities rc on rc.role = s.role
   where s.user_id = auth.uid() and s.active;
$$;

-- ---------------------------------------------------------------------------
-- เปลี่ยนนิยามของด่านเดิม แทนที่จะไล่แก้ทุก RPC
--
-- assert_staff()   ถูกเรียกจาก 14 RPC ซึ่งเป็นงานหน้าร้านทั้งหมด ยกเว้น
--                  update_order_status ที่เป็นงานครัว จึงประกาศแยกด้านล่าง
-- assert_manager() ถูกเรียกจาก RPC ตั้งค่าร้านทุกตัว
-- is_manager()     ถูกเรียกจาก policy ของ storage ตอนอัปโหลดรูปเมนู
-- is_staff()       ใช้ใน RLS สำหรับ "อ่าน" ข้อมูล — ยังหมายถึงพนักงานที่ใช้งานอยู่
--                  ไม่เปลี่ยน เพราะคนครัวก็ต้องอ่านออเดอร์และโต๊ะได้
-- ---------------------------------------------------------------------------
create or replace function assert_staff() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('floor');
end;
$$;

create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_cap('settings');
$$;

create or replace function assert_manager() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('settings');
end;
$$;

-- งานครัว: เปลี่ยนสถานะออเดอร์
create or replace function update_order_status(p_order_id uuid, p_status order_status)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_from  order_status;
  v_ok    boolean;
begin
  perform assert_cap('kitchen');

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

-- ---------------------------------------------------------------------------
-- จัดการบัญชีพนักงาน: แยกออกจาก "ตั้งค่าร้าน" เป็นสิทธิ์ของตัวเอง
-- คนที่แก้ราคาได้ ไม่จำเป็นต้องเพิ่มบัญชีคนอื่นได้
-- ---------------------------------------------------------------------------
create or replace function list_staff()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('accounts');

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', s.user_id,
             'username', s.username,
             'displayName', s.display_name,
             'role', s.role,
             'active', s.active,
             'email', u.email,
             'createdAt', s.created_at,
             'isSelf', s.user_id = auth.uid()
           ) order by
             case s.role
               when 'owner' then 0 when 'manager' then 1
               when 'staff' then 2 when 'floor' then 3 else 4
             end,
             s.display_name)
      from staff s
      join auth.users u on u.id = s.user_id
  ), '[]'::jsonb);
end;
$$;

create or replace function set_staff_role(p_user_id uuid, p_role text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_cap('accounts');

  if not exists (select 1 from role_capabilities where role = p_role) then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  -- ยกสิทธิ์จัดการบัญชีให้คนอื่นได้เฉพาะคนที่มีสิทธิ์นั้นอยู่แล้ว
  -- ไม่งั้นคนที่ได้สิทธิ์นี้มาจะแต่งตั้งใครก็ได้ให้เท่าเทียมตัวเอง โดยที่
  -- เจ้าของร้านไม่รู้ตัว
  if exists (select 1 from role_capabilities
              where role = p_role and capability = 'accounts')
     and not has_cap('accounts') then
    raise exception 'ต้องมีสิทธิ์จัดการบัญชีพนักงานก่อน จึงจะยกสิทธิ์นี้ให้คนอื่นได้'
      using errcode = '42501';
  end if;

  if p_user_id = auth.uid() and p_role <> (select role from staff where user_id = auth.uid()) then
    raise exception 'เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้ ให้คนอื่นเปลี่ยนให้'
      using errcode = '22023';
  end if;

  -- ต้องเหลือคนที่จัดการบัญชีได้อย่างน้อยหนึ่งคน ไม่งั้นจะไม่มีใครแก้อะไรได้อีก
  if not exists (select 1 from role_capabilities
                  where role = p_role and capability = 'accounts') then
    perform assert_admin_remains(p_user_id);
  end if;

  update staff set role = p_role where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_role', 'staff', p_user_id,
          jsonb_build_object('role', p_role));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- เดิมผูกกับ role 'owner' ตรง ๆ ตอนนี้ผูกกับ "สิทธิ์จัดการบัญชี" แทน
-- เพราะระดับที่ถือสิทธิ์นั้นอาจมีมากกว่าหนึ่งชื่อในอนาคต
-- ---------------------------------------------------------------------------
create or replace function assert_admin_remains(p_user_id uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_is_admin boolean;
begin
  select exists (
    select 1 from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = p_user_id and s.active and rc.capability = 'accounts'
  ) into v_is_admin;

  if v_is_admin and (
    select count(distinct s.user_id) from staff s
      join role_capabilities rc on rc.role = s.role
     where s.active and rc.capability = 'accounts'
  ) <= 1 then
    raise exception 'ต้องเหลือคนที่จัดการบัญชีพนักงานได้อย่างน้อย 1 คน'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function set_staff_active(p_user_id uuid, p_active boolean)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_cap('accounts');

  if p_user_id = auth.uid() and not p_active then
    raise exception 'ปิดการใช้งานบัญชีตัวเองไม่ได้' using errcode = '22023';
  end if;

  if not p_active then
    perform assert_admin_remains(p_user_id);
  end if;

  update staff set active = p_active where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_active', 'staff', p_user_id,
          jsonb_build_object('active', p_active));
  return v_row;
end;
$$;

create or replace function rename_staff(p_user_id uuid, p_name text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_cap('accounts');

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อ' using errcode = '22023';
  end if;

  update staff set display_name = trim(p_name)
   where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function register_staff(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_role     text,
  p_actor    uuid
) returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      staff;
  v_username text := lower(trim(coalesce(p_username, '')));
  v_can      boolean;
begin
  select exists (
    select 1 from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = p_actor and s.active and rc.capability = 'accounts'
  ) into v_can;

  if not v_can then
    raise exception 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน' using errcode = '42501';
  end if;

  if not exists (select 1 from role_capabilities where role = p_role) then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อพนักงาน' using errcode = '22023';
  end if;

  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'ชื่อผู้ใช้ต้องยาว 3–30 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข'
      using errcode = '22023';
  end if;

  if exists (select 1 from staff where lower(username) = v_username) then
    raise exception 'ชื่อผู้ใช้ "%" ถูกใช้ไปแล้ว', v_username using errcode = '23505';
  end if;

  insert into staff (user_id, username, display_name, role)
  values (p_user_id, v_username, trim(p_name), p_role)
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (p_actor, 'register_staff', 'staff', p_user_id,
          jsonb_build_object('username', v_username, 'name', v_row.display_name,
                             'role', p_role));

  return v_row;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function
  has_cap(text),
  assert_cap(text),
  my_capabilities(),
  assert_admin_remains(uuid)
from public, anon, authenticated;

-- หน้าจอต้องรู้ว่าตัวเองทำอะไรได้บ้าง เพื่อซ่อนเมนูที่กดไปก็โดนปฏิเสธ
grant execute on function my_capabilities() to authenticated;
grant execute on function has_cap(text)     to authenticated;

grant select on role_capabilities to authenticated;
alter table role_capabilities enable row level security;
drop policy if exists staff_read_capabilities on role_capabilities;
create policy staff_read_capabilities on role_capabilities
  for select to authenticated using (is_staff());

-- ของเดิมผูกกับชื่อ role 'owner' ตรง ๆ ถูกแทนด้วย assert_admin_remains แล้ว
-- ลบทิ้งไม่ให้มีด่านสองชุดที่อาจเพี้ยนจากกัน
drop function if exists assert_owner_remains(uuid);

-- ####################################################################
-- # supabase/migrations/20260930001300_push_notifications.sql
-- ####################################################################

-- ============================================================================
-- แจ้งเตือนขึ้นมือถือเมื่อมีออเดอร์เข้าครัว (Web Push)
--
-- เส้นทาง: มีออเดอร์ใหม่ → trigger → pg_net ยิงไปที่ Edge Function
--          → Edge Function ส่ง push ไปยังอุปกรณ์ของคนที่มีสิทธิ์ 'kitchen'
--
-- ทำไมต้องผ่าน Edge Function: การส่ง Web Push ต้องเซ็น JWT ด้วยกุญแจ VAPID
-- ซึ่งเป็นความลับ อยู่ในเบราว์เซอร์ไม่ได้ และ Postgres เซ็น ES256 เองไม่ได้
--
-- ส่ง push แบบ "ไม่มีเนื้อหา" โดยตั้งใจ — Web Push ที่มี payload ต้องเข้ารหัส
-- aes128gcm ซึ่งซับซ้อนและพังง่าย ส่วนข้อความแจ้งเตือนเขียนไว้ใน service worker
-- อยู่แล้ว คนครัวกดแล้วเปิดจอครัวเห็นรายละเอียดครบ
-- ============================================================================

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  -- URL ที่เบราว์เซอร์ให้มา ใช้เป็นตัวระบุอุปกรณ์
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- ค่าที่ trigger ต้องใช้ยิงไปหา Edge Function
--
-- notify_secret สุ่มตอนสร้างตาราง ไม่ได้ฝังไว้ในไฟล์นี้ เพราะไฟล์นี้อยู่ใน
-- โค้ดสาธารณะ เจ้าของร้านอ่านค่าไปใส่เป็น secret ของ Edge Function เอง
-- ---------------------------------------------------------------------------
create table if not exists push_config (
  id            int primary key default 1 check (id = 1),
  function_url  text,
  notify_secret text not null default gen_random_uuid()::text,
  enabled       boolean not null default true
);

insert into push_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- อุปกรณ์ลงทะเบียน/ยกเลิก
-- ---------------------------------------------------------------------------
create or replace function save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;

  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = ''
     or coalesce(p_auth, '') = '' then
    raise exception 'ข้อมูลการลงทะเบียนไม่ครบ' using errcode = '22023';
  end if;

  -- อุปกรณ์เดิมอาจถูกใช้โดยคนใหม่ (เปลี่ยนคนเฝ้าจอ) จึงทับเจ้าของเดิมได้
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent;
end;
$$;

create or replace function delete_push_subscription(p_endpoint text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;

  -- ลบได้เฉพาะอุปกรณ์ของตัวเอง
  delete from push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

/** หน้าจอใช้บอกว่าอุปกรณ์นี้เปิดแจ้งเตือนไว้แล้วหรือยัง */
create or replace function has_push_subscription(p_endpoint text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from push_subscriptions
     where endpoint = p_endpoint and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- รายชื่ออุปกรณ์ที่ต้องส่งแจ้งเตือนไปหา
--
-- ให้ฐานข้อมูลเป็นคนตอบว่า "ใครควรได้รับ" แทนที่จะให้ Edge Function ไปต่อ
-- ความสัมพันธ์เอง — push_subscriptions.user_id อ้าง auth.users ไม่ใช่ staff
-- จึง join ข้ามไปหา role_capabilities ผ่าน PostgREST ตรง ๆ ไม่ได้
-- ---------------------------------------------------------------------------
-- drop ก่อนเสมอ เพราะไฟล์ถัดไปเปลี่ยนคอลัมน์ที่คืนกลับ ถ้าใช้ create or replace
-- แล้วรันไฟล์นี้ซ้ำทีหลัง Postgres จะปฏิเสธว่าเปลี่ยนชนิดที่คืนไม่ได้
drop function if exists kitchen_push_endpoints();

create function kitchen_push_endpoints()
returns table (id uuid, endpoint text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct ps.id, ps.endpoint
    from push_subscriptions ps
    join staff s on s.user_id = ps.user_id and s.active
    join role_capabilities rc on rc.role = s.role and rc.capability = 'kitchen';
$$;

-- ---------------------------------------------------------------------------
-- ยิงบอก Edge Function เมื่อมีออเดอร์ใหม่
--
-- ใช้ trigger ไม่ใช่เรียกจากฝั่งแอป เพราะออเดอร์เข้าได้สองทาง (พนักงานสั่งแทน
-- และลูกค้าสแกน QR สั่งเอง) ถ้าเรียกจากแอปต้องไปใส่สองที่แล้วลืมที่หนึ่งแน่
-- ---------------------------------------------------------------------------
create or replace function notify_kitchen_on_order() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_cfg push_config;
begin
  select * into v_cfg from push_config where id = 1;

  if not found or not v_cfg.enabled or coalesce(v_cfg.function_url, '') = '' then
    return new;  -- ยังไม่ได้ตั้งค่า — ไม่ใช่ข้อผิดพลาด
  end if;

  if to_regproc('net.http_post') is null then
    return new;  -- ไม่มี pg_net (เช่นตอนทดสอบบน Postgres เปล่า)
  end if;

  -- ยิงแบบไม่รอผล ถ้าปลายทางล่ม ออเดอร์ต้องยังบันทึกสำเร็จอยู่ดี
  -- การแจ้งเตือนพังไม่ควรทำให้ลูกค้าสั่งของไม่ได้
  begin
    perform net.http_post(
      url := v_cfg.function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', v_cfg.notify_secret
      ),
      body := jsonb_build_object('orderId', new.id),
      timeout_milliseconds := 3000
    );
  exception when others then
    raise warning 'ส่งแจ้งเตือนครัวไม่สำเร็จ: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists orders_notify_kitchen on orders;
create trigger orders_notify_kitchen
  after insert on orders
  for each row
  when (new.status = 'placed')
  execute function notify_kitchen_on_order();

-- ----------------------------------------------------------------- สิทธิ์ ----

alter table push_subscriptions enable row level security;
alter table push_config        enable row level security;

-- ไม่มี policy ใด ๆ = ไม่มีใครอ่าน/เขียนตรงได้เลย แม้แต่พนักงาน
-- ทุกอย่างผ่าน RPC และ Edge Function (service_role) เท่านั้น
-- push_config มีความลับอยู่ข้างใน จึงต้องไม่หลุดไปถึง client เด็ดขาด

revoke all on push_subscriptions, push_config from anon, authenticated;

revoke all on function
  kitchen_push_endpoints(),
  save_push_subscription(text, text, text, text),
  delete_push_subscription(text),
  has_push_subscription(text),
  notify_kitchen_on_order()
from public, anon, authenticated;

grant execute on function save_push_subscription(text, text, text, text) to authenticated;
grant execute on function delete_push_subscription(text)                 to authenticated;
grant execute on function has_push_subscription(text)                    to authenticated;

-- ---------------------------------------------------------------------------
-- หลัง apply ไฟล์นี้ เจ้าของร้านต้องทำอีกสองอย่าง (ดู supabase/README.md)
--
--   1. เปิด pg_net:
--        create extension if not exists pg_net with schema extensions;
--
--   2. บอกที่อยู่ของ Edge Function แล้วอ่านรหัสลับไปใส่ใน Secrets ของฟังก์ชัน:
--        update push_config
--           set function_url = 'https://<project-ref>.supabase.co/functions/v1/notify-kitchen';
--        select notify_secret from push_config;
-- ---------------------------------------------------------------------------

-- ####################################################################
-- # supabase/migrations/20260930001400_push_payload.sql
-- ####################################################################

-- ============================================================================
-- ข้อความในแจ้งเตือน
--
-- ของเดิมส่ง push เปล่า ๆ แล้วให้ service worker เขียนข้อความตายตัวว่า
-- "มีออเดอร์ใหม่เข้าครัว" เพราะ push ที่มีเนื้อหาต้องเข้ารหัส aes128gcm
-- ตอนนี้ทำการเข้ารหัสแล้ว (ดู functions/notify-kitchen/webpush.ts) จึงส่ง
-- รายละเอียดไปได้
--
-- ให้ฐานข้อมูลเป็นคนประกอบข้อความ ไม่ใช่ Edge Function เพราะข้อมูลอยู่ที่นี่
-- และจะได้ไม่ต้อง deploy ฟังก์ชันใหม่ทุกครั้งที่อยากแก้ถ้อยคำ
-- ============================================================================

-- ต้องคืนกุญแจของอุปกรณ์มาด้วย เพราะการเข้ารหัสผูกกับเครื่องปลายทางรายเครื่อง
-- ของเดิมคืนแค่ endpoint ซึ่งพอสำหรับ push เปล่า ๆ แต่ไม่พอสำหรับส่งข้อความ
drop function if exists kitchen_push_endpoints();

create function kitchen_push_endpoints()
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct ps.id, ps.endpoint, ps.p256dh, ps.auth
    from push_subscriptions ps
    join staff s on s.user_id = ps.user_id and s.active
    join role_capabilities rc on rc.role = s.role and rc.capability = 'kitchen';
$$;

revoke all on function kitchen_push_endpoints() from public, anon, authenticated;

create or replace function order_push_summary(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_order  orders;
  v_table  text;
  v_items  text;
  v_count  int;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then
    return jsonb_build_object('title', 'มีออเดอร์ใหม่เข้าครัว', 'body', 'แตะเพื่อเปิดจอครัว');
  end if;

  -- ใช้โต๊ะปัจจุบัน ไม่ใช่โต๊ะตอนสั่ง ลูกค้าอาจย้ายโต๊ะไปแล้ว
  select t.code into v_table
    from occupancies o
    join cafe_tables t on t.id = o.table_id
   where o.visit_id = v_order.visit_id and o.to_at is null
   order by o.from_at
   limit 1;

  -- จำกัดไว้ 4 รายการแรก กันข้อความยาวจนถูกตัดบนหน้าจอล็อก
  select string_agg(line, ', ' order by ord), max(total)
    into v_items, v_count
    from (
      select ol.name_snapshot || ' ×' || ol.qty as line,
             row_number() over (order by ol.id) as ord,
             count(*) over () as total
        from order_lines ol
       where ol.order_id = p_order_id
    ) x
   where ord <= 4;

  return jsonb_build_object(
    'title', 'ออเดอร์ใหม่ · โต๊ะ ' || coalesce(v_table, '—'),
    'body', coalesce(v_items, 'แตะเพื่อเปิดจอครัว')
            || case when v_count > 4 then ' และอีก ' || (v_count - 4) || ' รายการ' else '' end,
    'orderId', p_order_id
  );
end;
$$;

revoke all on function order_push_summary(uuid) from public, anon, authenticated;
-- เรียกได้เฉพาะ Edge Function ด้วย service_role เท่านั้น

-- ####################################################################
-- # supabase/migrations/20260930001500_settle_pass.sql
-- ####################################################################

-- ============================================================================
-- จ่ายตอนกลับก่อน
--
-- ปัญหา: ร้านบอร์ดเกมเจอแทบทุกวัน — คนหนึ่งในกลุ่มต้องไปก่อน ขอจ่ายส่วนของ
--        ตัวเองแล้วไป แต่ของเดิมออกบิลได้ทางเดียวคือปิดทั้งโต๊ะ คนที่เหลือ
--        ยังเล่นอยู่ก็ปิดไม่ได้ พนักงานเลยต้องจดใส่กระดาษแล้วไปหักกันทีหลัง
--
-- วิธี: ออกบิลย่อยให้คนนั้นคนเดียว แล้วตีตรา pass เป็น 'billed'
--       (สถานะนี้มีใน enum มาตั้งแต่แรก ตอนนี้ได้ใช้จริง)
--
-- หัวใจคือ "ของที่หารกัน" ต้องไม่ถูกเก็บซ้ำและไม่ตกหล่น:
--   - preview_bill ตัดคนที่จ่ายแล้วออก ทั้งค่าเล่นและของที่สั่งเอง
--   - ส่วนที่หารกันยังแสดงเต็มจำนวน แล้วหักด้วยบรรทัด 'หักส่วนที่ชำระแล้ว'
--     ซึ่งอ่านแล้วตรวจสอบได้ ดีกว่าลดตัวเลขเงียบ ๆ ให้ไล่ไม่ออกว่าหายไปไหน
--   - คนที่เหลือคนสุดท้ายรับเศษไปทั้งหมด ยอดจึงบวกกลับได้เท่าเดิมเสมอ
--
-- ของที่สั่งเพิ่มหลังจากคนหนึ่งจ่ายไปแล้ว จะหารเฉพาะคนที่ยังอยู่ — ถูกต้อง
-- ตามที่ควรเป็น เพราะคนที่กลับไปแล้วไม่ได้กินด้วย
-- ============================================================================

-- ยอด "ของที่หารกัน" ที่ถูกชำระไปแล้วสะสม เก็บที่ visit เพราะเป็นของทั้งโต๊ะ
alter table visits add column if not exists shared_settled numeric(10,2) not null default 0;

-- ---------------------------------------------------------------------------
-- preview_bill — ต่อไปหมายถึง "ยอดที่ยังค้างอยู่" ไม่ใช่ยอดดิบทั้งหมด
--
-- ทุกหน้าจอที่เรียกอันนี้ (ผังโต๊ะ, หน้าปิดบิล, บิลฝั่งลูกค้า) ต้องการตัวเลข
-- เดียวกันคือ "ยังต้องเก็บอีกเท่าไร" จึงนิยามไว้ที่เดียวแทนที่จะให้แต่ละหน้า
-- ไปลบกันเอง
-- ---------------------------------------------------------------------------
create or replace function preview_bill(p_visit_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_lines    jsonb;
  v_subtotal numeric(10,2);
  v_service  numeric(10,2);
  v_vat      numeric(10,2);
  v_base     numeric(10,2);
  v_total    numeric(10,2);
  v_tax      tax_config;
  v_settled  numeric(10,2);
begin
  if not exists (select 1 from visits where id = p_visit_id) then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;

  select * into v_tax from tax_config where id = 1;
  select shared_settled into v_settled from visits where id = p_visit_id;

  with play as (
    select
      'bl-play-' || gp.id  as id,
      'play_time'          as source,
      gp.id                as source_id,
      gp.id                as guest_pass_id,
      'ค่าเล่น · ' || gp.display_name as label,
      1::numeric           as qty,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as unit_price,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as amount,
      1                    as grp,
      gp.checked_in_at     as ord
    from guest_passes gp
    where gp.visit_id = p_visit_id
      -- คนที่จ่ายแล้วมีบิลของตัวเองไปแล้ว ไม่ต้องคิดซ้ำ
      and gp.status <> 'billed'
  ), food as (
    select
      'bl-ord-' || ol.id  as id,
      'order_item'        as source,
      ol.id               as source_id,
      case when o.split_mode = 'shared' then null else o.ordered_by_pass_id end as guest_pass_id,
      ol.name_snapshot    as label,
      ol.qty::numeric     as qty,
      ol.unit_price_snapshot as unit_price,
      round(ol.unit_price_snapshot * ol.qty, 2) as amount,
      2                   as grp,
      o.placed_at         as ord
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.visit_id = p_visit_id
      and o.status in ('placed', 'accepted', 'preparing', 'ready', 'served')
      -- ของที่คนจ่ายแล้วสั่งเองก็อยู่ในบิลของเขาแล้ว แต่ของที่หารกันยังอยู่
      and not (
        o.split_mode = 'owner'
        and o.ordered_by_pass_id in (
          select id from guest_passes where visit_id = p_visit_id and status = 'billed'
        )
      )
  ), penalty as (
    select
      'bl-pen-' || gl.id  as id,
      'game_penalty'      as source,
      gl.id               as source_id,
      null::uuid          as guest_pass_id,
      'ค่าปรับ · ' || gt.name as label,
      1::numeric          as qty,
      gl.penalty          as unit_price,
      gl.penalty          as amount,
      3                   as grp,
      gl.out_at           as ord
    from game_loans gl
    join game_titles gt on gt.id = gl.game_title_id
    where gl.visit_id = p_visit_id and gl.penalty > 0
  ), settled as (
    -- บรรทัดติดลบ ให้เห็นกับตาว่าหักอะไรออกไป ไม่ใช่ลดตัวเลขเงียบ ๆ
    select
      'bl-settled-' || p_visit_id as id,
      'adjustment'        as source,
      null::uuid          as source_id,
      null::uuid          as guest_pass_id,
      'หักส่วนที่ชำระแล้ว' as label,
      1::numeric          as qty,
      -v_settled          as unit_price,
      -v_settled          as amount,
      4                   as grp,
      p_now               as ord
    where v_settled > 0
  ), all_lines as (
    select * from play
    union all select * from food
    union all select * from penalty
    union all select * from settled
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id, 'source', source, 'sourceId', source_id,
        'guestPassId', guest_pass_id, 'label', label,
        'qty', qty, 'unitPrice', unit_price, 'amount', amount
      ) order by grp, ord
    ), '[]'::jsonb),
    coalesce(round(sum(amount), 2), 0)
  into v_lines, v_subtotal
  from all_lines;

  v_service := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base    := v_subtotal + v_service;

  if v_tax.vat_included then
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'visitId', p_visit_id, 'lines', v_lines, 'subtotal', v_subtotal,
    'serviceCharge', v_service, 'vat', v_vat, 'total', v_total,
    'computedAt', p_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ยอดที่คนนี้ต้องจ่ายถ้ากลับตอนนี้ — ให้หน้าจอเรียกดูก่อนกดเก็บเงิน
--
-- แยกเป็นฟังก์ชันของตัวเองเพื่อให้หน้าจอกับตอนเก็บเงินจริงใช้สูตรเดียวกัน
-- ไม่ใช่ต่างคนต่างคิดแล้วได้ตัวเลขไม่ตรงกัน
-- ---------------------------------------------------------------------------
create or replace function pass_settlement(p_pass_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_pass      guest_passes;
  v_preview   jsonb;
  v_own       jsonb;
  v_own_total numeric(10,2);
  v_shared    numeric(10,2);
  v_heads     int;
  v_share     numeric(10,2);
  v_subtotal  numeric(10,2);
  v_service   numeric(10,2);
  v_vat       numeric(10,2);
  v_base      numeric(10,2);
  v_total     numeric(10,2);
  v_tax       tax_config;
begin
  select * into v_pass from guest_passes where id = p_pass_id;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว' using errcode = '22023';
  end if;

  select * into v_tax from tax_config where id = 1;
  v_preview := preview_bill(v_pass.visit_id, p_now);

  select
    coalesce(jsonb_agg(l), '[]'::jsonb),
    coalesce(sum((l ->> 'amount')::numeric), 0)
  into v_own, v_own_total
  from jsonb_array_elements(v_preview -> 'lines') l
  where l ->> 'guestPassId' = p_pass_id::text;

  -- บรรทัดที่ไม่มีเจ้าของ = ของที่หารกัน รวมบรรทัดหักส่วนที่ชำระแล้วด้วย
  -- จึงเป็นยอดสุทธิที่ยังไม่มีใครรับผิดชอบ
  select coalesce(sum((l ->> 'amount')::numeric), 0)
    into v_shared
    from jsonb_array_elements(v_preview -> 'lines') l
   where l ->> 'guestPassId' is null;

  select count(*) into v_heads
    from guest_passes
   where visit_id = v_pass.visit_id and status <> 'billed';

  -- คนสุดท้ายรับเศษไปทั้งหมด ยอดรวมของทุกบิลย่อยจึงเท่ากับยอดเต็มเสมอ
  if v_heads <= 1 then
    v_share := v_shared;
  else
    v_share := round(v_shared / v_heads, 2);
  end if;

  v_subtotal := round(v_own_total + v_share, 2);
  v_service  := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base     := v_subtotal + v_service;

  if v_tax.vat_included then
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'passId',        p_pass_id,
    'visitId',       v_pass.visit_id,
    'displayName',   v_pass.display_name,
    'ownLines',      v_own,
    'sharedShare',   v_share,
    'headcount',     v_heads,
    'subtotal',      v_subtotal,
    'serviceCharge', v_service,
    'vat',           v_vat,
    'total',         v_total,
    'computedAt',    p_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- เก็บเงินคนที่กลับก่อน แล้วออกบิลย่อยให้
--
-- ถ้ายังไม่ได้เช็คเอาต์จะเช็คเอาต์ให้ด้วย เพราะในทางปฏิบัติมันคือเรื่อง
-- เดียวกัน — ไม่มีใครจ่ายแล้วนั่งเล่นต่อโดยไม่นับเวลา
-- ---------------------------------------------------------------------------
create or replace function settle_pass(p_pass_id uuid, p_payments jsonb default '[]'::jsonb)
returns bills
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass   guest_passes;
  v_visit  visits;
  v_calc   jsonb;
  v_bill   bills;
  v_line   jsonb;
  v_pay    jsonb;
  v_paid   numeric(10,2);
begin
  perform assert_staff();

  select * into v_pass from guest_passes where id = p_pass_id for update;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว' using errcode = '22023';
  end if;

  -- ล็อก visit ไว้ตลอดการคิดเงิน กันสองเครื่องกดเก็บเงินคนละคนพร้อมกัน
  -- แล้วต่างคนต่างอ่าน shared_settled ค่าเดิม ทำให้หารกันผิด
  select * into v_visit from visits where id = v_pass.visit_id for update;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  if v_pass.status in ('active', 'paused') then
    -- หยุดนาฬิกาก่อนคิดเงิน ไม่งั้นค่าเล่นจะเดินต่อระหว่างนับเงิน
    update guest_passes
       set paused_minutes = paused_minutes + case
             when paused_at is not null
             then greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int)
             else 0 end,
           paused_at = null,
           checked_out_at = now(),
           status = 'checked_out'
     where id = p_pass_id
    returning * into v_pass;
  end if;

  v_calc := pass_settlement(p_pass_id);

  insert into bills (visit_id, subtotal, service_charge, vat, total, closed_by)
  values (
    v_pass.visit_id,
    (v_calc ->> 'subtotal')::numeric,
    (v_calc ->> 'serviceCharge')::numeric,
    (v_calc ->> 'vat')::numeric,
    (v_calc ->> 'total')::numeric,
    auth.uid()
  ) returning * into v_bill;

  for v_line in select * from jsonb_array_elements(v_calc -> 'ownLines') loop
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id,
      (v_line ->> 'source')::bill_line_source,
      (v_line ->> 'sourceId')::uuid,
      p_pass_id,
      v_line ->> 'label',
      (v_line ->> 'qty')::numeric,
      (v_line ->> 'unitPrice')::numeric,
      (v_line ->> 'amount')::numeric
    );
  end loop;

  if (v_calc ->> 'sharedShare')::numeric <> 0 then
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id, 'adjustment', null, p_pass_id,
      'ส่วนแบ่งรายการที่หารกัน (' || (v_calc ->> 'headcount') || ' คน)',
      1,
      (v_calc ->> 'sharedShare')::numeric,
      (v_calc ->> 'sharedShare')::numeric
    );
  end if;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into payments (bill_id, method, amount, paid_for, taken_by)
    values (v_bill.id, v_pay ->> 'method', (v_pay ->> 'amount')::numeric,
            array[p_pass_id], auth.uid());
  end loop;

  select coalesce(sum(amount), 0) into v_paid from payments where bill_id = v_bill.id;
  if v_paid >= v_bill.total then
    update bills set status = 'paid' where id = v_bill.id returning * into v_bill;
  end if;

  -- จดส่วนที่หารกันซึ่งถูกรับผิดชอบไปแล้ว คนที่เหลือจะได้ไม่ต้องจ่ายซ้ำ
  update visits
     set shared_settled = shared_settled + (v_calc ->> 'sharedShare')::numeric
   where id = v_pass.visit_id;

  update guest_passes set status = 'billed' where id = p_pass_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'settle_pass', 'guest_pass', p_pass_id,
          jsonb_build_object('billId', v_bill.id, 'total', v_bill.total, 'paid', v_paid));

  return v_bill;
end;
$$;

revoke all on function pass_settlement(uuid, timestamptz) from public, anon, authenticated;
revoke all on function settle_pass(uuid, jsonb)            from public, anon, authenticated;
grant execute on function pass_settlement(uuid, timestamptz) to authenticated;
grant execute on function settle_pass(uuid, jsonb)           to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930001600_kitchen_hours.sql
-- ####################################################################

-- ============================================================================
-- เวลาปิดครัว
--
-- ร้านส่วนใหญ่ปิดครัวก่อนปิดร้าน (ที่เจอบ่อยคือสี่ทุ่ม) แต่บาร์ยังเสิร์ฟต่อ
-- ของเดิมมีแต่เวลาเปิด-ปิดร้าน ซึ่งใช้กับการจองออนไลน์อย่างเดียว
--
-- กติกาที่ตกลงกันไว้:
--   - ปิดครัวแล้ว สั่งได้เฉพาะเครื่องดื่มกับของกินเล่น (หมวด food/dessert ตัดออก)
--   - ตั้งแยกรายวัน เสาร์-อาทิตย์ปิดดึกกว่าได้
--   - ลูกค้าสแกน QR สั่งไม่ได้เลย ส่วนพนักงานสั่งแทนได้ถ้ายืนยัน เพราะบางที
--     ครัวยังอยู่หรือรับปากลูกค้าไว้แล้ว — ระบบไม่ควรขวางคนที่รู้หน้างานดีกว่า
--
-- ไม่รองรับร้านที่ปิดหลังเที่ยงคืน เหมือนกับเวลาร้าน (ดู upsert_shop_hours)
-- ============================================================================

-- null = ครัวปิดพร้อมร้าน ซึ่งเป็นพฤติกรรมเดิมก่อนมีฟีเจอร์นี้
alter table shop_hours add column if not exists kitchen_close_time time;

-- ---------------------------------------------------------------------------
-- ตอนนี้ครัวเปิดอยู่ไหม
--
-- คิดตามเวลาไทย ไม่ใช่ UTC และอ้างแถวของวันตามเวลาไทยเช่นกัน
-- ตีครึ่งคืนวันเสาร์จะไปเทียบกับเวลาเปิดของวันเสาร์ (11:00) จึงนับว่าปิด
-- ซึ่งถูกต้องสำหรับร้านที่ไม่ได้เปิดข้ามวัน
-- ---------------------------------------------------------------------------
create or replace function kitchen_window(p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_local timestamp;
  v_hours shop_hours;
  v_close time;
begin
  v_local := p_now at time zone 'Asia/Bangkok';
  select * into v_hours from shop_hours where weekday = extract(dow from v_local)::smallint;

  if not found or v_hours.closed then
    return jsonb_build_object('open', false, 'closeAt', null, 'reason', 'วันนี้ร้านปิด');
  end if;

  v_close := coalesce(v_hours.kitchen_close_time, v_hours.close_time);

  if v_local::time < v_hours.open_time then
    return jsonb_build_object(
      'open', false,
      'closeAt', to_char(v_close, 'HH24:MI'),
      'reason', 'ร้านเปิด ' || to_char(v_hours.open_time, 'HH24:MI') || ' น.');
  end if;

  if v_local::time >= v_close then
    return jsonb_build_object(
      'open', false,
      'closeAt', to_char(v_close, 'HH24:MI'),
      'reason', 'ครัวปิดแล้ว (' || to_char(v_close, 'HH24:MI') || ' น.)');
  end if;

  return jsonb_build_object('open', true, 'closeAt', to_char(v_close, 'HH24:MI'), 'reason', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- ของชิ้นไหนต้องใช้ครัว
--
-- ยึดตามหมวดเพื่อไม่ให้เจ้าของร้านต้องมาติ๊กทีละเมนู ถ้าวันหนึ่งมีของที่
-- คาบเกี่ยว ค่อยเพิ่มสวิตช์รายเมนูทีหลัง — ตรงนี้คือจุดเดียวที่ต้องแก้
-- ---------------------------------------------------------------------------
create or replace function needs_kitchen(p_items jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
      join menu_items m on m.id = (it ->> 'menuItemId')::uuid
     where m.category in ('food', 'dessert')
  );
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าสแกน QR — ปิดครัวแล้วสั่งของที่ต้องเข้าครัวไม่ได้
-- ---------------------------------------------------------------------------
create or replace function guest_place_order(
  p_token              uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_items              jsonb,
  p_idempotency_key    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit  uuid;
  v_order  orders;
  v_window jsonb;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_window := kitchen_window();
  if not (v_window ->> 'open')::boolean and needs_kitchen(p_items) then
    raise exception '% สั่งได้เฉพาะเครื่องดื่มและของกินเล่น', v_window ->> 'reason'
      using errcode = '22023';
  end if;

  v_order := place_order_core(
    p_idempotency_key, v_visit, p_ordered_by_pass_id,
    p_split_mode, 'guest', p_items
  );

  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- พนักงาน — สั่งแทนได้ แต่ต้องตั้งใจ ไม่ใช่เผลอ
--
-- ค่าเริ่มต้นของพารามิเตอร์ใหม่คือ false เพื่อให้โค้ดเดิมที่ยังไม่ได้อัปเดต
-- ยังถูกกันไว้ ไม่ใช่ปล่อยผ่านเงียบ ๆ
-- ---------------------------------------------------------------------------
create or replace function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb,
  p_allow_closed_kitchen boolean default false
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_window jsonb;
begin
  perform assert_staff();

  if not p_allow_closed_kitchen then
    v_window := kitchen_window();
    if not (v_window ->> 'open')::boolean and needs_kitchen(p_items) then
      raise exception '% ยืนยันอีกครั้งถ้าครัวยังทำให้ได้', v_window ->> 'reason'
        using errcode = '22023';
    end if;
  end if;

  return place_order_core(
    p_idempotency_key, p_visit_id, p_ordered_by_pass_id,
    p_split_mode, p_placed_by, p_items
  );
end;
$$;

-- ของเดิมที่ไม่มีพารามิเตอร์ท้าย ต้องหายไป ไม่งั้นจะเหลือทางเรียกที่ข้ามด่าน
drop function if exists place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb);

-- ---------------------------------------------------------------------------
-- ลูกค้าที่สแกน QR ต้องรู้ตั้งแต่เปิดเมนู ไม่ใช่กดสั่งแล้วค่อยโดนปฏิเสธ
-- ---------------------------------------------------------------------------
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token and not archived;
  if not found then
    raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
  end if;

  v_visit := visit_for_token(p_token);

  return jsonb_build_object(
    'tableCode', v_table.code,
    'zone',      v_table.zone,
    'visitId',   v_visit,
    'kitchen',   kitchen_window(),
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
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- หน้าตั้งค่าของเจ้าของร้าน
-- ---------------------------------------------------------------------------
drop function if exists upsert_shop_hours(smallint, time, time, boolean);

create or replace function upsert_shop_hours(
  p_weekday       smallint,
  p_open          time,
  p_close         time,
  p_closed        boolean,
  p_kitchen_close time default null
) returns shop_hours
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row shop_hours;
begin
  perform assert_manager();

  if p_weekday < 0 or p_weekday > 6 then
    raise exception 'วันไม่ถูกต้อง' using errcode = '22023';
  end if;
  -- ร้านที่ปิดหลังเที่ยงคืนยังไม่รองรับ เพราะ assert_bookable ห้ามการจองข้ามวัน
  if not p_closed and p_close <= p_open then
    raise exception 'เวลาปิดต้องหลังเวลาเปิด (ยังไม่รองรับร้านที่ปิดข้ามวัน)'
      using errcode = '22023';
  end if;
  -- ครัวปิดหลังร้านไม่มีความหมาย และปิดก่อนร้านเปิดก็เท่ากับไม่เปิดครัวทั้งวัน
  if not p_closed and p_kitchen_close is not null
     and (p_kitchen_close > p_close or p_kitchen_close <= p_open) then
    raise exception 'เวลาปิดครัวต้องอยู่ระหว่าง % ถึง % น.',
      to_char(p_open, 'HH24:MI'), to_char(p_close, 'HH24:MI') using errcode = '22023';
  end if;

  insert into shop_hours (weekday, open_time, close_time, closed, kitchen_close_time)
  values (p_weekday, p_open, p_close, p_closed, p_kitchen_close)
  on conflict (weekday) do update
    set open_time = excluded.open_time,
        close_time = excluded.close_time,
        closed = excluded.closed,
        kitchen_close_time = excluded.kitchen_close_time
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_shop_hours', 'shop_hours', null,
          jsonb_build_object('weekday', p_weekday, 'open', p_open, 'close', p_close,
                             'closed', p_closed, 'kitchenClose', p_kitchen_close));
  return v_row;
end;
$$;

revoke all on function kitchen_window(timestamptz) from public, anon, authenticated;
revoke all on function needs_kitchen(jsonb)        from public, anon, authenticated;
revoke all on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function upsert_shop_hours(smallint, time, time, boolean, time)
  from public, anon, authenticated;

-- ลูกค้าไม่ต้องเรียกตรง ๆ เพราะ guest_session ส่งสถานะครัวไปให้อยู่แล้ว
-- ยิ่งเปิดน้อยยิ่งดี
grant execute on function kitchen_window(timestamptz) to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb, boolean)
  to authenticated;
grant execute on function upsert_shop_hours(smallint, time, time, boolean, time) to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930001700_guest_register.sql
-- ####################################################################

-- ============================================================================
-- ลูกค้าลงชื่อตัวเองผ่าน QR
--
-- ของเดิมพนักงานต้องพิมพ์ชื่อทุกคนตอนเปิดโต๊ะ ซึ่งช้าและชื่อมักเพี้ยน
-- ให้แต่ละคนสแกน QR แล้วลงชื่อเองครั้งเดียว เครื่องจะจำไว้ ตอนสั่งของจึง
-- ไม่ต้องเลือกว่าใครสั่งอีก
--
-- สิ่งที่แลกมาคือ "ใครสแกน QR ได้ ก็สร้างคนที่ต้องจ่ายค่าเล่นได้" จึงต้องมี
--   - เพดานจำนวนคนต่อโต๊ะ กันกดรัวจนเป็นร้อย
--   - ทางให้พนักงานลบคนที่ถูกสร้างผิดออก (void_pass) ซึ่งเดิมไม่มีเลย
--     check_out_pass แค่หยุดเวลาแต่ยังคิดเงิน ใช้แก้เคสนี้ไม่ได้
--
-- เรทค่าเล่นให้เรทมาตรฐานไปก่อน พนักงานเห็นรายชื่อแล้วค่อยปรับเป็น
-- นักเรียน/สมาชิกทีหลัง — ลูกค้าเลือกเรทเองไม่ได้ เพราะกดเลือกเรทถูกสุด
-- ย่อมเป็นเรื่องปกติ
-- ============================================================================

-- จำนวนคนต่อหนึ่งโต๊ะที่ยอมให้ลงชื่อเองได้ กันการกดรัว
-- ไม่ได้กันคนตั้งใจป่วน แค่จำกัดความเสียหายให้พนักงานตามแก้ไหว
create or replace function guest_register_limit() returns int
language sql immutable as $$ select 20 $$;

-- ---------------------------------------------------------------------------
-- ลูกค้าลงชื่อตัวเอง
--
-- คืน passId ให้เครื่องเก็บไว้ ครั้งต่อไปจะได้ไม่ต้องลงชื่อซ้ำ
-- ลงชื่อซ้ำด้วยชื่อเดิมในโต๊ะเดิมคืนใบเดิม ไม่สร้างซ้ำ — กันกดสองที
-- ---------------------------------------------------------------------------
create or replace function guest_register(p_token uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_name  text;
  v_plan  uuid;
  v_pass  guest_passes;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_name := nullif(trim(p_name), '');
  if v_name is null then
    raise exception 'กรุณาใส่ชื่อ' using errcode = '22023';
  end if;
  if length(v_name) > 40 then
    raise exception 'ชื่อยาวเกินไป' using errcode = '22023';
  end if;

  -- ชื่อเดิมในโต๊ะเดิมที่ยังนั่งอยู่ = คนเดิม ไม่ใช่คนใหม่
  select * into v_pass
    from guest_passes
   where visit_id = v_visit
     and lower(display_name) = lower(v_name)
     and status in ('active', 'paused')
   limit 1;
  if found then
    return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
  end if;

  if (select count(*) from guest_passes where visit_id = v_visit) >= guest_register_limit() then
    raise exception 'โต๊ะนี้มีคนครบแล้ว กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  -- เรทมาตรฐาน = เรทที่เปิดใช้อยู่ตัวแรกตามลำดับที่เจ้าของร้านจัดไว้
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;
  if v_plan is null then
    raise exception 'ร้านยังไม่ได้ตั้งเรทค่าเล่น' using errcode = '22023';
  end if;

  insert into guest_passes (visit_id, display_name, rate_plan_id)
  values (v_visit, v_name, v_plan)
  returning * into v_pass;

  return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- ลบคนที่ถูกสร้างผิดออก — พนักงานเท่านั้น
--
-- ต่างจาก check_out_pass ตรงที่อันนั้นแปลว่า "กลับไปแล้ว" ซึ่งยังต้องจ่าย
-- ส่วนอันนี้แปลว่า "ไม่เคยมีคนนี้" จึงลบทิ้งได้จริง
--
-- ลบได้เฉพาะใบที่ยังไม่ผูกกับเงิน ถ้าสั่งของไปแล้วหรือจ่ายไปแล้ว ต้องแก้
-- ด้วยวิธีอื่น ไม่ใช่ลบให้หลักฐานหาย
-- ---------------------------------------------------------------------------
create or replace function void_pass(p_pass_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass  guest_passes;
  v_visit visits;
begin
  perform assert_staff();

  select * into v_pass from guest_passes where id = p_pass_id;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว ลบไม่ได้' using errcode = '22023';
  end if;

  select * into v_visit from visits where id = v_pass.visit_id;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  if exists (select 1 from orders where ordered_by_pass_id = p_pass_id) then
    raise exception 'คนนี้สั่งของไปแล้ว ลบไม่ได้ — ใช้ "กลับก่อน" แทน'
      using errcode = '22023';
  end if;

  if (select count(*) from guest_passes where visit_id = v_pass.visit_id) <= 1 then
    raise exception 'โต๊ะต้องมีอย่างน้อย 1 คน' using errcode = '22023';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'void_pass', 'guest_pass', p_pass_id, to_jsonb(v_pass));

  delete from guest_passes where id = p_pass_id;
end;
$$;

revoke all on function guest_register(uuid, text) from public, anon, authenticated;
revoke all on function void_pass(uuid)            from public, anon, authenticated;
revoke all on function guest_register_limit()     from public, anon, authenticated;

grant execute on function guest_register(uuid, text) to anon, authenticated;
grant execute on function void_pass(uuid)            to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930001800_visit_qr.sql
-- ####################################################################

-- ============================================================================
-- QR ต่อรอบ แทน QR ติดโต๊ะ
--
-- เดิม token ผูกกับโต๊ะ แล้วพิมพ์ติดโต๊ะไว้ถาวร ซึ่งมีปัญหาสามข้อ
--   1. ลูกค้าถ่ายรูป QR กลับบ้านได้ พอโต๊ะนั้นมีคนใหม่นั่ง ก็ลงชื่อเพิ่มคน
--      (guest_register) หรือสั่งของเข้าบิลของคนอื่นจากนอกร้านได้
--   2. โต๊ะที่นั่งร่วมได้ (โต๊ะยาว/เคาน์เตอร์) มีหลายกลุ่มพร้อมกัน แต่ token
--      ชี้ได้แค่ visit ล่าสุด กลุ่มที่มาก่อนจึงสั่งของเข้าบิลกลุ่มที่มาทีหลัง
--   3. ย้ายโต๊ะแล้ว QR ที่ลูกค้าถืออยู่ชี้ไปโต๊ะเดิม ไม่ใช่กลุ่มเดิม
--
-- ย้าย token มาไว้ที่ visit แทน: เปิดโต๊ะหนึ่งครั้ง = QR ใหม่หนึ่งใบ
-- พนักงานพิมพ์ใบเสร็จความร้อนให้ลูกค้าตอนเปิดโต๊ะ QR ตามกลุ่มไปทุกโต๊ะที่ย้าย
-- และตายทันทีที่ปิดบิล
--
-- cafe_tables.qr_token ยังเก็บไว้ เพื่อให้สติกเกอร์เก่าที่ยังติดโต๊ะอยู่
-- บอกลูกค้าได้ว่า "ขอ QR จากพนักงาน" แทนที่จะขึ้นว่าใช้ไม่ได้เฉย ๆ
-- แต่สั่งของหรือลงชื่อผ่านสติกเกอร์เก่าไม่ได้อีกแล้ว
-- ============================================================================

alter table visits add column if not exists qr_token uuid not null default gen_random_uuid();
create unique index if not exists visits_qr_token_idx on visits (qr_token);

-- ---------------------------------------------------------------------------
-- token → visit ที่ยังเปิดอยู่ (null ถ้าปิดบิลแล้วหรือไม่ใช่ token ของรอบไหนเลย)
--
-- ทุก RPC ฝั่งลูกค้า (guest_orders / guest_bill / guest_place_order /
-- guest_register) ผ่านฟังก์ชันนี้ แก้ที่นี่ที่เดียวจึงเปลี่ยนทั้งระบบ
-- ---------------------------------------------------------------------------
create or replace function visit_for_token(p_token uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from visits where qr_token = p_token and status = 'open';
$$;

-- ---------------------------------------------------------------------------
-- ข้อมูลที่ลูกค้าเห็นหลังสแกน QR
--
-- visitId = null + ended = true   → รอบนี้ปิดบิลไปแล้ว
-- visitId = null + ended = false  → สติกเกอร์ QR ติดโต๊ะแบบเก่า
-- ---------------------------------------------------------------------------
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_visit visits;
  v_table cafe_tables;
  v_codes text;
  v_zone  text;
begin
  select * into v_visit from visits where qr_token = p_token;

  if not found then
    select * into v_table from cafe_tables where qr_token = p_token and not archived;
    if not found then
      raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'tableCode', v_table.code,
      'zone',      v_table.zone,
      'visitId',   null,
      'ended',     false,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  -- รวมโต๊ะหลายตัวเป็น "B1+B2" ถ้ากลุ่มใหญ่ต่อโต๊ะ
  -- ปิดบิลแล้วไม่มีโต๊ะที่ครองอยู่ ใช้โต๊ะสุดท้ายที่นั่งแทน
  select string_agg(t.code, '+' order by t.sort_order, t.code), min(t.zone)
    into v_codes, v_zone
    from occupancies o join cafe_tables t on t.id = o.table_id
   where o.visit_id = v_visit.id and o.to_at is null;

  if v_codes is null then
    select t.code, t.zone into v_codes, v_zone
      from occupancies o join cafe_tables t on t.id = o.table_id
     where o.visit_id = v_visit.id
     order by o.from_at desc
     limit 1;
  end if;

  if v_visit.status <> 'open' then
    return jsonb_build_object(
      'tableCode', coalesce(v_codes, '—'),
      'zone',      coalesce(v_zone, ''),
      'visitId',   null,
      'ended',     true,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'tableCode', coalesce(v_codes, '—'),
    'zone',      coalesce(v_zone, ''),
    'visitId',   v_visit.id,
    'ended',     false,
    'kitchen',   kitchen_window(),
    'passes', coalesce((
      select jsonb_agg(jsonb_build_object('id', gp.id, 'displayName', gp.display_name)
                       order by gp.checked_in_at)
        from guest_passes gp
       where gp.visit_id = v_visit.id
         and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ออก QR ใหม่ให้รอบที่ยังเปิดอยู่ — ใช้เมื่อลูกค้าทำใบหาย หรือสงสัยว่าหลุดออกไป
-- ใบเดิมใช้ไม่ได้ทันที
-- ---------------------------------------------------------------------------
create or replace function rotate_visit_token(p_visit_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid;
begin
  perform assert_staff();

  update visits set qr_token = gen_random_uuid()
   where id = p_visit_id and status = 'open'
  returning qr_token into v_token;

  if not found then
    raise exception 'ไม่พบรอบที่ยังเปิดอยู่' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id)
  values (auth.uid(), 'rotate_visit_token', 'visit', p_visit_id);

  return v_token;
end;
$$;

-- QR ติดโต๊ะเลิกใช้แล้ว เปลี่ยน token ของโต๊ะไปก็ไม่มีผลอะไร
drop function if exists rotate_table_token(uuid);

revoke all on function rotate_visit_token(uuid) from public, anon, authenticated;
grant execute on function rotate_visit_token(uuid) to authenticated;

-- ####################################################################
-- # supabase/migrations/20260930001900_claim_pass.sql
-- ####################################################################

-- ============================================================================
-- ลูกค้าที่สแกน QR "รับชื่อ" ที่พนักงานสร้างไว้ตอนเปิดโต๊ะ แทนการสร้างคนใหม่
--
-- ปัญหา: จองมา 4 คน พนักงานเช็คอินโดยไม่ได้พิมพ์ชื่อ ระบบจึงสร้าง
--        "ผู้เล่น 1–4" ไว้ พอลูกค้าสแกนแล้วลงชื่อ guest_register หาคนที่ชื่อ
--        ตรงกันไม่เจอ เลยสร้างคนที่ 5 ขึ้นมา — โต๊ะโดนคิดค่าเล่นเกินหนึ่งหัว
--        และค่าเล่นของ "ผู้เล่น 1" ไม่มีใครรับ ตอนแยกบิลก็หาเจ้าของไม่ได้
--
-- วิธี: จำว่าใบไหนมีเครื่องลูกค้ามารับไปแล้ว (claimed_at) แล้วให้หน้าลงชื่อ
--       แสดงใบที่ยังไม่มีใครรับให้แตะเลือก "นี่คือฉัน" ได้ พร้อมเปลี่ยนชื่อ
--       จาก "ผู้เล่น 2" เป็นชื่อจริง เรทค่าเล่นที่พนักงานตั้งไว้ (เช่นสมาชิก)
--       ติดไปด้วย ต่างจากลงชื่อใหม่ที่ได้เรทมาตรฐานเสมอ
-- ============================================================================

alter table guest_passes add column if not exists claimed_at timestamptz;

-- ---------------------------------------------------------------------------
-- รับชื่อที่มีอยู่แล้วในโต๊ะ
--
-- p_name ว่าง = ใช้ชื่อเดิม (เช่นพนักงานพิมพ์ชื่อไว้ถูกแล้ว)
-- ใบที่มีคนรับไปแล้วรับซ้ำไม่ได้ — คนเดิมที่ล้างเครื่องไปให้ลงชื่อด้วยชื่อเดิม
-- ซึ่ง guest_register จะคืนใบเดิมให้
-- ---------------------------------------------------------------------------
create or replace function guest_claim(p_token uuid, p_pass_id uuid, p_name text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_name  text;
  v_pass  guest_passes;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  -- ตรวจว่าเป็นคนในโต๊ะของ QR นี้จริง — กันใช้ QR โต๊ะหนึ่งไปรับชื่อคนอีกโต๊ะ
  select * into v_pass
    from guest_passes
   where id = p_pass_id and visit_id = v_visit and status in ('active', 'paused');
  if not found then
    raise exception 'ไม่พบชื่อนี้ในโต๊ะ' using errcode = 'P0002';
  end if;

  v_name := nullif(trim(p_name), '');
  if v_name is not null then
    if length(v_name) > 40 then
      raise exception 'ชื่อยาวเกินไป' using errcode = '22023';
    end if;
    if exists (
      select 1 from guest_passes
       where visit_id = v_visit and id <> p_pass_id
         and status in ('active', 'paused')
         and lower(display_name) = lower(v_name)
    ) then
      raise exception 'ชื่อนี้มีคนใช้ในโต๊ะแล้ว' using errcode = '22023';
    end if;
  end if;

  -- เงื่อนไข claimed_at is null อยู่ใน update เอง สองเครื่องกดพร้อมกันได้แค่เครื่องเดียว
  update guest_passes
     set claimed_at   = now(),
         display_name = coalesce(v_name, display_name)
   where id = p_pass_id and claimed_at is null
  returning * into v_pass;
  if not found then
    raise exception 'ชื่อนี้มีคนรับไปแล้ว — ถ้าเป็นคุณ ให้ลงชื่อด้วยชื่อเดิม'
      using errcode = '22023';
  end if;

  return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- ลงชื่อใหม่ — เหมือนเดิม แต่จดว่าใบนี้มีเจ้าของแล้ว
-- ---------------------------------------------------------------------------
create or replace function guest_register(p_token uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_name  text;
  v_plan  uuid;
  v_pass  guest_passes;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_name := nullif(trim(p_name), '');
  if v_name is null then
    raise exception 'กรุณาใส่ชื่อ' using errcode = '22023';
  end if;
  if length(v_name) > 40 then
    raise exception 'ชื่อยาวเกินไป' using errcode = '22023';
  end if;

  -- ชื่อเดิมในโต๊ะเดิมที่ยังนั่งอยู่ = คนเดิม ไม่ใช่คนใหม่
  update guest_passes
     set claimed_at = coalesce(claimed_at, now())
   where id = (
     select id from guest_passes
      where visit_id = v_visit
        and lower(display_name) = lower(v_name)
        and status in ('active', 'paused')
      limit 1)
  returning * into v_pass;
  if found then
    return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
  end if;

  if (select count(*) from guest_passes where visit_id = v_visit) >= guest_register_limit() then
    raise exception 'โต๊ะนี้มีคนครบแล้ว กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  -- เรทมาตรฐาน = เรทที่เปิดใช้อยู่ตัวแรกตามลำดับที่เจ้าของร้านจัดไว้
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;
  if v_plan is null then
    raise exception 'ร้านยังไม่ได้ตั้งเรทค่าเล่น' using errcode = '22023';
  end if;

  insert into guest_passes (visit_id, display_name, rate_plan_id, claimed_at)
  values (v_visit, v_name, v_plan, now())
  returning * into v_pass;

  return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- รายชื่อในโต๊ะบอกด้วยว่าใบไหนมีคนรับแล้ว หน้าลงชื่อจะได้แสดงเฉพาะใบที่ว่าง
-- (ส่วนอื่นเหมือน migration 1800 ทุกอย่าง)
-- ---------------------------------------------------------------------------
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_visit visits;
  v_table cafe_tables;
  v_codes text;
  v_zone  text;
begin
  select * into v_visit from visits where qr_token = p_token;

  if not found then
    select * into v_table from cafe_tables where qr_token = p_token and not archived;
    if not found then
      raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'tableCode', v_table.code,
      'zone',      v_table.zone,
      'visitId',   null,
      'ended',     false,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  select string_agg(t.code, '+' order by t.sort_order, t.code), min(t.zone)
    into v_codes, v_zone
    from occupancies o join cafe_tables t on t.id = o.table_id
   where o.visit_id = v_visit.id and o.to_at is null;

  if v_codes is null then
    select t.code, t.zone into v_codes, v_zone
      from occupancies o join cafe_tables t on t.id = o.table_id
     where o.visit_id = v_visit.id
     order by o.from_at desc
     limit 1;
  end if;

  if v_visit.status <> 'open' then
    return jsonb_build_object(
      'tableCode', coalesce(v_codes, '—'),
      'zone',      coalesce(v_zone, ''),
      'visitId',   null,
      'ended',     true,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'tableCode', coalesce(v_codes, '—'),
    'zone',      coalesce(v_zone, ''),
    'visitId',   v_visit.id,
    'ended',     false,
    'kitchen',   kitchen_window(),
    'passes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', gp.id, 'displayName', gp.display_name,
               'claimed', gp.claimed_at is not null)
             order by gp.checked_in_at, gp.display_name)
        from guest_passes gp
       where gp.visit_id = v_visit.id
         and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function guest_claim(uuid, uuid, text) from public, anon, authenticated;
grant execute on function guest_claim(uuid, uuid, text) to anon, authenticated;

-- ####################################################################
-- # supabase/migrations/20260930002000_shop_profile.sql
-- ####################################################################

-- ============================================================================
-- ชื่อร้านและโลโก้ — เจ้าของร้านแก้เองได้
--
-- เดิมชื่อ "Boardgame Cafe" ฝังอยู่ในโค้ดหลายจุด (แถบเมนู หน้าล็อกอิน
-- หน้าลูกค้าสแกน QR หน้าจอง ใบ QR ที่พิมพ์) ร้านที่เอาไปใช้ต้องแก้โค้ดเอง
--
-- สิทธิ์: แยกเป็นสิทธิ์ใหม่ 'branding' ให้เฉพาะเจ้าของร้าน ไม่ใช้ 'settings'
-- เพราะผู้จัดการแก้เมนู/ราคาได้ทุกวันเป็นเรื่องปกติ แต่ชื่อและโลโก้คือหน้าตา
-- ของร้านที่ลูกค้าเห็นทุกครั้ง — ทำตามแนวของ migration 1200 ที่ให้ระดับ
-- พนักงานเป็นชุดของสิทธิ์ย่อย แทนการเช็คชื่อ role ตรง ๆ
--
-- ชื่อและโลโก้เป็นข้อมูลสาธารณะ (อยู่บนป้ายหน้าร้านอยู่แล้ว) คนที่ไม่ล็อกอิน
-- จึงอ่านได้ — หน้าจองและหน้าสแกน QR ต้องใช้
-- ============================================================================
-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย

-- ------------------------------------------------------------ สิทธิ์ใหม่ ----
alter table role_capabilities drop constraint if exists role_capabilities_capability_check;
alter table role_capabilities add constraint role_capabilities_capability_check
  check (capability in ('floor', 'kitchen', 'settings', 'accounts', 'branding'));

insert into role_capabilities (role, capability) values ('owner', 'branding')
on conflict do nothing;

create or replace function assert_cap(p_cap text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_cap(p_cap) then
    raise exception '%', case p_cap
      when 'floor'    then 'ต้องมีสิทธิ์ดูแลหน้าร้าน'
      when 'kitchen'  then 'ต้องมีสิทธิ์ดูแลห้องครัว'
      when 'settings' then 'ต้องมีสิทธิ์ตั้งค่าร้าน'
      when 'accounts' then 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน'
      when 'branding' then 'เฉพาะเจ้าของร้านที่แก้ชื่อและโลโก้ร้านได้'
      else 'ไม่มีสิทธิ์ทำรายการนี้'
    end using errcode = '42501';
  end if;
end;
$$;

-- -------------------------------------------------------------- ตาราง ----
-- แถวเดียวทั้งระบบ (id = true เสมอ) เหมือน tax_config
create table if not exists shop_profile (
  id         boolean primary key default true check (id),
  name       text not null default 'Boardgame Cafe'
             check (length(trim(name)) between 1 and 60),
  tagline    text not null default 'โรงเตี๊ยมนักเล่น'
             check (length(tagline) <= 80),
  -- เก็บแค่ path ใน bucket ไม่ใช่ URL เต็ม เหตุผลเดียวกับรูปเมนู (migration 1000)
  logo_path  text check (logo_path is null or logo_path ~ '^logo/[0-9a-zA-Z._-]+$'),
  updated_at timestamptz not null default now()
);

insert into shop_profile (id) values (true) on conflict do nothing;

alter table shop_profile enable row level security;
drop policy if exists public_read_shop_profile on shop_profile;
create policy public_read_shop_profile on shop_profile
  for select to anon, authenticated using (true);

-- อ่านได้ทุกคน แต่แก้ได้ทางเดียวคือผ่าน RPC ด้านล่าง
revoke all on shop_profile from anon, authenticated;
grant select on shop_profile to anon, authenticated;

-- ---------------------------------------------------------------- RPC ----
create or replace function update_shop_profile(p_name text, p_tagline text)
returns shop_profile
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name    text := nullif(trim(p_name), '');
  v_tagline text := coalesce(trim(p_tagline), '');
  v_row     shop_profile;
begin
  perform assert_cap('branding');

  if v_name is null then
    raise exception 'กรุณาใส่ชื่อร้าน' using errcode = '22023';
  end if;
  if length(v_name) > 60 then
    raise exception 'ชื่อร้านยาวเกิน 60 ตัวอักษร' using errcode = '22023';
  end if;
  if length(v_tagline) > 80 then
    raise exception 'คำโปรยยาวเกิน 80 ตัวอักษร' using errcode = '22023';
  end if;

  update shop_profile
     set name = v_name, tagline = v_tagline, updated_at = now()
   where id
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'update_shop_profile', 'shop_profile', null,
          jsonb_build_object('name', v_name, 'tagline', v_tagline));

  return v_row;
end;
$$;

-- ผูก/ถอดโลโก้ — คืน path เดิมให้หน้าจอเอาไปลบไฟล์เก่า (เหมือน set_menu_image)
create or replace function set_shop_logo(p_path text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform assert_cap('branding');

  -- กันไม่ให้ชี้ไปไฟล์นอก bucket ของเรา หรือยัด URL เต็มเข้ามา
  if p_path is not null and p_path !~ '^logo/[0-9a-zA-Z._-]+$' then
    raise exception 'path โลโก้ไม่ถูกต้อง' using errcode = '22023';
  end if;

  select logo_path into v_old from shop_profile where id;
  update shop_profile set logo_path = p_path, updated_at = now() where id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_shop_logo', 'shop_profile', null,
          jsonb_build_object('from', v_old, 'to', p_path));

  return v_old;
end;
$$;

revoke all on function update_shop_profile(text, text) from public, anon, authenticated;
revoke all on function set_shop_logo(text)              from public, anon, authenticated;
grant execute on function update_shop_profile(text, text) to authenticated;
grant execute on function set_shop_logo(text)              to authenticated;

-- ------------------------------------------------------------- Storage ----
-- bucket แยกจากรูปเมนู: รูปเมนูรับแค่ JPEG และผู้จัดการอัปได้ ส่วนโลโก้ต้องเป็น
-- PNG พื้นใสได้ และเฉพาะคนที่มีสิทธิ์ branding
-- ข้ามได้ถ้ารันบน Postgres เปล่าที่ไม่มี Supabase Storage (เช่นตอนทดสอบ)
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'ไม่มี Supabase Storage — ข้ามการตั้งค่า bucket โลโก้';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('shop-assets', 'shop-assets', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
  on conflict (id) do update
    set public = true,
        file_size_limit = 524288,
        allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

  drop policy if exists shop_assets_public_read  on storage.objects;
  drop policy if exists shop_assets_owner_insert on storage.objects;
  drop policy if exists shop_assets_owner_update on storage.objects;
  drop policy if exists shop_assets_owner_delete on storage.objects;

  create policy shop_assets_public_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'shop-assets');

  create policy shop_assets_owner_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'shop-assets' and has_cap('branding'));

  create policy shop_assets_owner_update on storage.objects
    for update to authenticated
    using (bucket_id = 'shop-assets' and has_cap('branding'))
    with check (bucket_id = 'shop-assets' and has_cap('branding'));

  create policy shop_assets_owner_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'shop-assets' and has_cap('branding'));
end;
$$;

-- ####################################################################
-- # supabase/migrations/20260930002100_single_table.sql
-- ####################################################################

-- ============================================================================
-- หนึ่งกลุ่ม = หนึ่งโต๊ะ
--
-- ของเดิมรองรับกลุ่มเดียวนั่งหลายโต๊ะเป็นบิลเดียว ทั้งตอนจอง ตอนเปิดโต๊ะ
-- และตอนย้ายโต๊ะ ร้านตัดสินใจเลิกใช้ ให้เลือกได้ครั้งละโต๊ะเดียวเท่านั้น
--
-- บังคับด้วย trigger ที่ตัวตาราง ไม่ใช่แก้ทีละ RPC เพราะ
--   - มีหลาย RPC ที่พาโต๊ะเข้ามา (open_visit, move_visit_to_tables,
--     seat_reservation) ถ้าไล่แก้ทีละตัวจะลืมง่าย และถ้าวันหน้ามีตัวใหม่
--     ก็หลุดอีก
--   - การเขียนทับตัว RPC เสี่ยงทำของที่เพิ่มมาทีหลังหายไปเงียบ ๆ
--     ซึ่งเคยเกิดมาแล้วในโปรเจกต์นี้
--
-- ข้อมูลเก่าที่มีหลายโต๊ะอยู่แล้วไม่ถูกแตะ — trigger ตรวจเฉพาะของที่เพิ่ม
-- เข้ามาใหม่ ไม่งั้น visit ที่เปิดค้างอยู่จะปิดบิลไม่ได้
-- ============================================================================

-- ---------------------------------------------------------------------------
-- หนึ่ง visit ครองได้ครั้งละหนึ่งโต๊ะ
--
-- ครอบคลุมทุกทางที่พาโต๊ะเข้ามา เพราะทุกทางลงเอยที่ตารางนี้
-- ---------------------------------------------------------------------------
create or replace function assert_one_table_per_visit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from occupancies
     where visit_id = new.visit_id
       and to_at is null
       and id <> new.id
  ) then
    raise exception 'หนึ่งกลุ่มนั่งได้ครั้งละ 1 โต๊ะ ถ้าต้องการย้ายให้ใช้ปุ่มย้ายโต๊ะ'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists occupancies_one_table on occupancies;
create trigger occupancies_one_table
  before insert on occupancies
  for each row execute function assert_one_table_per_visit();

-- ---------------------------------------------------------------------------
-- การจองก็เลือกได้โต๊ะเดียว
--
-- ตรวจตอนเพิ่ม/แก้เท่านั้น รายการเก่าที่จองหลายโต๊ะไว้แล้วยังใช้งานต่อได้
-- จนกว่าจะหมดอายุไปเอง
-- ---------------------------------------------------------------------------
create or replace function assert_one_table_per_reservation() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(cardinality(new.table_ids), 0) > 1 then
    raise exception 'จองได้ครั้งละ 1 โต๊ะ' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_one_table on reservations;
create trigger reservations_one_table
  before insert or update of table_ids on reservations
  for each row execute function assert_one_table_per_reservation();

revoke all on function assert_one_table_per_visit()       from public, anon, authenticated;
revoke all on function assert_one_table_per_reservation()  from public, anon, authenticated;

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

-- ติดตั้งใหม่ = ถือว่าผ่านทุก patch แล้ว กันคนเผลอรัน patch เก่าทับทีหลัง
create table if not exists schema_patches (
  name       text primary key,
  seq        bigint not null,
  applied_at timestamptz not null default now()
);
insert into schema_patches (name, seq) values ('migration-20260930000100', 20260930000100)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000200', 20260930000200)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000300', 20260930000300)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000400', 20260930000400)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000500', 20260930000500)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000600', 20260930000600)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000700', 20260930000700)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000800', 20260930000800)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930000900', 20260930000900)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001000', 20260930001000)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001100', 20260930001100)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001200', 20260930001200)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001300', 20260930001300)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001400', 20260930001400)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001500', 20260930001500)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001600', 20260930001600)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001700', 20260930001700)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001800', 20260930001800)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930001900', 20260930001900)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930002000', 20260930002000)
  on conflict (name) do nothing;
insert into schema_patches (name, seq) values ('migration-20260930002100', 20260930002100)
  on conflict (name) do nothing;
