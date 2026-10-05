-- ============================================================================
-- Boardgame Cafe — patch ลูกค้ารับชื่อที่พนักงานสร้างไว้ตอนเปิดโต๊ะ
--
-- สำหรับฐานข้อมูลที่ติดตั้งเวอร์ชันก่อนหน้าไปแล้ว
-- ถ้าเป็นการติดตั้งใหม่ ใช้ setup-all.sql แทน (รวมไฟล์นี้ไว้แล้ว)
--
-- รันซ้ำได้ แต่รันย้อนลำดับไม่ได้ — ถ้ามี patch ที่ใหม่กว่าติดตั้งไปแล้ว
-- ไฟล์นี้จะหยุดทันทีพร้อมบอกเหตุผล แทนที่จะทับของใหม่ด้วยของเก่าเงียบ ๆ
-- ============================================================================

create table if not exists schema_patches (
  name       text primary key,
  seq        bigint not null,
  applied_at timestamptz not null default now()
);

do $$
declare v_newer text;
begin
  select string_agg(name, ', ' order by seq) into v_newer
    from schema_patches where seq > 20260930001900;

  if v_newer is not null then
    raise exception
      'ฐานข้อมูลนี้ติดตั้ง % ซึ่งใหม่กว่า patch-claim-pass ไปแล้ว การรันไฟล์นี้จะทับของใหม่ด้วยของเก่า — ไม่ต้องรัน', v_newer
      using errcode = '55000';
  end if;
end;
$$;

-- ###### supabase/migrations/20260930001900_claim_pass.sql

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

-- จดว่า patch นี้ติดตั้งแล้ว
insert into schema_patches (name, seq) values ('patch-claim-pass', 20260930001900)
  on conflict (name) do update set applied_at = now();
