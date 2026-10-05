-- ============================================================================
-- ลูกค้ารับชื่อที่พนักงานสร้างไว้ตอนเปิดโต๊ะ
--
-- เคสจริงที่เจอ: จอง 4 คน เช็คอินโดยไม่ได้พิมพ์ชื่อ → ได้ "ผู้เล่น 1–4"
-- ลูกค้าสแกน QR แล้วลงชื่อ ระบบกลับสร้างคนที่ 5 แทนที่จะเป็น 1 ใน 4 คนนั้น
-- ============================================================================

insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000098', 'claim@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-000000000098', 'พนักงานทดสอบรับชื่อ', 'staff');

set "test.user_id" = '99999999-0000-4000-8000-000000000098';

insert into cafe_tables (id, code, zone, seat_min, seat_max, allow_share, sort_order)
values ('98000000-0000-4000-8000-0000000000a1', 'CL1', 'ทดสอบรับชื่อ', 1, 8, false, 98),
       ('98000000-0000-4000-8000-0000000000a2', 'CL2', 'ทดสอบรับชื่อ', 1, 8, false, 99);

do $$
declare
  v_std    uuid;
  v_member uuid;
  v_visit  visits;
  v_other  visits;
  v_sess   jsonb;
  v_res    jsonb;
  v_p2     uuid;
  v_p3     uuid;
  v_p4     uuid;
  v_stran  uuid;
