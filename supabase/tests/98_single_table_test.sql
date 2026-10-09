-- ============================================================================
-- ทดสอบกติกา "หนึ่งกลุ่ม = หนึ่งโต๊ะ"
--
-- คำถามที่ไฟล์นี้ตอบ: "ยังมีทางไหนที่พากลุ่มเดียวไปนั่งสองโต๊ะได้อีกไหม"
--
-- บังคับที่ตัวตารางด้วย trigger ไม่ใช่ที่ RPC จึงต้องไล่ทดสอบทุกทางที่พา
-- โต๊ะเข้ามา — เปิดโต๊ะ ย้ายโต๊ะ และเช็คอินจากการจอง
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000098', 'onetable@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000098', 'พนักงานโต๊ะเดียว', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-000000000098';

insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
values
  ('98000000-0000-4000-8000-0000000000a1', 'O1', 'ทดสอบโต๊ะเดียว', 1, 6, false, 98),
  ('98000000-0000-4000-8000-0000000000a2', 'O2', 'ทดสอบโต๊ะเดียว', 1, 6, false, 99),
  ('98000000-0000-4000-8000-0000000000a3', 'O3', 'ทดสอบโต๊ะเดียว', 1, 6, false, 100);

do $$
declare
  v_plan  uuid;
  v_t1    uuid := '98000000-0000-4000-8000-0000000000a1';
  v_t2    uuid := '98000000-0000-4000-8000-0000000000a2';
  v_t3    uuid := '98000000-0000-4000-8000-0000000000a3';
  v_visit visits;
begin
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;

  -- เปิดโต๊ะทีเดียวสองโต๊ะไม่ได้
  begin
    perform open_visit(array[v_t1, v_t2], jsonb_build_array(
      jsonb_build_object('name', 'กลุ่มใหญ่', 'ratePlanId', v_plan)));
    raise exception 'FAIL  ไม่ควรเปิดกลุ่มเดียวสองโต๊ะได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เปิดกลุ่มเดียวสองโต๊ะไม่ได้';
  end;

  -- โต๊ะเดียวยังเปิดได้ตามปกติ
  v_visit := open_visit(array[v_t1], jsonb_build_array(
    jsonb_build_object('name', 'กลุ่มเล็ก', 'ratePlanId', v_plan)));
  perform assert_eq('เปิดโต๊ะเดียวได้',
    (select count(*) from occupancies where visit_id = v_visit.id and to_at is null), 1::bigint);

  -- ย้ายไปสองโต๊ะไม่ได้
  begin
    perform move_visit_to_tables(v_visit.id, array[v_t2, v_t3]);
    raise exception 'FAIL  ไม่ควรย้ายไปสองโต๊ะได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ย้ายไปสองโต๊ะไม่ได้';
  end;

  -- ★ ย้ายโต๊ะเดียวต้องยังทำได้ ไม่งั้นกติกาใหม่จะทำฟีเจอร์เดิมพัง
  perform move_visit_to_tables(v_visit.id, array[v_t2]);
  perform assert_eq('ย้ายโต๊ะเดียวยังทำได้',
    (select t.code from occupancies o join cafe_tables t on t.id = o.table_id
      where o.visit_id = v_visit.id and o.to_at is null), 'O2');
  perform assert_eq('ยังครองแค่โต๊ะเดียว',
    (select count(*) from occupancies where visit_id = v_visit.id and to_at is null), 1::bigint);

  -- แทรกตรงเข้าตารางก็ไม่รอด เพราะด่านอยู่ที่ตาราง ไม่ใช่ที่ RPC
  begin
    insert into occupancies (visit_id, table_id, exclusive) values (v_visit.id, v_t3, true);
    raise exception 'FAIL  แทรก occupancy ที่สองไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  แทรกโต๊ะที่สองตรง ๆ ก็ไม่ผ่าน';
  end;

  perform close_visit(v_visit.id, '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- การจอง
-- ---------------------------------------------------------------------------
do $$
declare
  v_t1   uuid := '98000000-0000-4000-8000-0000000000a1';
  v_t2   uuid := '98000000-0000-4000-8000-0000000000a2';
  v_when timestamptz := date_trunc('hour', now() at time zone 'Asia/Bangkok')
                        + interval '1 day' + interval '12 hours';
  v_res  jsonb;
begin
  -- ให้เวลาทำการกว้างพอ เทสต์จะได้ไม่ล้มเพราะชนเวลาเปิด-ปิดร้าน
  update shop_hours set open_time = '00:00', close_time = '23:59',
                        kitchen_close_time = null, closed = false;

  begin
    perform create_reservation('คุณจองสองโต๊ะ', '0812345678', 4,
      v_when at time zone 'Asia/Bangkok', 120, array[v_t1, v_t2], null);
    raise exception 'FAIL  ไม่ควรจองสองโต๊ะได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองสองโต๊ะไม่ได้';
  end;

  v_res := create_reservation('คุณจองโต๊ะเดียว', '0812345679', 4,
    v_when at time zone 'Asia/Bangkok', 120, array[v_t1], null);
  perform assert_eq('จองโต๊ะเดียวยังได้', v_res ->> 'status', 'pending');
end $$;

select '=== หนึ่งกลุ่มหนึ่งโต๊ะผ่านทั้งหมด ===' as result;
