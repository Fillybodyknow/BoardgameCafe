-- ============================================================================
-- ลูกค้าสั่งเองผ่าน QR
-- คำถามหลัก: คนที่ถือ QR ของโต๊ะ A ทำอะไรกับโต๊ะ B ได้บ้าง (คำตอบต้องคือ ไม่ได้)
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

do $$
declare
  v_plan    uuid;
  v_ta      cafe_tables;
  v_tb      cafe_tables;
  v_tc      cafe_tables;
  v_va      visits;
  v_vb      visits;
  v_pa      guest_passes;
  v_pb      guest_passes;
  v_menu    uuid;
  v_sess    jsonb;
  v_res     jsonb;
  v_bill    jsonb;
begin
  select id into v_plan from rate_plans where day_pass_cap = 199 limit 1;
  select * into v_ta from cafe_tables where code = 'A2';
  select * into v_tb from cafe_tables where code = 'B2';
  select * into v_tc from cafe_tables where code = 'A3';   -- ปล่อยว่างไว้
  select id into v_menu from menu_items where sku = 'D02';

  v_va := open_visit(array[v_ta.id], jsonb_build_array(
            jsonb_build_object('name', 'โต๊ะA-หนึ่ง', 'ratePlanId', v_plan),
            jsonb_build_object('name', 'โต๊ะA-สอง',  'ratePlanId', v_plan)));
  v_vb := open_visit(array[v_tb.id], jsonb_build_array(
            jsonb_build_object('name', 'โต๊ะB-หนึ่ง', 'ratePlanId', v_plan)));

  select * into v_pa from guest_passes where visit_id = v_va.id and display_name = 'โต๊ะA-หนึ่ง';
  select * into v_pb from guest_passes where visit_id = v_vb.id;

  -- อ่าน token ใหม่หลังเปิดโต๊ะ (ค่าเดิมอ่านมาก่อนก็ยังเหมือนเดิม แต่กันพลาด)
  select * into v_ta from cafe_tables where id = v_ta.id;
  select * into v_tb from cafe_tables where id = v_tb.id;
  select * into v_tc from cafe_tables where id = v_tc.id;

  -- ============================ สวมบทลูกค้า ============================
  set local role anon;

  -- สแกน QR โต๊ะ A
  v_sess := guest_session(v_ta.qr_token);
  perform assert_eq('เห็นรหัสโต๊ะตัวเอง', v_sess ->> 'tableCode', 'A2');
  perform assert_eq('เห็นรายชื่อคนในโต๊ะ 2 คน', jsonb_array_length(v_sess -> 'passes'), 2);
  perform assert_eq('เห็นเมนู', jsonb_array_length(v_sess -> 'menu') > 0, true);
  perform assert_eq('ไม่มี token โผล่ใน session', v_sess ? 'qrToken', false);

  -- โต๊ะที่ยังไม่เปิด สแกนได้แต่สั่งไม่ได้
  v_sess := guest_session(v_tc.qr_token);
  perform assert_eq('โต๊ะว่างไม่มี visit', v_sess ->> 'visitId', null::text);
  perform assert_eq('โต๊ะว่างไม่มีรายชื่อ', jsonb_array_length(v_sess -> 'passes'), 0);

  begin
    perform guest_place_order(v_tc.qr_token, null, 'shared',
      jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)), 'g-empty');
    raise exception 'FAIL  โต๊ะที่ยังไม่เปิดไม่ควรสั่งได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  โต๊ะที่ยังไม่เปิด สั่งของไม่ได้';
  end;

  -- QR ปลอม
  begin
    perform guest_session('00000000-0000-0000-0000-000000000000');
    raise exception 'FAIL  QR มั่วไม่ควรใช้ได้';
  exception when sqlstate 'P0002' then
    raise notice 'PASS  QR มั่วใช้ไม่ได้';
  end;

  -- สั่งของสำเร็จ เข้าครัวทันที
  v_res := guest_place_order(v_ta.qr_token, v_pa.id, 'owner',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 2)), 'g-1');
  perform assert_eq('ลูกค้าสั่งแล้วเข้าครัวทันที', v_res ->> 'status', 'placed');

  -- ยิงซ้ำ key เดิมไม่เกิดใบใหม่
  perform guest_place_order(v_ta.qr_token, v_pa.id, 'owner',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 2)), 'g-1');

  -- ถอดบทลูกค้าก่อน เพราะลูกค้าอ่านตาราง orders ตรงไม่ได้ (และไม่ควรได้)
  reset role;
  perform assert_eq('บันทึกว่าลูกค้าเป็นคนสั่งเอง',
    (select placed_by from orders where id = (v_res ->> 'orderId')::uuid),
    'guest'::placed_by_actor);
  perform assert_eq('ผูกกับ visit ของโต๊ะตัวเอง',
    (select visit_id from orders where id = (v_res ->> 'orderId')::uuid), v_va.id);
  perform assert_eq('ราคามาจาก DB',
    (select unit_price_snapshot from order_lines
      where order_id = (v_res ->> 'orderId')::uuid), 70::numeric);
  perform assert_eq('idempotency ฝั่งลูกค้าก็กันซ้ำ',
    (select count(*) from orders where visit_id = v_va.id), 1::bigint);
  set local role anon;

  -- ★ ใจกลางของเรื่อง: ใช้ QR โต๊ะ A สั่งให้คนโต๊ะ B
  begin
    perform guest_place_order(v_ta.qr_token, v_pb.id, 'owner',
      jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)), 'g-cross');
    raise exception 'FAIL  สั่งข้ามโต๊ะไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ใช้ QR โต๊ะ A สั่งให้คนโต๊ะ B ไม่ได้';
  end;

  -- ดูออเดอร์และบิลได้เฉพาะของโต๊ะตัวเอง
  perform assert_eq('เห็นออเดอร์ของโต๊ะตัวเอง',
    jsonb_array_length(guest_orders(v_ta.qr_token)), 1);
  perform assert_eq('ไม่เห็นออเดอร์โต๊ะอื่น',
    jsonb_array_length(guest_orders(v_tb.qr_token)), 0);

  v_bill := guest_bill(v_ta.qr_token);
  perform assert_eq('บิลเป็นของ visit ตัวเอง', v_bill ->> 'visitId', v_va.id::text);

  reset role;

  -- token ไม่หลุดผ่านผังโต๊ะสาธารณะ
  perform assert_eq('view สาธารณะไม่มีคอลัมน์ qr_token',
    (select count(*) from information_schema.columns
      where table_name = 'public_tables' and column_name = 'qr_token'), 0::bigint);
