-- ============================================================================
-- ทดสอบเวลาปิดครัว
--
-- คำถามที่ไฟล์นี้ตอบ: "สี่ทุ่มแล้วลูกค้ายังสั่งอาหารเข้าครัวที่ไม่มีคนได้ไหม"
--
-- เวลาเป็นเรื่องที่ทดสอบพลาดง่าย เพราะผลลัพธ์เปลี่ยนตามตอนที่รัน จึงยิง
-- kitchen_window ด้วยเวลาที่กำหนดเองแทนการพึ่ง now() และคุมวันด้วยการ
-- ตั้งเวลาทำการของ "ทุกวัน" ให้เหมือนกัน เทสต์จะได้ไม่พังเฉพาะบางวัน
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000096', 'kitchen@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000096', 'ผู้จัดการครัว', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-000000000096';

-- ร้าน 11:00–23:00 ครัวปิด 22:00 ทุกวัน
update shop_hours set open_time = '11:00', close_time = '23:00',
                      kitchen_close_time = '22:00', closed = false;

insert into menu_items (id, sku, name, category, price, available, sort_order)
values
  ('96000000-0000-4000-8000-000000000001', 'K-F', 'ข้าวผัด',   'food',   120, true, 90),
  ('96000000-0000-4000-8000-000000000002', 'K-D', 'ชาเย็น',    'drink',   55, true, 91),
  ('96000000-0000-4000-8000-000000000003', 'K-S', 'ขนมถุง',    'snack',   30, true, 92);

