-- ============================================================================
-- ทดสอบ RPC และ RLS
-- คำถามที่ไฟล์นี้ตอบ: "ลูกค้าที่เปิด devtools แก้ยอดบิลตัวเองได้ไหม"
-- ============================================================================

-- ------------------------------------------------------- เตรียมพนักงาน ----

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000001', 'staff@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000001', 'พนักงานทดสอบ', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

-- ------------------------------------------------------------ RPC flow ----

do $$
declare
  v_plan    uuid;
  v_table   uuid;
  v_table2  uuid;
  v_shared  uuid;
  v_visit   visits;
  v_pass    guest_passes;
  v_p2      guest_passes;
  v_order   orders;
  v_order2  orders;
  v_bill    bills;
  v_menu    uuid;
  v_err     text;
begin
  select id into v_plan  from rate_plans  where day_pass_cap = 199 limit 1;
  select id into v_table from cafe_tables where code = 'A1';
  select id into v_table2 from cafe_tables where code = 'B1';
  select id into v_shared from cafe_tables where code = 'C1';
  select id into v_menu  from menu_items  where sku = 'D01';

  -- เปิดโต๊ะ
  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ต้น', 'ratePlanId', v_plan),
    jsonb_build_object('name', 'เมย์', 'ratePlanId', v_plan)
  ));
  perform assert_eq('เปิด visit แล้วมีผู้เล่น 2 คน',
    (select count(*) from guest_passes where visit_id = v_visit.id), 2::bigint);
  perform assert_eq('โต๊ะเปลี่ยนเป็นมีลูกค้า',
    (select status from cafe_tables where id = v_table), 'occupied'::table_status);

  -- โต๊ะที่ห้ามนั่งร่วม เปิดซ้ำไม่ได้
  begin
    perform open_visit(array[v_table], jsonb_build_array(
      jsonb_build_object('name', 'คนอื่น', 'ratePlanId', v_plan)));
    raise exception 'FAIL  ควรเปิดโต๊ะซ้ำไม่ได้';
  exception when unique_violation then
    raise notice 'PASS  โต๊ะเดียวกันเปิดซ้อนไม่ได้';
  end;

  -- โต๊ะยาวนั่งร่วมกันได้
  perform open_visit(array[v_shared], jsonb_build_array(
    jsonb_build_object('name', 'กลุ่ม1', 'ratePlanId', v_plan)));
  perform open_visit(array[v_shared], jsonb_build_array(
    jsonb_build_object('name', 'กลุ่ม2', 'ratePlanId', v_plan)));
  raise notice 'PASS  โต๊ะยาวรองรับ 2 กลุ่มพร้อมกัน';

  -- เพิ่มคนกลางคัน
  v_pass := add_pass(v_visit.id, 'ปาล์ม', v_plan);
  perform assert_eq('เพิ่มคนกลางคันได้',
    (select count(*) from guest_passes where visit_id = v_visit.id), 3::bigint);

  -- พัก แล้วกลับมา
  perform pause_pass(v_pass.id);
  perform assert_eq('สถานะเป็นพัก',
    (select status from guest_passes where id = v_pass.id), 'paused'::pass_status);
  perform resume_pass(v_pass.id);
  perform assert_eq('กลับมาเล่นต่อ',
    (select status from guest_passes where id = v_pass.id), 'active'::pass_status);
  perform assert_eq('พักแล้ว paused_at ต้องถูกล้าง',
    (select paused_at from guest_passes where id = v_pass.id), null::timestamptz);

  -- พักซ้ำไม่ได้
  perform pause_pass(v_pass.id);
  begin
    perform pause_pass(v_pass.id);
    raise exception 'FAIL  ควรพักซ้ำไม่ได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  พักซ้ำไม่ได้';
  end;
  perform resume_pass(v_pass.id);

  -- กลับก่อน
  perform check_out_pass(v_pass.id);
  perform assert_eq('กลับก่อนแล้วสถานะถูกต้อง',
    (select status from guest_passes where id = v_pass.id), 'checked_out'::pass_status);
  perform assert_eq('visit ยังเปิดอยู่แม้มีคนกลับ',
    (select status from visits where id = v_visit.id), 'open'::visit_status);

  -- คนที่กลับไปแล้วสั่งของไม่ได้
  begin
    perform place_order('k-reject', v_visit.id, v_pass.id, 'owner', 'staff',
      jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)));
    raise exception 'FAIL  คนที่กลับแล้วไม่ควรสั่งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  คนที่กลับแล้วสั่งของไม่ได้';
  end;

  -- ย้ายโต๊ะ
  perform move_visit_to_tables(v_visit.id, array[v_table2]);
  perform assert_eq('โต๊ะเดิมถูกปล่อย',
    (select status from cafe_tables where id = v_table), 'cleaning'::table_status);
  perform assert_eq('โต๊ะใหม่ถูกจอง',
    (select status from cafe_tables where id = v_table2), 'occupied'::table_status);
  perform assert_eq('ประวัติโต๊ะเดิมยังอยู่',
    (select count(*) from occupancies where visit_id = v_visit.id and to_at is not null), 1::bigint);

  -- สั่งอาหาร
  select id into v_pass from guest_passes where visit_id = v_visit.id and display_name = 'ต้น';
  v_order := place_order('k-1', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 2)));
  perform assert_eq('ราคามาจาก DB ไม่ใช่จาก client',
    (select unit_price_snapshot from order_lines where order_id = v_order.id), 65::numeric);

  -- ยิงซ้ำด้วย key เดิม → ต้องได้ออเดอร์เดิม ไม่เกิดใบใหม่
  v_order2 := place_order('k-1', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 2)));
  perform assert_eq('idempotency กันออเดอร์ซ้ำ', v_order2.id, v_order.id);
  perform assert_eq('มีออเดอร์ใบเดียว',
    (select count(*) from orders where visit_id = v_visit.id), 1::bigint);

  -- ของหมดสั่งไม่ได้
  begin
    perform place_order('k-2', v_visit.id, v_pass.id, 'owner', 'staff',
      jsonb_build_array(jsonb_build_object(
        'menuItemId', (select id from menu_items where sku = 'S03'), 'qty', 1)));
    raise exception 'FAIL  ของหมดไม่ควรสั่งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ของหมดสั่งไม่ได้';
  end;

  -- สถานะออเดอร์ต้องเดินตามลำดับ
  begin
    perform update_order_status(v_order.id, 'served');
    raise exception 'FAIL  ข้ามสถานะไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ข้ามจาก placed ไป served ไม่ได้';
  end;

  perform update_order_status(v_order.id, 'accepted');
  perform update_order_status(v_order.id, 'preparing');
  perform update_order_status(v_order.id, 'ready');
  perform update_order_status(v_order.id, 'served');
  perform assert_eq('เดินครบทุกสถานะ',
    (select status from orders where id = v_order.id), 'served'::order_status);

  -- ปิดบิล
  v_bill := close_visit(v_visit.id, jsonb_build_array(
    jsonb_build_object('method', 'cash', 'amount', 1000)));

  perform assert_eq('บิลถูกบันทึกเป็น snapshot',
    (select count(*) from bill_lines where bill_id = v_bill.id) > 0, true);
  perform assert_eq('จ่ายครบแล้วสถานะเป็น paid', v_bill.status, 'paid');
  perform assert_eq('visit ปิดแล้ว',
    (select status from visits where id = v_visit.id), 'paid'::visit_status);
  perform assert_eq('ผู้เล่นถูกปิดบิลหมด',
    (select count(*) from guest_passes where visit_id = v_visit.id and status <> 'billed'), 0::bigint);
  perform assert_eq('โต๊ะถูกคืน',
    (select status from cafe_tables where id = v_table2), 'cleaning'::table_status);
  perform assert_eq('มี audit log',
    (select count(*) from audit_log where entity_id = v_visit.id), 1::bigint);

  -- ปิดซ้ำไม่ได้
  begin
    perform close_visit(v_visit.id);
    raise exception 'FAIL  ปิดบิลซ้ำไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ปิดบิลซ้ำไม่ได้';
  end;

  raise notice '--- RPC ผ่านทั้งหมด ---';
