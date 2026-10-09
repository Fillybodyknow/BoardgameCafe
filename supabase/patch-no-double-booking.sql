-- ============================================================================
-- Boardgame Cafe — patch ห้ามจองซ้อนทุกกรณี
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
    from schema_patches where seq > 20260930002400;

  if v_newer is not null then
    raise exception
      'ฐานข้อมูลนี้ติดตั้ง % ซึ่งใหม่กว่า patch-no-double-booking ไปแล้ว การรันไฟล์นี้จะทับของใหม่ด้วยของเก่า — ไม่ต้องรัน', v_newer
      using errcode = '55000';
  end if;
end;
$$;

-- ###### supabase/migrations/20260930002400_no_double_booking.sql

-- ============================================================================
-- ห้ามจองซ้อนทุกกรณี แม้เป็นโต๊ะที่นั่งร่วมได้
--
-- ของเดิมโต๊ะที่ติ๊ก "ให้คนละกลุ่มนั่งร่วมกันได้" จะไม่ถูกตรวจการจองซ้อนเลย
-- เพราะคิดถึงโต๊ะยาว/เคาน์เตอร์ที่คนละกลุ่มนั่งคนละฝั่งได้
--
-- ปัญหาที่เจอหน้างาน: ร้านติ๊กช่องนี้ไว้ทุกโต๊ะ ผลคือรับจองเวลาเดียวกัน
-- ได้ไม่จำกัด และหน้าจองของลูกค้าไม่มีวันขึ้นป้าย "ไม่ว่าง" เลย ลูกค้าสอง
-- กลุ่มจองโต๊ะเดียวกัน 14:00 ได้ทั้งคู่ ซึ่งไม่ใช่สิ่งที่ร้านต้องการ
--
-- ต่อไป allow_share จะมีผลกับ "ลูกค้าเดินเข้ามานั่ง" อย่างเดียว (ผ่าน
-- occupancies.exclusive) ไม่มีผลกับการจองล่วงหน้าอีกต่อไป — จองแล้วคือ
-- ล็อกโต๊ะนั้นทั้งช่วงเวลา
-- ============================================================================

create or replace function table_available(
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

  -- จองซ้อนไม่ได้ ไม่ว่าโต๊ะนั้นจะนั่งร่วมกันได้หรือไม่
  if exists (
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

  -- โต๊ะที่มีลูกค้านั่งอยู่ตอนนี้ ก็ไม่รับจองในช่วงใกล้ ๆ เหมือนกัน
  -- ไม่รู้ว่ากลุ่มที่นั่งอยู่จะลุกเมื่อไหร่ จะรับจองไว้ก็เท่ากับสัญญาสิ่งที่
  -- ยังไม่แน่
  if p_start < now() + make_interval(mins => v_cfg.occupied_hold_minutes)
     and exists (
       select 1 from occupancies o
        where o.table_id = p_table_id and o.to_at is null
     ) then
    return false;
  end if;

  return true;
end;
$$;

-- จดว่า patch นี้ติดตั้งแล้ว
insert into schema_patches (name, seq) values ('patch-no-double-booking', 20260930002400)
  on conflict (name) do update set applied_at = now();
