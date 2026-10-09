-- ============================================================================
-- จองโต๊ะออนไลน์
--
-- โจทย์: ลูกค้าที่ไม่ล็อกอินจองโต๊ะได้ แต่ต้องจองทับกันไม่ได้
--        และเปิดดูรายการของคนอื่นไม่ได้
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';

-- เวลาอ้างอิง: พรุ่งนี้ 14:00 ตามเวลาไทย แปลงกลับเป็น timestamptz
-- (ใช้เวลาในอนาคตเสมอ ไม่งั้นติดกติกา "ต้องจองล่วงหน้า")
do $$
declare
  v_tb    cafe_tables;
  v_share cafe_tables;
  v_start timestamptz;
  v_res   jsonb;
  v_code  text;
  v_id    uuid;
  v_n     int;
begin
  select * into v_tb    from cafe_tables where code = 'B2';
  select * into v_share from cafe_tables where code = 'C1';   -- allow_share

  v_start := ((now() at time zone 'Asia/Bangkok')::date + 1 + time '14:00')
             at time zone 'Asia/Bangkok';

  -- ======================= สวมบทลูกค้าที่ไม่ล็อกอิน =======================
  set local role anon;

  -- ผังโต๊ะพร้อมสถานะว่าง
  v_res := available_tables(v_start, 120);
  perform assert_eq('เห็นผังโต๊ะครบทุกโต๊ะ', jsonb_array_length(v_res), 8);
  perform assert_eq('ผังที่ลูกค้าเห็นไม่มี qr_token',
    (v_res -> 0) ? 'qrToken', false);
  perform assert_eq('โต๊ะ B2 ว่างอยู่',
    (select (e ->> 'available')::boolean from jsonb_array_elements(v_res) e
      where e ->> 'code' = 'B2'), true);

  -- จองสำเร็จ
  v_res := create_reservation('คุณทดสอบ', '081-111-2222', 4, v_start, 120,
                              array[v_tb.id], 'ขอโต๊ะริมหน้าต่าง');
  v_code := v_res ->> 'code';
  perform assert_eq('ได้สถานะรอยืนยัน', v_res ->> 'status', 'pending');
  perform assert_eq('ได้รหัสจอง 6 ตัว', length(v_code), 6);
  perform assert_eq('รหัสไม่มีตัวที่สับสน (0/O/1/I)', v_code ~ '[01OI]', false);

  -- โต๊ะเดิมช่วงเวลาเดียวกันต้องไม่ว่างแล้ว
  perform assert_eq('โต๊ะที่เพิ่งถูกจอง ขึ้นว่าไม่ว่าง',
    (select (e ->> 'available')::boolean
       from jsonb_array_elements(available_tables(v_start, 120)) e
      where e ->> 'code' = 'B2'), false);

  begin
    perform create_reservation('คนอื่น', '082-222-3333', 2, v_start, 120, array[v_tb.id]);
    raise exception 'FAIL  จองทับช่วงเวลาเดิมไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองทับช่วงเวลาเดิมไม่ได้';
  end;

  -- คาบเกี่ยวบางส่วนก็ต้องติด (เริ่ม 15:00 ขณะที่รอบเดิม 14:00-16:00)
  begin
    perform create_reservation('คาบเกี่ยว', '083-333-4444', 2,
      v_start + interval '1 hour', 120, array[v_tb.id]);
    raise exception 'FAIL  จองคาบเกี่ยวไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองคาบเกี่ยวบางส่วนไม่ได้';
  end;

  -- ติด buffer ด้วย (รอบเดิมจบ 16:00 + buffer 15 นาที)
  begin
    perform create_reservation('ชิดเกิน', '084-444-5555', 2,
      v_start + interval '2 hours 5 minutes', 120, array[v_tb.id]);
    raise exception 'FAIL  จองชิดรอบเดิมเกินไปไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เว้น buffer เก็บโต๊ะระหว่างรอบ';
  end;

  -- ห่างพอแล้วจองได้
  perform create_reservation('รอบถัดไป', '085-555-6666', 2,
    v_start + interval '3 hours', 120, array[v_tb.id]);
  raise notice 'PASS  เว้นระยะพอแล้วจองรอบถัดไปได้';

  -- ★ โต๊ะยาวก็จองซ้อนไม่ได้แล้ว (เปลี่ยนกติกาตั้งแต่ migration 2400)
  --
  -- ของเดิมยกเว้นให้โต๊ะที่นั่งร่วมได้ แต่หน้างานกลายเป็นว่าร้านติ๊กช่องนี้
  -- ไว้ทุกโต๊ะ ผลคือรับจองเวลาเดียวกันได้ไม่จำกัด และลูกค้าไม่เห็นว่าไม่ว่าง
  -- allow_share จึงเหลือผลกับลูกค้าที่เดินเข้ามานั่งเท่านั้น
  perform create_reservation('กลุ่มA', '086-000-0001', 4, v_start, 120, array[v_share.id]);
  begin
    perform create_reservation('กลุ่มB', '086-000-0002', 4, v_start, 120, array[v_share.id]);
    raise exception 'FAIL  โต๊ะยาวก็ไม่ควรรับจองซ้อน';
  exception when sqlstate '22023' then
    raise notice 'PASS  โต๊ะยาวรับจองซ้อนไม่ได้แล้ว';
  end;

  -- ตรงนี้สวมบท anon อยู่ จึงถามผ่าน available_tables เหมือนที่หน้าจองถาม
  perform assert_eq('โต๊ะยาวที่ถูกจองแล้ว ขึ้นว่าไม่ว่างบนหน้าจอง',
    (select (l ->> 'available')::boolean
       from jsonb_array_elements(available_tables(v_start, 120)) l
      where (l ->> 'id')::uuid = v_share.id),
    false);

  -- ------------------------------ กติกาเวลา ------------------------------

  begin
    perform create_reservation('เมื่อวาน', '087-777-8888', 2,
      now() - interval '1 day', 120, array[v_tb.id]);
    raise exception 'FAIL  จองย้อนหลังไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองย้อนหลังไม่ได้';
  end;

  begin
    perform create_reservation('ก่อนร้านเปิด', '087-777-8801', 2,
      ((now() at time zone 'Asia/Bangkok')::date + 1 + time '09:00') at time zone 'Asia/Bangkok',
      120, array[v_tb.id]);
    raise exception 'FAIL  จองก่อนร้านเปิดไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองก่อนร้านเปิด (11:00) ไม่ได้';
  end;

  begin
    perform create_reservation('เลยร้านปิด', '087-777-8802', 2,
      ((now() at time zone 'Asia/Bangkok')::date + 1 + time '22:00') at time zone 'Asia/Bangkok',
      180, array[v_tb.id]);
    raise exception 'FAIL  จองเลยเวลาปิดไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ต้องเล่นจบก่อนร้านปิด (23:00)';
  end;

  begin
    perform create_reservation('ไกลเกิน', '087-777-8803', 2,
      now() + interval '60 days', 120, array[v_tb.id]);
    raise exception 'FAIL  จองล่วงหน้าเกินกรอบไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองล่วงหน้าเกิน 30 วันไม่ได้';
  end;

  -- ---------------------------- ข้อมูลไม่ครบ ----------------------------

  begin
    perform create_reservation('', '088-888-9999', 2, v_start + interval '6 hours', 120,
      array[(select id from public_tables where code = 'A3')]);
    raise exception 'FAIL  ไม่ใส่ชื่อไม่ควรจองได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ต้องใส่ชื่อผู้จอง';
  end;

  begin
    perform create_reservation('เบอร์สั้น', '123', 2, v_start + interval '6 hours', 120,
      array[(select id from public_tables where code = 'A3')]);
    raise exception 'FAIL  เบอร์ไม่ถูกต้องไม่ควรจองได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เบอร์โทรต้องถูกต้อง';
  end;

  -- คนเกินที่นั่ง
  begin
    perform create_reservation('คนเยอะ', '089-999-0000', 20, v_start + interval '6 hours', 120,
      array[(select id from public_tables where code = 'A3')]);
    raise exception 'FAIL  จองเกินจำนวนที่นั่งไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  จองเกินจำนวนที่นั่งไม่ได้';
  end;

  -- กันจองมั่ว: เบอร์เดียวค้างได้ 3 รายการ
  perform create_reservation('ซ้ำ1', '090-000-0000', 2,
    v_start + interval '6 hours', 120, array[(select id from public_tables where code = 'A1')]);
  perform create_reservation('ซ้ำ2', '090-000-0000', 2,
    v_start + interval '6 hours', 120, array[(select id from public_tables where code = 'A2')]);
  perform create_reservation('ซ้ำ3', '090-000-0000', 2,
    v_start + interval '6 hours', 120, array[(select id from public_tables where code = 'A3')]);
  begin
    perform create_reservation('ซ้ำ4', '090-000-0000', 2,
      v_start + interval '6 hours', 120, array[(select id from public_tables where code = 'B1')]);
    raise exception 'FAIL  เบอร์เดียวจองค้างเกินโควตาไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เบอร์เดียวจองค้างได้ไม่เกิน 3 รายการ';
  end;

  -- ------------------------- เปิดดู/ยกเลิกด้วยรหัส -------------------------

  v_res := reservation_by_code(v_code, '081-111-2222');
  perform assert_eq('เปิดดูด้วยรหัส+เบอร์ได้', v_res ->> 'customerName', 'คุณทดสอบ');
  perform assert_eq('รหัสพิมพ์เล็กก็ใช้ได้',
    reservation_by_code(lower(v_code), '0811112222') ->> 'code', v_code);

  begin
    perform reservation_by_code(v_code, '099-999-9999');
    raise exception 'FAIL  รหัสถูกแต่เบอร์ผิดไม่ควรเปิดดูได้';
  exception when sqlstate 'P0002' then
    raise notice 'PASS  รหัสถูกแต่เบอร์ผิด เปิดดูไม่ได้';
  end;

  perform assert_eq('ยกเลิกเองได้',
    cancel_reservation_by_code(v_code, '081-111-2222') ->> 'status', 'cancelled');

  begin
    perform cancel_reservation_by_code(v_code, '081-111-2222');
    raise exception 'FAIL  ยกเลิกซ้ำไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ยกเลิกซ้ำไม่ได้';
  end;

  perform assert_eq('ยกเลิกแล้วโต๊ะกลับมาว่าง',
    (select (e ->> 'available')::boolean
       from jsonb_array_elements(available_tables(v_start, 120)) e
      where e ->> 'code' = 'B2'), true);

  -- ลูกค้าอ่านตาราง reservations ตรงไม่ได้
  begin
    select count(*) into v_n from reservations;
    raise exception 'FAIL  anon ไม่ควรอ่าน reservations ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  anon อ่านตาราง reservations ตรงไม่ได้';
  end;

  reset role;
