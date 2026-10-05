-- ============================================================================
-- แจ้งเตือนออเดอร์เข้าครัว
--
-- คำถามสำคัญที่สุดไม่ใช่ "ส่งแจ้งเตือนได้ไหม" (ต้องมี pg_net กับบริการ push จริง
-- ถึงจะตอบได้) แต่คือ "ถ้าการแจ้งเตือนพัง ลูกค้ายังสั่งของได้อยู่ไหม"
-- ถ้าตอบผิดข้อนี้ ร้านจะรับออเดอร์ไม่ได้เลยเพราะเรื่องที่ไม่สำคัญเท่า
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

-- ★ ================= แจ้งเตือนพังต้องไม่ล้มออเดอร์ =================

do $$
declare
  v_plan  uuid;
  v_table uuid;
  v_visit visits;
  v_pass  guest_passes;
  v_menu  uuid;
  v_order orders;
begin
  -- จงใจตั้ง URL ที่ยิงไม่ถึง เพื่อจำลองว่าบริการแจ้งเตือนล่ม
  update push_config set function_url = 'http://127.0.0.1:1/ไม่มีอยู่', enabled = true;

  select id into v_plan  from rate_plans where active limit 1;
  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;
  select id into v_menu  from menu_items where available limit 1;

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ลูกค้า', 'ratePlanId', v_plan)));
  select * into v_pass from guest_passes where visit_id = v_visit.id;

  v_order := place_order('push-test', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)));

  perform assert_eq('สั่งของสำเร็จแม้แจ้งเตือนส่งไม่ได้', v_order.status, 'placed'::order_status);
  perform assert_eq('รายการอาหารถูกบันทึกครบ',
    (select count(*) from order_lines where order_id = v_order.id), 1::bigint);

  perform close_visit(v_visit.id);

  -- ยังไม่ได้ตั้งค่าเลยก็ต้องสั่งได้ตามปกติ
  update push_config set function_url = null;

  select id into v_table from cafe_tables where status = 'free' and not allow_share limit 1;
  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'ลูกค้า2', 'ratePlanId', v_plan)));
  select * into v_pass from guest_passes where visit_id = v_visit.id;

  v_order := place_order('push-test-2', v_visit.id, v_pass.id, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)));
  perform assert_eq('ยังไม่ตั้งค่าแจ้งเตือนก็สั่งของได้', v_order.status, 'placed'::order_status);

  perform close_visit(v_visit.id);
end;
$$;

-- ===================== ลงทะเบียนอุปกรณ์ =====================

do $$
declare
  v_cook uuid := '99999999-0000-4000-8000-000000000021';
  v_wait uuid := '99999999-0000-4000-8000-000000000022';
begin
  insert into auth.users (id, email) values
    (v_cook, 'cook2@staff.local'), (v_wait, 'waiter2@staff.local');
  insert into staff (user_id, username, display_name, role) values
    (v_cook, 'cook2', 'พ่อครัว 2', 'kitchen'),
    (v_wait, 'waiter2', 'เสิร์ฟ 2', 'floor');

  perform set_config('test.user_id', v_cook::text, false);
  perform save_push_subscription('https://push.example.com/cook', 'k1', 'a1', 'เครื่องครัว');
  perform assert_eq('ลงทะเบียนอุปกรณ์ได้',
    has_push_subscription('https://push.example.com/cook'), true);

  -- ลงทะเบียน endpoint เดิมซ้ำต้องไม่เกิดแถวซ้ำ (เบราว์เซอร์ส่งค่าเดิมมาได้)
  perform save_push_subscription('https://push.example.com/cook', 'k2', 'a2', 'เครื่องครัว');
  perform assert_eq('ลงทะเบียนซ้ำไม่เกิดแถวซ้ำ',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/cook'),
    1::bigint);
  perform assert_eq('อัปเดตกุญแจเป็นค่าล่าสุด',
    (select p256dh from push_subscriptions where endpoint = 'https://push.example.com/cook'), 'k2');

  -- พนักงานเสิร์ฟก็ลงทะเบียนได้ แต่จะไม่อยู่ในรายชื่อที่ครัวได้รับ
  perform set_config('test.user_id', v_wait::text, false);
  perform save_push_subscription('https://push.example.com/waiter', 'k3', 'a3', null);

  perform assert_eq('เห็นสถานะของอุปกรณ์ตัวเอง',
    has_push_subscription('https://push.example.com/waiter'), true);
  perform assert_eq('ไม่เห็นอุปกรณ์ของคนอื่น',
    has_push_subscription('https://push.example.com/cook'), false);
end;
$$;

