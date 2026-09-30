-- ============================================================================
-- หน้าตั้งค่าของเจ้าของร้าน
--
-- โจทย์สำคัญกว่าเรื่อง CRUD: แก้ราคาแล้วบิลของคนที่กำลังนั่งอยู่ต้องไม่เปลี่ยน
-- ============================================================================

-- พนักงานธรรมดา (ไม่ใช่ manager/owner) ไว้ทดสอบขอบเขตสิทธิ์
insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000003', 'crew@cafe.test');
insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000003', 'พนักงานหน้าร้าน', 'staff');

set "test.user_id" = '99999999-0000-4000-8000-000000000001';  -- manager

-- ============================ snapshot เรตค่าเล่น ============================

do $$
declare
  v_plan  rate_plans;
  v_table uuid;
  v_visit visits;
  v_pass  guest_passes;
  v_before numeric;
  v_after  numeric;
begin
  insert into rate_plans (name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap)
  values ('เรตทดสอบ', 60, 30, 60, null) returning * into v_plan;

  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ลูกค้าที่นั่งอยู่', 'ratePlanId', v_plan.id)));
  select * into v_pass from guest_passes where visit_id = v_visit.id;

  perform assert_eq('pass เก็บเรตของตัวเองไว้', v_pass.rate_price_per_hour, 60::numeric);
  perform assert_eq('เก็บชื่อเรตไว้ด้วย', v_pass.rate_name, 'เรตทดสอบ');

  v_before := (preview_bill(v_visit.id) ->> 'subtotal')::numeric;
  perform assert_eq('ชั่วโมงแรกคิด 60', v_before, 60::numeric);

  -- ★ เจ้าของขึ้นราคาเป็นสองเท่าระหว่างที่ลูกค้ายังนั่งอยู่
  perform upsert_rate_plan(v_plan.id, 'เรตทดสอบ', 120, 30, 60, null, true, 0);

  v_after := (preview_bill(v_visit.id) ->> 'subtotal')::numeric;
  perform assert_eq('บิลของคนที่นั่งอยู่ไม่เปลี่ยนตามราคาใหม่', v_after, v_before);

  -- แต่คนที่เข้ามาใหม่ต้องได้ราคาใหม่
  perform add_pass(v_visit.id, 'ลูกค้าใหม่', v_plan.id);
  perform assert_eq('คนที่เข้ามาหลังขึ้นราคา ได้เรตใหม่',
    (select rate_price_per_hour from guest_passes
      where visit_id = v_visit.id and display_name = 'ลูกค้าใหม่'), 120::numeric);

  perform close_visit(v_visit.id);
end;
$$;

-- ============================== จัดการเมนู ==============================

do $$
declare
  v_item   menu_items;
  v_visit  visits;
  v_table  uuid;
  v_pass   guest_passes;
  v_order  orders;
  v_plan   uuid;
  v_billed numeric;
begin
  -- เพิ่มเมนูใหม่
  v_item := upsert_menu_item(null, 'x01', 'ชาไทย', 'drink', 60, true, 99);
  perform assert_eq('เพิ่มเมนูได้', v_item.name, 'ชาไทย');
  perform assert_eq('รหัสถูกแปลงเป็นตัวใหญ่', v_item.sku, 'X01');

  -- ลูกค้าสั่งไปแล้วด้วยราคาเดิม
  select id into v_plan from rate_plans where active limit 1;
  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;
  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ก', 'ratePlanId', v_plan)));
  select * into v_pass from guest_passes where visit_id = v_visit.id;

  v_order := place_order('menu-price-test', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_item.id, 'qty', 1)));

  -- เจ้าของขึ้นราคาเมนู
  perform upsert_menu_item(v_item.id, 'X01', 'ชาไทย', 'drink', 999, true, 99);

  select amount into v_billed
    from jsonb_to_recordset(preview_bill(v_visit.id) -> 'lines')
         as x(label text, amount numeric)
   where label = 'ชาไทย';
  perform assert_eq('ออเดอร์ที่สั่งไปแล้วยังใช้ราคาเดิม', v_billed, 60::numeric);

  perform close_visit(v_visit.id);

  -- เก็บเข้ากรุแทนการลบ (ลบจริงไม่ได้เพราะ order_lines อ้างอยู่)
  perform archive_menu_item(v_item.id);
  perform assert_eq('เก็บเข้ากรุแล้วปิดขายด้วย',
    (select available from menu_items where id = v_item.id), false);
  perform assert_eq('ข้อมูลยังอยู่ ไม่ได้ถูกลบ',
    (select count(*) from menu_items where id = v_item.id), 1::bigint);

  -- เอากลับมาขายได้
  perform archive_menu_item(v_item.id, false);
  perform assert_eq('เอากลับมาจากกรุได้',
    (select archived from menu_items where id = v_item.id), false);
end;
$$;

-- ============================== จัดการโต๊ะ ==============================

do $$
declare
  v_table  cafe_tables;
  v_visit  visits;
  v_plan   uuid;
  v_start  timestamptz;
