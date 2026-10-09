-- ============================================================================
-- จองแล้วล็อกโต๊ะทั้งวัน จนกว่าจะปิดบิล
--
-- ของเดิมล็อกเฉพาะช่วงเวลาที่จอง + เผื่อหัวท้าย 15 นาที ซึ่งเหมาะกับร้าน
-- ที่หมุนรอบเร็ว แต่คาเฟ่บอร์ดเกมคนนั่งยาวและมักเลยเวลาที่จองไว้
-- ถ้าปล่อยให้คนอื่นจองต่อท้าย สุดท้ายกลายเป็นไล่ลูกค้ากลุ่มแรก
--
-- กติกาใหม่: จองโต๊ะไหนวันไหน = โต๊ะนั้นเต็มทั้งวัน
--            ยกเว้นเช็คอินแล้วปิดบิลไปแล้ว ถือว่าเลิกล็อก ปล่อยให้จองต่อได้
--
-- ผลที่ตามมาซึ่งต้องรู้: หนึ่งโต๊ะรับจองได้วันละหนึ่งกลุ่มเท่านั้น
-- จำนวนรอบที่รับจองได้ต่อวันจึงเท่ากับจำนวนโต๊ะ
--
-- เทียบวันตามเวลาไทย ไม่ใช่ UTC — ไม่งั้นการจองรอบค่ำจะถูกนับเป็นวันถัดไป
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

  -- มีคนจองโต๊ะนี้ในวันเดียวกันแล้วหรือยัง
  if exists (
    select 1 from reservations r
     where r.status in ('pending', 'confirmed', 'seated')
       and p_table_id = any(r.table_ids)
       and (p_exclude_reservation is null or r.id <> p_exclude_reservation)
       -- รายการที่เช็คอินแล้วจะล็อกต่อ *เฉพาะตอนที่ยังนั่งอยู่จริง*
       -- ปิดบิลแล้วถือว่าเลิกล็อก ปล่อยให้คนอื่นจองวันนั้นได้
       and (
         r.status in ('pending', 'confirmed')
         or exists (select 1 from visits v where v.id = r.visit_id and v.status = 'open')
       )
       -- ทั้งวันตามปฏิทินไทย ไม่ใช่แค่ช่วงเวลาที่จองไว้
       and (r.start_at at time zone 'Asia/Bangkok')::date
           = (p_start at time zone 'Asia/Bangkok')::date
  ) then
    return false;
  end if;

  -- โต๊ะที่มีลูกค้านั่งอยู่ตอนนี้ ก็ไม่รับจองในช่วงใกล้ ๆ เหมือนกัน
  -- (ลูกค้าที่เดินเข้ามาเอง ไม่ได้จองมา จึงใช้กติกาคนละชุดกับด้านบน)
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
