-- ============================================================================
-- Boardgame Cafe — patch หน้าตั้งค่าเจ้าของร้าน
--
-- สำหรับฐานข้อมูลที่ติดตั้งเวอร์ชันก่อนหน้าไปแล้ว
-- ถ้าเป็นการติดตั้งใหม่ ใช้ setup-all.sql แทน (รวมไฟล์นี้ไว้แล้ว)
-- ============================================================================

-- ###### supabase/migrations/20260930000900_owner_settings.sql

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
