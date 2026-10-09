-- ============================================================================
-- ปิดบิลแล้วการจองต้องเลิกล็อกโต๊ะ
--
-- อาการที่เจอหน้างาน: เช็คอินลูกค้าที่จองไว้ → เล่นเสร็จ → ปิดบิล → โต๊ะว่าง
-- แล้ว แต่หน้าจองยังขึ้นว่า "ไม่ว่าง" ไปจนจบช่วงเวลาที่จองไว้
--
-- สาเหตุ: seat_reservation ตั้งสถานะเป็น 'seated' แล้วไม่มีอะไรเปลี่ยนต่อ
-- ส่วน close_visit ก็ไม่เคยแตะตาราง reservations เลย การจองจึงค้างสถานะ
-- 'seated' ตลอดไป และ table_available นับ 'seated' เป็นตัวบล็อก
--
-- ไม่เพิ่มสถานะใหม่ใน enum เพราะความจริงที่ต้องการไม่ใช่ "การจองจบแล้ว"
-- แต่เป็น "รอบที่นั่งอยู่ยังเปิดอยู่ไหม" ซึ่งตาราง visits ตอบอยู่แล้ว
-- ถามจากของที่รู้คำตอบจริงดีกว่าคัดลอกสถานะไปเก็บอีกที่แล้วต้องคอยซิงก์
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
       -- รายการที่เช็คอินแล้วจะล็อกโต๊ะต่อ *เฉพาะตอนที่ยังนั่งอยู่จริง*
       -- ปิดบิลแล้วถือว่าเลิกล็อก ปล่อยให้คนอื่นจองช่วงที่เหลือได้
       and (
         r.status in ('pending', 'confirmed')
         or exists (select 1 from visits v where v.id = r.visit_id and v.status = 'open')
       )
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
