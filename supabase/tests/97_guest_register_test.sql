-- ============================================================================
-- ทดสอบลูกค้าลงชื่อตัวเองผ่าน QR
--
-- คำถามที่ไฟล์นี้ตอบ: "เปิดให้ลูกค้าสร้างคนเองแล้ว บิลยังเชื่อถือได้ไหม"
--
-- จุดที่ต้องระวังคือใครสแกน QR ได้ ก็สร้างคนที่ต้องจ่ายค่าเล่นได้
-- จึงต้องมีเพดาน และต้องมีทางให้พนักงานลบของที่สร้างผิดออก
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000097', 'register@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000097', 'พนักงานทดสอบลงชื่อ', 'manager');

set "test.user_id" = '99999999-0000-4000-8000-000000000097';

insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
values ('97000000-0000-4000-8000-0000000000a1', 'R1', 'ทดสอบลงชื่อ', 1, 20, false, 97);

-- ---------------------------------------------------------------------------
do $$
declare
  v_plan  uuid;
  v_table uuid := '97000000-0000-4000-8000-0000000000a1';
  v_token uuid;
  v_visit visits;
  v_res   jsonb;
  v_again jsonb;
  v_pass  uuid;
  v_menu  uuid;
  i       int;
begin
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;
  select id into v_menu from menu_items where available limit 1;

  -- โต๊ะยังไม่เปิด ลงชื่อไม่ได้
  select qr_token into v_token from cafe_tables where id = v_table;
  begin
    perform guest_register(v_token, 'คนมาก่อนเวลา');
    raise exception 'FAIL  โต๊ะยังไม่เปิดไม่ควรลงชื่อได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  โต๊ะยังไม่เปิด ลงชื่อไม่ได้';
  end;

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'คนจอง', 'ratePlanId', v_plan)));
  -- QR ผูกกับรอบที่เพิ่งเปิด ไม่ใช่สติกเกอร์ติดโต๊ะ (migration 1800)
  v_token := v_visit.qr_token;

  v_res := guest_register(v_token, '  เพื่อนเอ  ');
  perform assert_eq('ตัดช่องว่างหน้าหลังชื่อออก', v_res ->> 'displayName', 'เพื่อนเอ');
  perform assert_eq('ได้ pass ใบใหม่',
    (select count(*) from guest_passes where visit_id = v_visit.id), 2::bigint);

  -- ★ กดสองที หรือเปิดสองแท็บ ต้องไม่กลายเป็นสองคน
  v_again := guest_register(v_token, 'เพื่อนเอ');
  perform assert_eq('ลงชื่อซ้ำคืนใบเดิม', v_again ->> 'passId', v_res ->> 'passId');
  perform assert_eq('ไม่เกิดคนซ้ำ',
    (select count(*) from guest_passes where visit_id = v_visit.id), 2::bigint);

  v_again := guest_register(v_token, 'เพื่อนเอ   ');
  perform assert_eq('ชื่อต่างกันแค่ช่องว่างก็ยังเป็นคนเดิม',
    v_again ->> 'passId', v_res ->> 'passId');

  perform assert_eq('ได้เรทมาตรฐานของร้าน',
    (select rate_plan_id from guest_passes where id = (v_res ->> 'passId')::uuid), v_plan);

  begin
    perform guest_register(v_token, '   ');
    raise exception 'FAIL  ชื่อว่างไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ชื่อว่างลงไม่ได้';
  end;

  begin
    perform guest_register(v_token, repeat('ก', 41));
    raise exception 'FAIL  ชื่อยาวเกินไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ชื่อยาวเกินลงไม่ได้';
  end;

  -- เพดานกันกดรัว
  for i in 1..30 loop
    begin
      perform guest_register(v_token, 'ป่วน' || i);
    exception when sqlstate '22023' then
      exit;
    end;
  end loop;
  perform assert_eq('จำนวนคนไม่เกินเพดาน',
    (select count(*) from guest_passes where visit_id = v_visit.id) <= guest_register_limit(),
    true);

  -- ------------------------------------------------- ลบคนที่สร้างผิดออก --
  v_pass := (v_res ->> 'passId')::uuid;
  perform void_pass(v_pass);
  perform assert_eq('พนักงานลบคนที่สร้างผิดออกได้',
    (select count(*) from guest_passes where id = v_pass), 0::bigint);

  -- คนที่สั่งของไปแล้วลบไม่ได้ ไม่งั้นออเดอร์จะกลายเป็นของไม่มีเจ้าของ
  v_res := guest_register(v_token, 'คนสั่งของ');
  v_pass := (v_res ->> 'passId')::uuid;
  perform place_order('reg-ord-1', v_visit.id, v_pass, 'owner', 'staff',
    jsonb_build_array(jsonb_build_object('menuItemId', v_menu, 'qty', 1)), true);

  begin
    perform void_pass(v_pass);
    raise exception 'FAIL  คนที่สั่งของไปแล้วไม่ควรลบได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  คนที่สั่งของไปแล้วลบไม่ได้';
  end;

  -- คนที่จ่ายเงินไปแล้วก็ลบไม่ได้
  perform settle_pass(v_pass, '[]'::jsonb);
  begin
    perform void_pass(v_pass);
    raise exception 'FAIL  คนที่จ่ายแล้วไม่ควรลบได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  คนที่จ่ายเงินแล้วลบไม่ได้';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- โต๊ะต้องไม่ว่างคน และคนนอกต้องลบใครไม่ได้
-- ---------------------------------------------------------------------------
do $$
declare
  v_plan  uuid;
  v_table uuid;
  v_visit visits;
  v_only  uuid;
begin
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;

  insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
  values ('97000000-0000-4000-8000-0000000000a2', 'R2', 'ทดสอบลงชื่อ', 1, 6, false, 98);
  v_table := '97000000-0000-4000-8000-0000000000a2';

  v_visit := open_visit(array[v_table], jsonb_build_array(
    jsonb_build_object('name', 'คนเดียว', 'ratePlanId', v_plan)));
  select id into v_only from guest_passes where visit_id = v_visit.id;

  begin
    perform void_pass(v_only);
    raise exception 'FAIL  ลบจนโต๊ะไม่มีคนไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ลบจนโต๊ะไม่เหลือคนไม่ได้';
  end;
end $$;

do $$
begin
  perform assert_eq('ลูกค้าลงชื่อเองได้',
    has_function_privilege('anon', 'guest_register(uuid, text)', 'execute'), true);
  perform assert_eq('แต่ลูกค้าลบคนอื่นไม่ได้',
    has_function_privilege('anon', 'void_pass(uuid)', 'execute'), false);
end $$;

select '=== ลูกค้าลงชื่อตัวเองผ่านทั้งหมด ===' as result;
