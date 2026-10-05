-- ============================================================================
-- ทดสอบการจ่ายตอนกลับก่อน
--
-- คำถามที่ไฟล์นี้ตอบ: "ถ้าคนในกลุ่มทยอยจ่ายทีละคน เงินจะหายหรือเก็บซ้ำไหม"
--
-- ใช้เรทราคาชั่วโมงละ 0 บาทโดยตั้งใจ เพื่อให้ตัวเลขทุกตัวมาจากค่าอาหารล้วน ๆ
-- ถ้าเอาค่าเล่นมาปนด้วย เวลาเทสต์ล้มจะแยกไม่ออกว่าพังเพราะสูตรหารหรือเพราะ
-- นาฬิกาเดินไปหนึ่งนาทีระหว่างรัน
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000095', 'settle@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000095', 'พนักงานเก็บเงิน', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-000000000095';

insert into rate_plans (id, name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap, active, sort_order)
values ('95000000-0000-4000-8000-000000000001', 'ทดสอบ ฟรี', 0, 1, 0, null, true, 99);

-- โต๊ะของตัวเอง — ไฟล์เทสต์ใช้ฐานข้อมูลร่วมกัน โต๊ะ seed ถูกจองไปแล้ว
insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
values
  ('95000000-0000-4000-8000-0000000000a1', 'S1', 'ทดสอบ', 1, 6, false, 95),
  ('95000000-0000-4000-8000-0000000000a2', 'S2', 'ทดสอบ', 1, 6, false, 96),
  ('95000000-0000-4000-8000-0000000000a3', 'S3', 'ทดสอบ', 1, 6, false, 97);

insert into menu_items (id, sku, name, category, price, available, sort_order)
values
  ('95000000-0000-4000-8000-000000000011', 'T100', 'ของกลาง', 'snack', 100, true, 98),
  ('95000000-0000-4000-8000-000000000012', 'T050', 'ของส่วนตัว', 'drink', 50, true, 99);

-- ---------------------------------------------------------------------------
do $$
declare
  v_plan   uuid := '95000000-0000-4000-8000-000000000001';
  v_shared uuid := '95000000-0000-4000-8000-000000000011';
  v_own    uuid := '95000000-0000-4000-8000-000000000012';
  v_table  uuid;
  v_visit  visits;
  v_ton    uuid;
  v_may    uuid;
  v_kong   uuid;
  v_calc   jsonb;
  v_bill   bills;
  v_total  numeric;
begin
  v_table := '95000000-0000-4000-8000-0000000000a1';

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ต้น',  'ratePlanId', v_plan),
    jsonb_build_object('name', 'เมย์', 'ratePlanId', v_plan),
    jsonb_build_object('name', 'ก้อง', 'ratePlanId', v_plan)
  ));

  select id into v_ton  from guest_passes where visit_id = v_visit.id and display_name = 'ต้น';
  select id into v_may  from guest_passes where visit_id = v_visit.id and display_name = 'เมย์';
  select id into v_kong from guest_passes where visit_id = v_visit.id and display_name = 'ก้อง';

  -- ของกลาง 100 × 3 = 300 หารสามคน
  perform place_order('k-shared-1', v_visit.id, null, 'shared', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_shared, 'qty', 3)));

  -- ของส่วนตัวของต้น 50
  perform place_order('k-own-1', v_visit.id, v_ton, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_own, 'qty', 1)));

  perform assert_eq('ยอดเต็มก่อนใครจ่าย',
    (preview_bill(v_visit.id) ->> 'total')::numeric, 350::numeric);

  -- ----------------------------------------------------------- ต้นกลับก่อน --
  v_calc := pass_settlement(v_ton);
  perform assert_eq('ส่วนแบ่งของกลางของต้น',
    (v_calc ->> 'sharedShare')::numeric, 100::numeric);
  perform assert_eq('ยอดที่ต้นต้องจ่าย = ของตัวเอง 50 + ของกลาง 100',
    (v_calc ->> 'total')::numeric, 150::numeric);

  v_bill := settle_pass(v_ton, jsonb_build_array(
    jsonb_build_object('method', 'cash', 'amount', 150)));
  perform assert_eq('บิลของต้นถูกบันทึกว่าจ่ายแล้ว', v_bill.status, 'paid');
  perform assert_eq('ต้นถูกตีตราว่าชำระแล้ว',
    (select status from guest_passes where id = v_ton), 'billed'::pass_status);
  perform assert_eq('การจ่ายผูกกับตัวบุคคล',
    (select paid_for from payments where bill_id = v_bill.id), array[v_ton]);

  -- ★ หัวใจ: ของที่ต้นจ่ายไปแล้วต้องหายออกจากยอดที่เหลือ ไม่ใช่ค้างให้เก็บซ้ำ
  perform assert_eq('ยอดที่เหลือ = 350 − 150',
    (preview_bill(v_visit.id) ->> 'total')::numeric, 200::numeric);
  perform assert_eq('บรรทัดหักส่วนที่ชำระแล้วปรากฏให้เห็น',
    (select count(*) from jsonb_array_elements(preview_bill(v_visit.id) -> 'lines') l
      where l ->> 'source' = 'adjustment'), 1::bigint);

  -- ต้นสั่งของเพิ่มไม่ได้แล้ว ไม่งั้นของจะไปโผล่ในบิลคนอื่น
  begin
    perform place_order('k-own-2', v_visit.id, v_ton, 'owner', 'staff',
      jsonb_build_array(jsonb_build_object('menuItemId', v_own, 'qty', 1)));
    raise exception 'FAIL  คนที่จ่ายแล้วไม่ควรสั่งของเพิ่มได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  คนที่จ่ายแล้วสั่งของเพิ่มไม่ได้';
  end;

  -- จ่ายซ้ำไม่ได้
  begin
    perform settle_pass(v_ton, '[]'::jsonb);
    raise exception 'FAIL  ไม่ควรเก็บเงินคนเดิมซ้ำได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เก็บเงินคนเดิมซ้ำไม่ได้';
  end;

  -- ------------------------------------------- สั่งเพิ่มหลังต้นกลับไปแล้ว --
  perform place_order('k-shared-2', v_visit.id, null, 'shared', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_shared, 'qty', 1)));

  v_calc := pass_settlement(v_may);
  perform assert_eq('เหลือหารกันสองคน', (v_calc ->> 'headcount')::int, 2);
  -- ของกลางรวม 400 จ่ายไปแล้ว 100 เหลือ 300 หารสองคน
  perform assert_eq('ของที่สั่งหลังต้นกลับ ต้นไม่ต้องร่วมจ่าย',
    (v_calc ->> 'sharedShare')::numeric, 150::numeric);

  v_bill := settle_pass(v_may, jsonb_build_array(
    jsonb_build_object('method', 'transfer', 'amount', 150)));

  -- ------------------------------------------------------ ก้องปิดท้ายโต๊ะ --
  perform assert_eq('ก้องเหลือจ่ายคนเดียว',
    (preview_bill(v_visit.id) ->> 'total')::numeric, 150::numeric);

  v_bill := close_visit(v_visit.id, jsonb_build_array(
    jsonb_build_object('method', 'cash', 'amount', 150)));

  select sum(total) into v_total from bills where visit_id = v_visit.id;
  perform assert_eq('ยอดรวมทุกบิลย่อย = ยอดเต็ม 450 (ของกลาง 400 + ของต้น 50)',
    v_total, 450::numeric);
  perform assert_eq('โต๊ะว่างแล้ว',
    (select status from cafe_tables where id = v_table), 'free'::table_status);
