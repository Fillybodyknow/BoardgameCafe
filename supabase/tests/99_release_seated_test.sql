-- ============================================================================
-- ปิดบิลแล้วการจองต้องเลิกล็อกโต๊ะ
--
-- คำถามที่ไฟล์นี้ตอบ: "ลูกค้าที่จองไว้เล่นเสร็จแล้วกลับไป โต๊ะกลับมารับจองได้ไหม"
--
-- อาการเดิม: การจองค้างสถานะ 'seated' ตลอดไป โต๊ะจึงถูกล็อกจนจบช่วงเวลา
-- ที่จองไว้ ทั้งที่คนกลับไปแล้วและปิดบิลเรียบร้อย
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-0000000000d3', 'release@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-0000000000d3', 'พนักงานปิดบิล', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-0000000000d3';

insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
values ('d3000000-0000-4000-8000-0000000000a1', 'RL1', 'ทดสอบปิดบิล', 1, 6, false, 99);

do $$
declare
  v_plan  uuid;
  v_table uuid := 'd3000000-0000-4000-8000-0000000000a1';
  v_start timestamptz;
  v_res   jsonb;
  v_id    uuid;
  v_visit visits;
begin
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;

  update shop_hours set open_time = '00:00', close_time = '23:59',
                        kitchen_close_time = null, closed = false;

  v_start := date_trunc('hour', now()) + interval '1 day' + interval '14 hours';

  v_res := create_reservation('คุณจองไว้', '0855550001', 2, v_start, 120, array[v_table], null);
  select id into v_id from reservations where code = v_res ->> 'code';

  perform assert_eq('จองแล้วโต๊ะถูกล็อก',
    table_available(v_table, v_start, v_start + interval '2 hours'), false);

  perform confirm_reservation(v_id);
  perform assert_eq('อนุมัติแล้วก็ยังล็อก',
    table_available(v_table, v_start, v_start + interval '2 hours'), false);

  -- เช็คอิน — ระหว่างนั่งอยู่ต้องยังล็อก
  v_visit := seat_reservation(v_id, jsonb_build_array(
    jsonb_build_object('name', 'คุณจองไว้', 'ratePlanId', v_plan)), array[v_table]);
  perform assert_eq('การจองเปลี่ยนเป็นเช็คอินแล้ว',
    (select status from reservations where id = v_id), 'seated'::reservation_status);
  perform assert_eq('ระหว่างนั่งอยู่ยังล็อก',
    table_available(v_table, v_start, v_start + interval '2 hours'), false);

  -- ★ ปิดบิลแล้วต้องเลิกล็อก
  perform close_visit(v_visit.id, '[]'::jsonb);
  perform assert_eq('ปิดบิลแล้วรับจองช่วงเดิมได้',
    table_available(v_table, v_start, v_start + interval '2 hours'), true);

  -- ★ ล็อกทั้งวัน (migration 2600) ปิดบิลแล้วต้องปล่อยทั้งวันเหมือนกัน
  perform assert_eq('ปิดบิลแล้วช่วงค่ำวันเดียวกันก็ว่างด้วย',
    table_available(v_table, v_start + interval '5 hours',
                    v_start + interval '7 hours'), true);

  -- และจองจริงได้ ไม่ใช่แค่ขึ้นว่าว่าง
  perform assert_eq('จองซ้ำช่วงเดิมได้จริง',
    create_reservation('คุณมาใหม่', '0855550002', 2, v_start, 120, array[v_table], null)
      ->> 'status',
    'pending');
end $$;

-- ---------------------------------------------------------------------------
-- รายการที่ยังไม่ได้เช็คอินต้องล็อกต่อ ไม่ใช่ปล่อยเพราะไม่มี visit
-- ---------------------------------------------------------------------------
do $$
declare
  v_table uuid;
  v_start timestamptz;
begin
  insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
  values ('d3000000-0000-4000-8000-0000000000a2', 'RL2', 'ทดสอบปิดบิล', 1, 6, false, 100);
  v_table := 'd3000000-0000-4000-8000-0000000000a2';

  v_start := date_trunc('hour', now()) + interval '2 days' + interval '14 hours';

  perform create_reservation('คุณรอยืนยัน', '0855550003', 2, v_start, 120, array[v_table], null);
  perform assert_eq('รายการที่รอยืนยันยังล็อกอยู่',
    table_available(v_table, v_start, v_start + interval '2 hours'), false);
  perform assert_eq('และล็อกข้ามไปทั้งวัน',
    table_available(v_table, v_start + interval '6 hours',
                    v_start + interval '8 hours'), false);
  perform assert_eq('แต่วันถัดไปยังว่าง',
    table_available(v_table, v_start + interval '1 day',
                    v_start + interval '1 day 2 hours'), true);
end $$;

-- ---------------------------------------------------------------------------
-- ยกเลิก / ไม่มา ก็ต้องปล่อยโต๊ะ (พฤติกรรมเดิม ใส่ไว้กันพลาดตอนแก้ภายหลัง)
-- ---------------------------------------------------------------------------
do $$
declare
  v_table uuid;
  v_start timestamptz;
  v_res   jsonb;
  v_id    uuid;
begin
  insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
  values ('d3000000-0000-4000-8000-0000000000a3', 'RL3', 'ทดสอบปิดบิล', 1, 6, false, 101);
  v_table := 'd3000000-0000-4000-8000-0000000000a3';

  v_start := date_trunc('hour', now()) + interval '3 days' + interval '14 hours';

  v_res := create_reservation('คุณยกเลิก', '0855550004', 2, v_start, 120, array[v_table], null);
  select id into v_id from reservations where code = v_res ->> 'code';

  perform reject_reservation(v_id, 'ทดสอบ');
  perform assert_eq('ปฏิเสธแล้วโต๊ะกลับมาว่าง',
    table_available(v_table, v_start, v_start + interval '2 hours'), true);
end $$;

select '=== ปิดบิลแล้วเลิกล็อกโต๊ะผ่านทั้งหมด ===' as result;