end;
$$;

-- ==========================================================================
-- RLS: สวมบทลูกค้าที่ไม่ได้ล็อกอิน
-- ==========================================================================

set "test.user_id" = '';
set role anon;

do $$
declare v_count bigint;
begin
  -- อ่านเมนูได้ (ติดหน้าร้านอยู่แล้ว)
  select count(*) into v_count from menu_items;
  perform assert_eq('anon อ่านเมนูได้', v_count > 0, true);

  select count(*) into v_count from cafe_tables;
  perform assert_eq('anon อ่านผังโต๊ะได้', v_count > 0, true);
end;
$$;

-- ข้อมูลปฏิบัติการถูกกันตั้งแต่ระดับสิทธิ์ ไม่ใช่แค่ RLS คืน 0 แถว
-- (เพิกถอน SELECT ไปแล้ว จึงเป็น permission denied ไม่ใช่ผลลัพธ์ว่าง)
do $$
declare
  v_table text;
  v_n     bigint;
begin
  foreach v_table in array array['visits', 'guest_passes', 'occupancies',
                                 'orders', 'bills', 'payments', 'audit_log'] loop
    begin
      execute format('select count(*) from %I', v_table) into v_n;
      raise exception 'FAIL  anon ไม่ควรอ่าน % ได้', v_table;
    exception when insufficient_privilege then
      raise notice 'PASS  anon อ่าน % ไม่ได้', v_table;
    end;
  end loop;