end $$;

-- ---------------------------------------------------------------------------
-- เศษสตางค์ — หารไม่ลงตัวแล้วต้องไม่หายและไม่เกิน
-- ---------------------------------------------------------------------------
do $$
declare
  v_plan   uuid := '95000000-0000-4000-8000-000000000001';
  v_shared uuid := '95000000-0000-4000-8000-000000000011';
  v_table  uuid;
  v_visit  visits;
  v_a      uuid;
  v_b      uuid;
  v_total  numeric;
begin
  v_table := '95000000-0000-4000-8000-0000000000a2';

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'เอ', 'ratePlanId', v_plan),
    jsonb_build_object('name', 'บี', 'ratePlanId', v_plan),
    jsonb_build_object('name', 'ซี', 'ratePlanId', v_plan)
  ));

  select id into v_a from guest_passes where visit_id = v_visit.id and display_name = 'เอ';
  select id into v_b from guest_passes where visit_id = v_visit.id and display_name = 'บี';

  -- 100 บาท หารสามคน = 33.333...
  perform place_order('k-odd-1', v_visit.id, null, 'shared', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_shared, 'qty', 1)));

  perform settle_pass(v_a, '[]'::jsonb);
  perform settle_pass(v_b, '[]'::jsonb);
  perform close_visit(v_visit.id, '[]'::jsonb);

  select sum(total) into v_total from bills where visit_id = v_visit.id;
  perform assert_eq('หารสามไม่ลงตัว แต่รวมกลับได้ 100 พอดี', v_total, 100::numeric);
end $$;

-- ---------------------------------------------------------------------------
-- คนที่กำลังพักอยู่ก็เก็บเงินได้ และนาฬิกาต้องหยุด
-- ---------------------------------------------------------------------------
do $$
declare
  v_plan  uuid := '95000000-0000-4000-8000-000000000001';
  v_table uuid;
  v_visit visits;
  v_p     uuid;
begin
  v_table := '95000000-0000-4000-8000-0000000000a3';

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ดี', 'ratePlanId', v_plan),
    jsonb_build_object('name', 'อี', 'ratePlanId', v_plan)
  ));
  select id into v_p from guest_passes where visit_id = v_visit.id and display_name = 'ดี';

  perform pause_pass(v_p);
  perform settle_pass(v_p, '[]'::jsonb);

  perform assert_eq('คนที่พักอยู่ก็เก็บเงินได้',
    (select status from guest_passes where id = v_p), 'billed'::pass_status);
  perform assert_eq('นาฬิกาหยุดแล้ว',
    (select checked_out_at is not null from guest_passes where id = v_p), true);
  perform assert_eq('ไม่ค้างสถานะพัก',
    (select paused_at is null from guest_passes where id = v_p), true);
end $$;

-- ---------------------------------------------------------------------------
-- สิทธิ์ — ลูกค้าที่ไม่ได้ล็อกอินต้องเรียกไม่ได้
-- ---------------------------------------------------------------------------
do $$
begin
  perform assert_eq('anon เรียก settle_pass ไม่ได้',
    has_function_privilege('anon', 'settle_pass(uuid, jsonb)', 'execute'), false);
  perform assert_eq('anon เรียก pass_settlement ไม่ได้',
    has_function_privilege('anon', 'pass_settlement(uuid, timestamptz)', 'execute'), false);
end $$;

select '=== จ่ายตอนกลับก่อนผ่านทั้งหมด ===' as result;