end;
$$;

-- ลูกค้าอ่าน cafe_tables ตรงไม่ได้แล้ว (ไม่งั้น token หลุด)
set role anon;
do $$
declare v_n bigint;
begin
  begin
    select count(*) into v_n from cafe_tables;
    raise exception 'FAIL  anon ไม่ควรอ่าน cafe_tables ได้แล้ว';
  exception when insufficient_privilege then
    raise notice 'PASS  anon อ่าน cafe_tables ตรงไม่ได้ (token ปลอดภัย)';
  end;

  select count(*) into v_n from public_tables;
  perform assert_eq('anon ยังอ่านผังโต๊ะผ่าน view ได้', v_n > 0, true);
end;
$$;

-- ช่องที่เคยเปิดไว้: anon เรียก preview_bill ด้วย visit id ของใครก็ได้
do $$
begin
  perform preview_bill('00000000-0000-0000-0000-000000000000');
  raise exception 'FAIL  anon ไม่ควรเรียก preview_bill ตรงได้แล้ว';
exception when insufficient_privilege then
  raise notice 'PASS  anon เรียก preview_bill ตรงไม่ได้แล้ว';
end;
$$;

-- แกนกลางการสั่งของเรียกตรงไม่ได้ (ข้ามการตรวจสิทธิ์ทั้งหมด)
do $$
begin
  perform place_order_core('x', '00000000-0000-0000-0000-000000000000', null,
                           'shared', 'guest', '[]'::jsonb);
  raise exception 'FAIL  anon ไม่ควรเรียก place_order_core ได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon เรียก place_order_core ตรงไม่ได้';
end;
$$;

reset role;

-- เปลี่ยน token แล้ว QR ใบเดิมต้องใช้ไม่ได้ทันที
do $$
declare
  v_t   cafe_tables;
  v_old uuid;
  v_new uuid;
begin
  select * into v_t from cafe_tables where code = 'A2';
  v_old := v_t.qr_token;
  v_new := rotate_table_token(v_t.id);
  perform assert_eq('token เปลี่ยนจริง', v_new <> v_old, true);

  set local role anon;
  begin
    perform guest_session(v_old);
    raise exception 'FAIL  QR ใบเก่าไม่ควรใช้ได้';
  exception when sqlstate 'P0002' then
    raise notice 'PASS  เปลี่ยน token แล้ว QR ใบเก่าใช้ไม่ได้';
  end;
  perform assert_eq('QR ใบใหม่ใช้ได้', guest_session(v_new) ->> 'tableCode', 'A2');
  reset role;
end;
$$;

select '=== ลูกค้าสั่งผ่าน QR ผ่านทั้งหมด ===' as result;
