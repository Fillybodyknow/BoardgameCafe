-- ============================================================================
-- Boardgame Cafe — patch ตั้งจำนวนวันจองล่วงหน้า
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
    from schema_patches where seq > 20260930002300;

  if v_newer is not null then
    raise exception
      'ฐานข้อมูลนี้ติดตั้ง % ซึ่งใหม่กว่า patch-max-advance ไปแล้ว การรันไฟล์นี้จะทับของใหม่ด้วยของเก่า — ไม่ต้องรัน', v_newer
      using errcode = '55000';
  end if;
end;
$$;

-- ###### supabase/migrations/20260930002300_max_advance_days.sql

-- ============================================================================
-- จองล่วงหน้าได้กี่วัน — ตั้งได้จากหน้าตั้งค่า
--
-- ค่านี้อยู่ใน reservation_config มาตั้งแต่แรกและ assert_bookable ใช้งานจริง
-- แต่ไม่มีทางแก้จากหน้าจอ ต้องเข้าไปแก้ในฐานข้อมูลเอง ซึ่งเจ้าของร้านทำไม่ได้
--
-- ทำเป็นฟังก์ชันเฉพาะค่านี้ค่าเดียว ไม่ใช่ฟังก์ชันรวมที่รับทุกคอลัมน์
-- เพราะค่าอื่นในตารางนี้ยังไม่มีหน้าจอให้แก้ ถ้าเขียนฟังก์ชันรวมไว้ก่อน
-- จะกลายเป็นช่องให้แก้ค่าที่ยังไม่ได้ออกแบบ UI รองรับ
-- ============================================================================

create or replace function set_max_advance_days(p_days int)
returns reservation_config
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row reservation_config;
begin
  perform assert_manager();

  -- 1 วัน = รับจองแค่ข้ามคืน, 365 = หนึ่งปี เกินกว่านี้ไม่มีความหมายกับคาเฟ่
  if p_days < 1 or p_days > 365 then
    raise exception 'จองล่วงหน้าได้ระหว่าง 1 ถึง 365 วัน' using errcode = '22023';
  end if;

  update reservation_config set max_advance_days = p_days where id = 1
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_max_advance_days', 'reservation_config', null,
          jsonb_build_object('days', p_days));

  return v_row;
end;
$$;

revoke all on function set_max_advance_days(int) from public, anon, authenticated;
grant execute on function set_max_advance_days(int) to authenticated;

-- จดว่า patch นี้ติดตั้งแล้ว
insert into schema_patches (name, seq) values ('patch-max-advance', 20260930002300)
  on conflict (name) do update set applied_at = now();
