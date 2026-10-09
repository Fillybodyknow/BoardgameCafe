-- ============================================================================
-- ตั้งจำนวนวันที่จองล่วงหน้าได้
--
-- คำถามที่ไฟล์นี้ตอบ: "แก้ค่าแล้วมีผลกับการจองจริงไหม หรือแค่เก็บเลขไว้เฉย ๆ"
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';  -- manager

do $$
declare
  v_row   reservation_config;
  v_table uuid;
  v_far   timestamptz;
begin
  select id into v_table from cafe_tables where code = 'A1';

  -- เวลาทำการกว้างไว้ เทสต์จะได้ไม่ล้มเพราะชนเวลาเปิด-ปิดร้าน
  update shop_hours set open_time = '00:00', close_time = '23:59',
                        kitchen_close_time = null, closed = false;

  v_row := set_max_advance_days(7);
  perform assert_eq('บันทึกค่าแล้ว', v_row.max_advance_days, 7);

  -- ★ ต้องมีผลกับการจองจริง ไม่ใช่แค่เก็บเลข
  v_far := date_trunc('hour', now()) + interval '10 days' + interval '14 hours';
  begin
    perform create_reservation('คุณจองไกล', '0899990001', 2, v_far, 120, array[v_table], null);
    raise exception 'FAIL  เกินเพดานแล้วไม่ควรจองได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองเกินเพดานที่ตั้งไว้ไม่ได้';
  end;

  -- ขยายเพดานแล้วต้องจองได้
  v_row := set_max_advance_days(30);
  perform assert_eq('ขยายเพดานได้', v_row.max_advance_days, 30);
  perform assert_eq('ขยายแล้วจองวันเดิมได้',
    create_reservation('คุณจองไกล', '0899990001', 2, v_far, 120, array[v_table], null)
      ->> 'status',
    'pending');

  -- ค่าที่เป็นไปไม่ได้
  begin
    perform set_max_advance_days(0);
    raise exception 'FAIL  0 วันไม่ควรตั้งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ตั้ง 0 วันไม่ได้';
  end;

  begin
    perform set_max_advance_days(400);
    raise exception 'FAIL  400 วันไม่ควรตั้งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ตั้งเกินหนึ่งปีไม่ได้';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- สิทธิ์ — พนักงานหน้าร้านและลูกค้าแก้ไม่ได้
-- ---------------------------------------------------------------------------
do $$
begin
  set local "test.user_id" = '99999999-0000-4000-8000-0000000000d2';  -- floor

  begin
    perform set_max_advance_days(90);
    raise exception 'FAIL  พนักงานหน้าร้านไม่ควรแก้ได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานหน้าร้านแก้ไม่ได้';
  end;
end $$;

do $$
begin
  perform assert_eq('ลูกค้าแก้ไม่ได้',
    has_function_privilege('anon', 'set_max_advance_days(int)', 'execute'), false);
  perform assert_eq('แต่ลูกค้าอ่านค่าได้ (หน้าจองต้องใช้สร้างปฏิทิน)',
    has_table_privilege('anon', 'reservation_config', 'select'), true);
end $$;

select '=== ตั้งจำนวนวันจองล่วงหน้าผ่านทั้งหมด ===' as result;