-- ---------------------------------------------------------------------------
-- หน้าต่างเวลาของครัว
-- ---------------------------------------------------------------------------
do $$
declare
  v_food  jsonb := jsonb_build_array(jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000001', 'qty', 1));
  v_drink jsonb := jsonb_build_array(jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000002', 'qty', 1));
  v_mixed jsonb := jsonb_build_array(
    jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000002', 'qty', 1),
    jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000001', 'qty', 1));
begin
  perform assert_eq('บ่ายสามครัวเปิด',
    (kitchen_window('2026-10-05 15:00+07') ->> 'open')::boolean, true);
  perform assert_eq('สี่ทุ่มตรงครัวปิดแล้ว',
    (kitchen_window('2026-10-05 22:00+07') ->> 'open')::boolean, false);
  perform assert_eq('สี่ทุ่มครึ่งก็ยังปิด',
    (kitchen_window('2026-10-05 22:30+07') ->> 'open')::boolean, false);
  perform assert_eq('ข้อความบอกเวลาปิดครัว ไม่ใช่เวลาปิดร้าน',
    kitchen_window('2026-10-05 22:30+07') ->> 'reason', 'ครัวปิดแล้ว (22:00 น.)');
  perform assert_eq('ก่อนร้านเปิดก็ถือว่าครัวยังไม่เปิด',
    (kitchen_window('2026-10-05 09:00+07') ->> 'open')::boolean, false);

  -- ตีครึ่งคืนต้องไม่ถูกนับว่า "ยังไม่ถึง 22:00 เลยเปิดอยู่"
  perform assert_eq('หลังเที่ยงคืนครัวปิด',
    (kitchen_window('2026-10-06 00:30+07') ->> 'open')::boolean, false);

  perform assert_eq('ตะกร้ามีอาหารจานหลัก = ต้องใช้ครัว', needs_kitchen(v_food), true);
  perform assert_eq('ตะกร้ามีแต่เครื่องดื่ม = ไม่ต้องใช้ครัว', needs_kitchen(v_drink), false);
  perform assert_eq('ปนกันถือว่าต้องใช้ครัว', needs_kitchen(v_mixed), true);
end $$;

-- ---------------------------------------------------------------------------
-- ไม่ตั้งเวลาปิดครัว = ปิดพร้อมร้าน (พฤติกรรมเดิมก่อนมีฟีเจอร์นี้)
-- ---------------------------------------------------------------------------
do $$
begin
  update shop_hours set kitchen_close_time = null;
  perform assert_eq('ไม่ตั้งไว้ สี่ทุ่มครึ่งครัวยังเปิด',
    (kitchen_window('2026-10-05 22:30+07') ->> 'open')::boolean, true);
  perform assert_eq('แต่ห้าทุ่มก็ปิดตามร้าน',
    (kitchen_window('2026-10-05 23:10+07') ->> 'open')::boolean, false);

  update shop_hours set closed = true;
  perform assert_eq('วันที่ร้านปิด ครัวปิดด้วย',
    (kitchen_window('2026-10-05 15:00+07') ->> 'open')::boolean, false);

  update shop_hours set closed = false, kitchen_close_time = '22:00';
end $$;

-- ---------------------------------------------------------------------------
-- ค่าที่ตั้งได้
-- ---------------------------------------------------------------------------
do $$
declare v_row shop_hours;
begin
  v_row := upsert_shop_hours(1::smallint, '11:00', '23:00', false, '21:30');
  perform assert_eq('บันทึกเวลาปิดครัวได้', v_row.kitchen_close_time, '21:30'::time);

  v_row := upsert_shop_hours(1::smallint, '11:00', '23:00', false, null);
  perform assert_eq('ล้างค่าเพื่อให้ปิดพร้อมร้านได้', v_row.kitchen_close_time is null, true);

  begin
    perform upsert_shop_hours(1::smallint, '11:00', '23:00', false, '23:30');
    raise exception 'FAIL  ครัวปิดหลังร้านไม่ควรตั้งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ครัวปิดหลังร้านตั้งไม่ได้';
  end;

  begin
    perform upsert_shop_hours(1::smallint, '11:00', '23:00', false, '10:00');
    raise exception 'FAIL  ครัวปิดก่อนร้านเปิดไม่ควรตั้งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ครัวปิดก่อนร้านเปิดตั้งไม่ได้';
  end;

  -- คืนค่าให้วันจันทร์เหมือนวันอื่น เทสต์ถัดไปจะได้ไม่เพี้ยนตามวันที่รัน
  perform upsert_shop_hours(1::smallint, '11:00', '23:00', false, '22:00');
end $$;

-- ---------------------------------------------------------------------------
-- ด่านตอนสั่งของจริง
--
-- เวลาปิดครัวอิง now() จึงตั้งเวลาทำการให้ "ตอนนี้" อยู่นอกเวลาครัวแทน
-- ---------------------------------------------------------------------------
do $$
declare
  v_plan  uuid;
  v_table uuid;
  v_visit visits;
  v_token uuid;
  v_food  jsonb := jsonb_build_array(jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000001', 'qty', 1));
  v_drink jsonb := jsonb_build_array(jsonb_build_object('menuItemId', '96000000-0000-4000-8000-000000000002', 'qty', 1));
  v_order orders;
  v_res   jsonb;
begin
  select id into v_plan from rate_plans where active limit 1;

  insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
  values ('96000000-0000-4000-8000-0000000000a1', 'K1', 'ทดสอบครัว', 1, 6, false, 96);
  v_table := '96000000-0000-4000-8000-0000000000a1';
  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ลูกค้าดึก', 'ratePlanId', v_plan)));
  v_token := v_visit.qr_token;

  -- บังคับให้ "ตอนนี้" อยู่หลังครัวปิด โดยให้ครัวปิดตั้งแต่เปิดร้านหนึ่งนาที
  update shop_hours set open_time = '00:00', close_time = '23:59', kitchen_close_time = '00:01';

  begin
    perform guest_place_order(v_token, null, 'shared', v_food, 'k-guest-food');
    raise exception 'FAIL  ลูกค้าไม่ควรสั่งอาหารหลังครัวปิดได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ลูกค้าสั่งอาหารหลังครัวปิดไม่ได้';
  end;

  v_res := guest_place_order(v_token, null, 'shared', v_drink, 'k-guest-drink');
  perform assert_eq('แต่เครื่องดื่มยังสั่งได้', v_res ->> 'status', 'placed');

  begin
    perform place_order('k-staff-food', v_visit.id, null, 'shared', 'staff', v_food);
    raise exception 'FAIL  พนักงานไม่ควรสั่งผ่านโดยไม่ยืนยัน';
  exception when sqlstate '22023' then
    raise notice 'PASS  พนักงานสั่งอาหารหลังครัวปิดต้องยืนยันก่อน';
  end;

  -- ★ ยืนยันแล้วต้องผ่าน ไม่งั้นพนักงานช่วยลูกค้าที่รับปากไว้แล้วไม่ได้
  v_order := place_order('k-staff-food-ok', v_visit.id, null, 'shared', 'staff', v_food, true);
  perform assert_eq('ยืนยันแล้วพนักงานสั่งได้', v_order.status, 'placed'::order_status);

  perform assert_eq('ลูกค้าเห็นสถานะครัวตั้งแต่เปิดเมนู',
    (guest_session(v_token) -> 'kitchen' ->> 'open')::boolean, false);

  update shop_hours set open_time = '11:00', close_time = '23:00', kitchen_close_time = '22:00';
end $$;

-- ---------------------------------------------------------------------------
-- สิทธิ์
-- ---------------------------------------------------------------------------
do $$
begin
  perform assert_eq('anon เรียก kitchen_window ตรง ๆ ไม่ได้',
    has_function_privilege('anon', 'kitchen_window(timestamptz)', 'execute'), false);
  perform assert_eq('anon ตั้งเวลาทำการไม่ได้',
    has_function_privilege('anon', 'upsert_shop_hours(smallint, time, time, boolean, time)', 'execute'),
    false);
  -- ของเดิมที่ไม่มีด่านครัวต้องไม่เหลือไว้ให้เรียก
  perform assert_eq('place_order แบบเก่าถูกถอดออกแล้ว',
    to_regprocedure('place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb)') is null,
    true);
end $$;

select '=== เวลาปิดครัวผ่านทั้งหมด ===' as result;
