-- ============================================================================
-- ระดับพนักงานแบบแยกสิทธิ์
--
-- สองคำถาม: คนแต่ละระดับทำอะไรได้ตามที่ตั้งใจไหม และระดับเดิมทั้งสาม
-- ได้สิทธิ์เท่าเดิมหรือเปล่า (ถ้าเพี้ยน พนักงานที่ใช้งานอยู่จะทำงานไม่ได้ทันที)
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

-- ---------------------- ระดับเดิมต้องได้สิทธิ์เท่าเดิม ----------------------

do $$
begin
  perform assert_eq('staff = หน้าร้าน + ครัว',
    (select array_agg(capability order by capability) from role_capabilities where role = 'staff'),
    array['floor', 'kitchen']);

  perform assert_eq('manager = staff + ตั้งค่า',
    (select array_agg(capability order by capability) from role_capabilities where role = 'manager'),
    array['floor', 'kitchen', 'settings']);

  perform assert_eq('owner = manager + จัดการบัญชี',
    (select array_agg(capability order by capability) from role_capabilities where role = 'owner'),
    array['accounts', 'floor', 'kitchen', 'settings']);

  perform assert_eq('ระดับใหม่: ดูโต๊ะและการจอง',
    (select array_agg(capability) from role_capabilities where role = 'floor'),
    array['floor']);

  perform assert_eq('ระดับใหม่: ดูเฉพาะครัว',
    (select array_agg(capability) from role_capabilities where role = 'kitchen'),
    array['kitchen']);
end;
$$;

-- ======================= คนครัวทำอะไรได้/ไม่ได้ =======================

do $$
declare
  v_kitchen uuid := '99999999-0000-4000-8000-000000000011';
  v_floor   uuid := '99999999-0000-4000-8000-000000000012';
  v_plan    uuid;
  v_table   uuid;
  v_visit   visits;
  v_pass    guest_passes;
  v_order   orders;
  v_menu    uuid;
begin
  insert into auth.users (id, email) values
    (v_kitchen, 'cook@staff.local'), (v_floor, 'waiter@staff.local');
  insert into staff (user_id, username, display_name, role) values
    (v_kitchen, 'cook', 'พ่อครัว', 'kitchen'),
    (v_floor, 'waiter', 'พนักงานเสิร์ฟ', 'floor');

  -- เตรียมออเดอร์ไว้ให้ครัวเล่น (สร้างด้วยสิทธิ์ของผู้จัดการ)
  select id into v_plan  from rate_plans where active limit 1;
  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;
  select id into v_menu  from menu_items where available limit 1;

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ลูกค้า', 'ratePlanId', v_plan)));
  select * into v_pass from guest_passes where visit_id = v_visit.id;
  v_order := place_order('cap-test', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)));

  -- ---------------------------- คนครัว ----------------------------
  perform set_config('test.user_id', v_kitchen::text, false);

  perform assert_eq('คนครัวมีสิทธิ์ครัว', has_cap('kitchen'), true);
  perform assert_eq('คนครัวไม่มีสิทธิ์หน้าร้าน', has_cap('floor'), false);
  perform assert_eq('คนครัวไม่มีสิทธิ์ตั้งค่า', has_cap('settings'), false);
  perform assert_eq('รายการสิทธิ์ของคนครัว', my_capabilities(), array['kitchen']);

  -- ยังเป็นพนักงาน จึงอ่านข้อมูลได้ตามปกติ — การซ่อนเมนูเป็นเรื่องหน้าจอ
  perform assert_eq('คนครัวยังนับเป็นพนักงาน', is_staff(), true);

  perform assert_eq('คนครัวเปลี่ยนสถานะออเดอร์ได้',
    (update_order_status(v_order.id, 'accepted')).status, 'accepted'::order_status);

  begin
    perform open_visit(array[v_table], jsonb_build_array(
      jsonb_build_object('name', 'x', 'ratePlanId', v_plan)));
    raise exception 'FAIL  คนครัวไม่ควรเปิดโต๊ะได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  คนครัวเปิดโต๊ะไม่ได้';
  end;

  begin
    perform close_visit(v_visit.id);
    raise exception 'FAIL  คนครัวไม่ควรปิดบิลได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  คนครัวปิดบิลไม่ได้';
  end;

  begin
    perform upsert_menu_item(null, 'K99', 'ของฟรี', 'drink', 0, true, 0);
    raise exception 'FAIL  คนครัวไม่ควรแก้เมนูได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  คนครัวแก้เมนูไม่ได้';
  end;

  -- ------------------------ พนักงานหน้าร้าน ------------------------
  perform set_config('test.user_id', v_floor::text, false);

  perform assert_eq('หน้าร้านมีสิทธิ์หน้าร้าน', has_cap('floor'), true);
  perform assert_eq('หน้าร้านไม่มีสิทธิ์ครัว', has_cap('kitchen'), false);

  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;
  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ก', 'ratePlanId', v_plan)));
  perform assert_eq('หน้าร้านเปิดโต๊ะได้', v_visit.status, 'open'::visit_status);

  begin
    perform update_order_status(v_order.id, 'preparing');
    raise exception 'FAIL  หน้าร้านไม่ควรเปลี่ยนสถานะออเดอร์ได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  หน้าร้านเปลี่ยนสถานะออเดอร์ (งานครัว) ไม่ได้';
  end;

  begin
    perform list_staff();
    raise exception 'FAIL  หน้าร้านไม่ควรดูรายชื่อพนักงานได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  หน้าร้านดูรายชื่อพนักงานไม่ได้';
  end;