end;
$$;

-- ============================ ฝั่งพนักงาน ============================

do $$
declare
  v_start timestamptz;
  v_res   jsonb;
  v_id    uuid;
  v_visit visits;
  v_n     int;
  v_msg   text;
begin
  v_start := ((now() at time zone 'Asia/Bangkok')::date + 2 + time '18:00')
             at time zone 'Asia/Bangkok';

  set local role anon;
  v_res := create_reservation('คุณเช็คอิน', '091-234-5678', 3, v_start, 120,
                              array[(select id from public_tables where code = 'B3')]);
  reset role;

  select id into v_id from reservations where code = v_res ->> 'code';

  perform confirm_reservation(v_id);
  perform assert_eq('พนักงานยืนยันได้',
    (select status from reservations where id = v_id), 'confirmed'::reservation_status);
  perform assert_eq('บันทึกเวลาที่ยืนยัน',
    (select confirmed_at is not null from reservations where id = v_id), true);
  begin
    perform confirm_reservation(v_id);
    raise exception 'FAIL  ยืนยันซ้ำไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ยืนยันซ้ำไม่ได้';
  end;

  -- เช็คอิน → เปิด visit จากโต๊ะที่จองไว้
  v_visit := seat_reservation(v_id, jsonb_build_array(
    jsonb_build_object('name', 'แขก1', 'ratePlanId', (select id from rate_plans limit 1)),
    jsonb_build_object('name', 'แขก2', 'ratePlanId', (select id from rate_plans limit 1))));

  perform assert_eq('visit ถูกสร้างจากการจอง', v_visit.source, 'reservation'::visit_source);
  perform assert_eq('ผูก visit กลับไปที่รายการจอง',
    (select visit_id from reservations where id = v_id), v_visit.id);
  perform assert_eq('สถานะเป็นนั่งแล้ว',
    (select status from reservations where id = v_id), 'seated'::reservation_status);
  perform assert_eq('โต๊ะถูกจับจอง',
    (select status from cafe_tables where code = 'B3'), 'occupied'::table_status);
  perform assert_eq('ผู้เล่นถูกสร้างครบ',
    (select count(*) from guest_passes where visit_id = v_visit.id), 2::bigint);

  begin
    perform seat_reservation(v_id, '[]'::jsonb);
    raise exception 'FAIL  เช็คอินซ้ำไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เช็คอินซ้ำไม่ได้';
  end;

  -- โต๊ะที่จองไว้ยังมีกลุ่มก่อนหน้านั่งอยู่ ต้องบอกให้ชัด ไม่ใช่ชน constraint
  set local role anon;
  v_res := create_reservation('มาแล้วโต๊ะไม่ว่าง', '093-111-2222', 2,
    v_start + interval '3 hours', 120,
    array[(select id from public_tables where code = 'A2')]);
  reset role;
  select id into v_id from reservations where code = v_res ->> 'code';

  begin
    perform seat_reservation(v_id, jsonb_build_array(jsonb_build_object(
      'name', 'x', 'ratePlanId', (select id from rate_plans limit 1))));
    raise exception 'FAIL  โต๊ะไม่ว่างไม่ควรเช็คอินได้';
  exception when sqlstate '22023' then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%ยังมีลูกค้าอยู่%' then
      raise exception 'FAIL  ข้อความไม่ได้บอกว่าโต๊ะไม่ว่าง: %', v_msg;
    end if;
    raise notice 'PASS  โต๊ะไม่ว่างแจ้งชัดว่าโต๊ะไหนติด';
  end;

  -- ย้ายไปโต๊ะว่างแทนได้
  v_visit := seat_reservation(v_id, jsonb_build_array(jsonb_build_object(
    'name', 'y', 'ratePlanId', (select id from rate_plans limit 1))),
    array[(select id from cafe_tables where code = 'A3')]);
  perform assert_eq('ย้ายโต๊ะตอนเช็คอินได้',
    (select status from cafe_tables where code = 'A3'), 'occupied'::table_status);
  perform assert_eq('บันทึกโต๊ะที่นั่งจริง',
    (select code from cafe_tables
      where id = (select table_ids[1] from reservations where id = v_id)), 'A3');

  -- ปล่อยโต๊ะคนที่ไม่มา
  insert into reservations (code, customer_name, phone, party_size, start_at,
                            duration_minutes, table_ids, status, source)
  values ('NOSHOW', 'คนไม่มา', '092-000-0000', 2,
          now() - interval '2 hours', 120,
          array[(select id from public_tables where code = 'A1')], 'confirmed', 'online');

  v_n := release_overdue_reservations();
  perform assert_eq('ปล่อยรายการที่เลยเวลาแล้ว', v_n >= 1, true);
  perform assert_eq('สถานะเปลี่ยนเป็นไม่มา',
    (select status from reservations where code = 'NOSHOW'), 'no_show'::reservation_status);

  -- รายการที่ยังไม่ถึงเวลาต้องไม่โดนปล่อย
  perform assert_eq('รายการในอนาคตไม่ถูกแตะ',
    (select count(*) from reservations
      where start_at > now() and status in ('pending', 'confirmed')) > 0, true);
end;
$$;

-- หมายเหตุ: การตรวจว่า anon เรียกฟังก์ชันไหนได้บ้าง ทำแบบครอบคลุมทั้ง schema
-- อยู่แล้วใน 20_operations_test.sql จึงไม่ตรวจซ้ำที่นี่

select '=== จองออนไลน์ผ่านทั้งหมด ===' as result;