-- ★ ============ ส่งเฉพาะคนที่มีสิทธิ์ดูแลครัว ============

do $$
declare v_eps text[];
begin
  select array_agg(endpoint order by endpoint) into v_eps from kitchen_push_endpoints();

  perform assert_eq('ส่งหาเครื่องของคนครัว', v_eps @> array['https://push.example.com/cook'], true);
  perform assert_eq('ไม่ส่งหาเครื่องของพนักงานเสิร์ฟ',
    v_eps @> array['https://push.example.com/waiter'], false);

  -- ปิดบัญชีคนครัวแล้วต้องไม่ส่งไปหาอีก
  -- ใช้ ...0013 เพราะเป็นคนที่ยังถือสิทธิ์ accounts อยู่หลังเทสต์ก่อนหน้า
  perform set_config('test.user_id', '99999999-0000-4000-8000-000000000013', false);
  perform set_staff_active('99999999-0000-4000-8000-000000000021', false);

  perform assert_eq('ปิดบัญชีแล้วไม่ส่งไปหา',
    (select count(*) from kitchen_push_endpoints()
      where endpoint = 'https://push.example.com/cook'), 0::bigint);

  perform set_staff_active('99999999-0000-4000-8000-000000000021', true);

  -- เปลี่ยนระดับเป็นหน้าร้านแล้วก็ต้องไม่ได้รับแล้วเช่นกัน
  perform set_staff_role('99999999-0000-4000-8000-000000000021', 'floor');
  perform assert_eq('เปลี่ยนระดับแล้วไม่ส่งไปหา',
    (select count(*) from kitchen_push_endpoints()
      where endpoint = 'https://push.example.com/cook'), 0::bigint);

  perform set_staff_role('99999999-0000-4000-8000-000000000021', 'kitchen');
  perform assert_eq('กลับมาเป็นครัวแล้วได้รับอีกครั้ง',
    (select count(*) from kitchen_push_endpoints()
      where endpoint = 'https://push.example.com/cook'), 1::bigint);
end;
$$;

-- ลบอุปกรณ์ของตัวเองได้ แต่ของคนอื่นไม่ได้
do $$
begin
  perform set_config('test.user_id', '99999999-0000-4000-8000-000000000022', false);

  perform delete_push_subscription('https://push.example.com/cook');
  perform assert_eq('ลบอุปกรณ์ของคนอื่นไม่ได้',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/cook'),
    1::bigint);

  perform delete_push_subscription('https://push.example.com/waiter');
  perform assert_eq('ลบอุปกรณ์ตัวเองได้',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/waiter'),
    0::bigint);
end;
$$;

-- ★ ================ ความลับต้องไม่หลุดถึง client ================

set "test.user_id" = '';
set role anon;

do $$
declare v_n bigint;
begin
  begin
    select count(*) into v_n from push_config;
    raise exception 'FAIL  anon ไม่ควรอ่าน push_config ได้ (มีรหัสลับอยู่ข้างใน)';
  exception when insufficient_privilege then
    raise notice 'PASS  anon อ่าน push_config ไม่ได้';
  end;

  begin
    select count(*) into v_n from push_subscriptions;
    raise exception 'FAIL  anon ไม่ควรอ่าน push_subscriptions ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  anon อ่าน push_subscriptions ไม่ได้';
  end;
end;
$$;
reset role;

-- พนักงานที่ล็อกอินแล้วก็ยังอ่านตารางตรงไม่ได้ ต้องผ่าน RPC เท่านั้น
set "test.user_id" = '99999999-0000-4000-8000-000000000021';
set role authenticated;

do $$
declare v_n bigint;
begin
  begin
    select count(*) into v_n from push_config;
    raise exception 'FAIL  พนักงานไม่ควรอ่าน push_config ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  พนักงานอ่าน push_config ไม่ได้';
  end;

  begin
    select count(*) into v_n from push_subscriptions;
    raise exception 'FAIL  พนักงานไม่ควรอ่าน push_subscriptions ตรงได้';
  exception when insufficient_privilege then
    raise notice 'PASS  พนักงานอ่าน push_subscriptions ตรงไม่ได้';
  end;

  begin
    perform kitchen_push_endpoints();
    raise exception 'FAIL  พนักงานไม่ควรดึงรายชื่ออุปกรณ์ทั้งหมดได้';
  exception when insufficient_privilege then
    raise notice 'PASS  พนักงานดึงรายชื่ออุปกรณ์ทั้งหมดไม่ได้';
  end;
end;
$$;
reset role;

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

select '=== แจ้งเตือนออเดอร์เข้าครัวผ่านทั้งหมด ===' as result;