end;
$$;

-- ลูกค้าแก้ราคาเมนูไม่ได้
do $$
begin
  update menu_items set price = 1;
  raise exception 'FAIL  anon ไม่ควรแก้ราคาเมนูได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon แก้ราคาเมนูไม่ได้';
end;
$$;

-- ลูกค้าแก้ยอดบิลไม่ได้ — คำถามหลักของไฟล์นี้
do $$
begin
  update bills set total = 0;
  raise exception 'FAIL  anon ไม่ควรแก้ยอดบิลได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon แก้ยอดบิลไม่ได้';
end;
$$;

-- ลูกค้าปลอมการชำระเงินไม่ได้
do $$
begin
  insert into payments (bill_id, method, amount)
  values ((select id from bills limit 1), 'cash', 9999);
  raise exception 'FAIL  anon ไม่ควรสร้าง payment ได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon ปลอมการชำระเงินไม่ได้';
end;
$$;

-- ลูกค้าเรียก RPC ที่เปลี่ยนข้อมูลไม่ได้
do $$
begin
  perform close_visit((select id from visits limit 1));
  raise exception 'FAIL  anon ไม่ควรเรียก close_visit ได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon เรียก close_visit ไม่ได้';
end;
$$;

reset role;

-- ==========================================================================
-- สวมบทคนที่ล็อกอินแล้วแต่ไม่ใช่พนักงาน (เช่นลูกค้าที่สมัครสมาชิก)
-- ==========================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000002', 'customer@test.com');

set "test.user_id" = '99999999-0000-4000-8000-000000000002';
set role authenticated;

do $$
declare v_plan uuid; v_table uuid;
begin
  perform assert_eq('ไม่ได้อยู่ในทะเบียนพนักงาน', is_staff(), false);

  select id into v_plan from rate_plans limit 1;
  select id into v_table from cafe_tables where code = 'A3';
  begin
    perform open_visit(array[v_table], jsonb_build_array(
      jsonb_build_object('name', 'x', 'ratePlanId', v_plan)));
    raise exception 'FAIL  คนที่ไม่ใช่พนักงานไม่ควรเปิดโต๊ะได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  ล็อกอินเฉย ๆ เปิดโต๊ะไม่ได้ ต้องเป็นพนักงาน';
  end;

  perform assert_eq('อ่าน visits ไม่ได้เพราะไม่ใช่พนักงาน',
    (select count(*) from visits), 0::bigint);
end;
$$;

reset role;

select '=== ผ่านทั้งหมด ===' as result;
