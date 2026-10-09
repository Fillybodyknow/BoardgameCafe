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