begin
  select id into v_std from rate_plans where active order by sort_order, name limit 1;
  select id into v_member from rate_plans where active and id <> v_std order by sort_order, name limit 1;

  -- พนักงานเช็คอิน 4 คนโดยไม่พิมพ์ชื่อ (หน้าจอใส่ "ผู้เล่น N" ให้เอง)
  -- คนที่ 2 เป็นสมาชิก พนักงานเลือกเรทไว้แล้ว
  v_visit := open_visit(array['98000000-0000-4000-8000-0000000000a1'::uuid], jsonb_build_array(
    jsonb_build_object('name', 'ผู้เล่น 1', 'ratePlanId', v_std),
    jsonb_build_object('name', 'ผู้เล่น 2', 'ratePlanId', v_member),
    jsonb_build_object('name', 'ผู้เล่น 3', 'ratePlanId', v_std),
    jsonb_build_object('name', 'ผู้เล่น 4', 'ratePlanId', v_std)));
  v_other := open_visit(array['98000000-0000-4000-8000-0000000000a2'::uuid], jsonb_build_array(
    jsonb_build_object('name', 'คนโต๊ะอื่น', 'ratePlanId', v_std)));

  select id into v_p2 from guest_passes where visit_id = v_visit.id and display_name = 'ผู้เล่น 2';
  select id into v_p3 from guest_passes where visit_id = v_visit.id and display_name = 'ผู้เล่น 3';
  select id into v_p4 from guest_passes where visit_id = v_visit.id and display_name = 'ผู้เล่น 4';
  select id into v_stran from guest_passes where visit_id = v_other.id;

  -- ============================ สวมบทลูกค้า ============================
  set local role anon;

  v_sess := guest_session(v_visit.qr_token);
  perform assert_eq('เห็นทั้ง 4 คนที่พนักงานสร้างไว้',
    jsonb_array_length(v_sess -> 'passes'), 4);
  perform assert_eq('ยังไม่มีใครรับชื่อ',
    (select count(*) from jsonb_array_elements(v_sess -> 'passes') p
      where (p ->> 'claimed')::boolean), 0::bigint);

  -- ★ ลูกค้าแตะ "ผู้เล่น 2" แล้วใส่ชื่อจริง
  v_res := guest_claim(v_visit.qr_token, v_p2, '  แนน  ');
  perform assert_eq('รับใบเดิม ไม่ได้ใบใหม่', v_res ->> 'passId', v_p2::text);
  perform assert_eq('เปลี่ยนชื่อเป็นชื่อจริง', v_res ->> 'displayName', 'แนน');

  v_sess := guest_session(v_visit.qr_token);
  perform assert_eq('โต๊ะยังมี 4 คน ไม่ใช่ 5', jsonb_array_length(v_sess -> 'passes'), 4);
  perform assert_eq('ใบที่รับแล้วถูกทำเครื่องหมาย',
    (select (p ->> 'claimed')::boolean from jsonb_array_elements(v_sess -> 'passes') p
      where p ->> 'id' = v_p2::text), true);

  -- รับโดยไม่เปลี่ยนชื่อ = ใช้ชื่อเดิม
  v_res := guest_claim(v_visit.qr_token, v_p3, null);
  perform assert_eq('ไม่ใส่ชื่อก็ใช้ชื่อเดิม', v_res ->> 'displayName', 'ผู้เล่น 3');

  -- ใบที่มีคนรับไปแล้ว อีกเครื่องรับซ้ำไม่ได้
  begin
    perform guest_claim(v_visit.qr_token, v_p2, 'คนแอบอ้าง');
    raise exception 'FAIL  รับชื่อที่มีเจ้าของแล้วไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  รับชื่อที่มีคนรับไปแล้วไม่ได้';
  end;

  -- คนเดิมที่ล้างเครื่องไป ลงชื่อด้วยชื่อเดิมแล้วได้ใบเดิมคืน
  v_res := guest_register(v_visit.qr_token, 'แนน');
  perform assert_eq('ลงชื่อด้วยชื่อเดิมได้ใบเดิม', v_res ->> 'passId', v_p2::text);

  -- ใช้ QR โต๊ะนี้รับชื่อคนโต๊ะอื่นไม่ได้
  begin
    perform guest_claim(v_visit.qr_token, v_stran, 'ข้ามโต๊ะ');
    raise exception 'FAIL  รับชื่อข้ามโต๊ะไม่ควรได้';
  exception when sqlstate 'P0002' then
    raise notice 'PASS  ใช้ QR โต๊ะหนึ่งรับชื่อคนอีกโต๊ะไม่ได้';
  end;

  -- ชื่อซ้ำกับคนอื่นในโต๊ะ ตอนแยกบิลจะแยกไม่ออก
  begin
    perform guest_claim(v_visit.qr_token, v_p4, 'แนน');
    raise exception 'FAIL  ชื่อซ้ำในโต๊ะไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ตั้งชื่อซ้ำคนอื่นในโต๊ะไม่ได้';
  end;

  -- คนที่ไม่อยู่ในรายชื่อจริง ๆ ยังลงชื่อใหม่ได้เหมือนเดิม
  v_res := guest_register(v_visit.qr_token, 'มาเพิ่ม');
  perform assert_eq('ลงชื่อใหม่ได้คนที่ 5', jsonb_array_length(guest_session(v_visit.qr_token) -> 'passes'), 5);
  perform assert_eq('คนที่ลงชื่อใหม่นับว่ารับแล้ว',
    (select (p ->> 'claimed')::boolean from jsonb_array_elements(guest_session(v_visit.qr_token) -> 'passes') p
      where p ->> 'id' = v_res ->> 'passId'), true);

  reset role;

  -- ★ เรทที่พนักงานเลือกไว้ติดไปกับใบ ไม่โดนเปลี่ยนเป็นเรทมาตรฐาน
  perform assert_eq('รับชื่อแล้วยังเป็นเรทสมาชิก',
    (select rate_plan_id from guest_passes where id = v_p2), v_member);
  perform assert_eq('ไม่ได้สร้างคนเกินจากการรับชื่อ',
    (select count(*) from guest_passes where visit_id = v_visit.id), 5::bigint);

  perform close_visit(v_visit.id);
  perform close_visit(v_other.id);
end $$;

do $$
begin
  perform assert_eq('ลูกค้ารับชื่อได้',
    has_function_privilege('anon', 'guest_claim(uuid, uuid, text)', 'execute'), true);
end $$;

reset "test.user_id";

select '=== ลูกค้ารับชื่อที่พนักงานสร้างไว้ผ่านทั้งหมด ===' as result;