end;
$$;

-- ============ แยก "ตั้งค่าร้าน" ออกจาก "จัดการบัญชี" ============

do $$
declare v_mgr uuid := '99999999-0000-4000-8000-000000000001';
begin
  perform set_config('test.user_id', v_mgr::text, false);
  perform assert_eq('ผู้จัดการมีสิทธิ์ตั้งค่า', has_cap('settings'), true);
  perform assert_eq('ผู้จัดการไม่มีสิทธิ์จัดการบัญชี', has_cap('accounts'), false);

  perform upsert_shop_hours(0::smallint, '11:00', '23:00', false);
  raise notice 'PASS  ผู้จัดการตั้งค่าร้านได้';

  begin
    perform list_staff();
    raise exception 'FAIL  ผู้จัดการไม่ควรดูรายชื่อพนักงานได้แล้ว';
  exception when sqlstate '42501' then
    raise notice 'PASS  ผู้จัดการดูรายชื่อพนักงานไม่ได้ (แยกเป็นสิทธิ์ต่างหาก)';
  end;
end;
$$;

-- ============ ยกสิทธิ์จัดการบัญชีให้คนอื่นไม่ได้ถ้าตัวเองไม่มี ============

do $$
declare
  v_admin uuid := '99999999-0000-4000-8000-000000000013';
  v_mgr   uuid := '99999999-0000-4000-8000-000000000001';
  v_row   staff;
begin
  insert into auth.users (id, email) values (v_admin, 'admin@staff.local');
  insert into staff (user_id, username, display_name, role)
  values (v_admin, 'admin2', 'แอดมินสำรอง', 'owner');

  perform set_config('test.user_id', v_mgr::text, false);
  begin
    perform set_staff_role(v_mgr, 'owner');
    raise exception 'FAIL  คนที่ไม่มีสิทธิ์จัดการบัญชีไม่ควรยกสิทธิ์นั้นให้ใครได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  ยกสิทธิ์จัดการบัญชีให้คนอื่นไม่ได้ถ้าตัวเองไม่มี';
  end;

  perform set_config('test.user_id', v_admin::text, false);
  v_row := set_staff_role(v_mgr, 'owner');
  perform assert_eq('คนที่มีสิทธิ์จัดการบัญชียกสิทธิ์ให้คนอื่นได้', v_row.role, 'owner');

  v_row := set_staff_role(v_mgr, 'manager');
end;
$$;

-- ★ ======== ต้องเหลือคนที่จัดการบัญชีได้อย่างน้อย 1 คน ========

do $$
declare v_admin uuid := '99999999-0000-4000-8000-000000000013';
begin
  perform set_config('test.user_id', v_admin::text, false);

  -- ลดคนอื่นที่ถือสิทธิ์นี้ลง จนเหลือ v_admin คนเดียว
  update staff set role = 'manager' where role = 'owner' and user_id <> v_admin;

  begin
    perform set_staff_role(v_admin, 'manager');
    raise exception 'FAIL  ลดสิทธิ์คนสุดท้ายที่จัดการบัญชีได้ ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ลดสิทธิ์คนสุดท้ายที่จัดการบัญชีได้ไม่ได้';
  end;

  begin
    perform set_staff_active(v_admin, false);
    raise exception 'FAIL  ปิดบัญชีคนสุดท้ายที่จัดการบัญชีได้ ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ปิดบัญชีคนสุดท้ายที่จัดการบัญชีได้ไม่ได้';
  end;
end;
$$;

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

select '=== ระดับพนักงานแบบแยกสิทธิ์ผ่านทั้งหมด ===' as result;