begin
  select id into v_plan from rate_plans where active limit 1;

  v_table := upsert_table(null, 'z9', 'โซนทดสอบ', 2, 4, false, 99);
  perform assert_eq('เพิ่มโต๊ะได้', v_table.code, 'Z9');

  v_table := upsert_table(v_table.id, 'Z9', 'โซนใหม่', 2, 6, false, 99);
  perform assert_eq('แก้โต๊ะได้', v_table.seat_max, 6);

  begin
    perform upsert_table(v_table.id, 'Z9', 'โซนใหม่', 5, 2, false, 99);
    raise exception 'FAIL  ที่นั่งมากกว่าน้อยกว่าไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  จำนวนที่นั่งต้องสมเหตุสมผล';
  end;

  -- มีลูกค้านั่งอยู่ เก็บโต๊ะเข้ากรุไม่ได้
  v_visit := open_visit(array[v_table.id], jsonb_build_array(
    jsonb_build_object('name', 'ก', 'ratePlanId', v_plan)));
  begin
    perform archive_table(v_table.id);
    raise exception 'FAIL  โต๊ะที่มีคนนั่งไม่ควรเก็บเข้ากรุได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  โต๊ะที่มีลูกค้านั่งอยู่ เก็บเข้ากรุไม่ได้';
  end;

  -- เปลี่ยนการนั่งร่วมตอนมีคนอยู่ก็ไม่ได้ (occupancies.exclusive จะไม่ตรงกัน)
  begin
    perform upsert_table(v_table.id, 'Z9', 'โซนใหม่', 2, 6, true, 99);
    raise exception 'FAIL  เปลี่ยน allow_share ตอนมีคนนั่งไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เปลี่ยนการนั่งร่วมตอนมีลูกค้าอยู่ไม่ได้';
  end;

  perform close_visit(v_visit.id);

  -- มีคิวจองค้าง ก็เก็บเข้ากรุไม่ได้
  v_start := ((now() at time zone 'Asia/Bangkok')::date + 3 + time '15:00')
             at time zone 'Asia/Bangkok';
  set local role anon;
  perform create_reservation('คนจอง', '095-000-1111', 2, v_start, 120, array[v_table.id]);
  reset role;

  begin
    perform archive_table(v_table.id);
    raise exception 'FAIL  โต๊ะที่มีคิวจองไม่ควรเก็บเข้ากรุได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  โต๊ะที่มีคิวจองค้าง เก็บเข้ากรุไม่ได้';
  end;

  update reservations set status = 'cancelled'
   where status in ('pending', 'confirmed') and v_table.id = any(table_ids);

  perform archive_table(v_table.id);
  perform assert_eq('เก็บโต๊ะเข้ากรุได้เมื่อไม่มีอะไรค้าง',
    (select archived from cafe_tables where id = v_table.id), true);

  -- โต๊ะที่เก็บเข้ากรุต้องหายจากทุกที่ที่ลูกค้าเห็น
  perform assert_eq('ไม่โผล่ในผังโต๊ะสาธารณะ',
    (select count(*) from public_tables where id = v_table.id), 0::bigint);
  perform assert_eq('ไม่โผล่ในหน้าจอง',
    (select count(*) from jsonb_array_elements(available_tables(v_start, 120)) e
      where (e ->> 'id')::uuid = v_table.id), 0::bigint);
end;
$$;

-- ============================ เวลาทำการ / ภาษี ============================

do $$
declare
  v_h shop_hours;
  v_t tax_config;
begin
  v_h := upsert_shop_hours(1::smallint, '12:00', '22:00', false);
  perform assert_eq('แก้เวลาทำการได้', v_h.open_time, '12:00'::time);

  v_h := upsert_shop_hours(1::smallint, '12:00', '22:00', true);
  perform assert_eq('ตั้งวันหยุดได้', v_h.closed, true);

  begin
    perform upsert_shop_hours(2::smallint, '20:00', '02:00', false);
    raise exception 'FAIL  ปิดข้ามวันยังไม่รองรับ ควรถูกปฏิเสธ';
  exception when sqlstate '22023' then
    raise notice 'PASS  ปิดข้ามวันถูกปฏิเสธพร้อมบอกเหตุผล';
  end;

  v_t := update_tax_config(0, 0.07, true);
  perform assert_eq('แก้ VAT ได้', v_t.vat_rate, 0.07::numeric);

  begin
    perform update_tax_config(0, 1.5, true);
    raise exception 'FAIL  อัตราเกิน 100%% ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  อัตราภาษีต้องอยู่ในช่วงที่สมเหตุสมผล';
  end;

  -- คืนค่าเดิมให้เทสต์อื่น
  perform upsert_shop_hours(1::smallint, '11:00', '23:00', false);
end;
$$;

-- ============================== ขอบเขตสิทธิ์ ==============================

-- พนักงานหน้าร้าน (role = staff) เปิดโต๊ะได้ แต่ตั้งค่าร้านไม่ได้
set "test.user_id" = '99999999-0000-4000-8000-000000000003';

do $$
begin
  perform assert_eq('ยังเป็นพนักงานอยู่', is_staff(), true);
  perform assert_eq('แต่ไม่ใช่ระดับจัดการ', my_staff_role(), 'staff');

  begin
    perform upsert_menu_item(null, 'HACK', 'ของฟรี', 'drink', 0, true, 0);
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรแก้เมนูได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาแก้เมนูไม่ได้';
  end;

  begin
    perform upsert_rate_plan(null, 'ฟรี', 0, 30, 0, null, true, 0);
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรตั้งเรตราคาได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาตั้งเรตราคาไม่ได้';
  end;

  begin
    perform upsert_shop_hours(0::smallint, '00:00', '23:59', false);
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรแก้เวลาทำการได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาแก้เวลาทำการไม่ได้';
  end;

  begin
    perform update_tax_config(0, 0, true);
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรแก้ภาษีได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาแก้ภาษีไม่ได้';
  end;
end;
$$;

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

select '=== หน้าตั้งค่าเจ้าของร้านผ่านทั้งหมด ===' as result;
