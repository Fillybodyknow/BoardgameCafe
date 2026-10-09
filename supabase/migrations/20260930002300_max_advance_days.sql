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
