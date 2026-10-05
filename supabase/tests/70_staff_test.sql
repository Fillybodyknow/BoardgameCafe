-- ============================================================================
-- จัดการบัญชีพนักงาน + ล็อกอินด้วย username
--
-- คำถามสำคัญที่สุดไม่ใช่ "เพิ่มพนักงานได้ไหม" แต่คือ
-- "มีทางไหนที่ร้านจะล็อกตัวเองจนไม่มีใครเข้าไปแก้อะไรได้อีก"
-- ============================================================================

-- การจัดการบัญชีพนักงานเป็นสิทธิ์ของตัวเอง (accounts) ไม่ได้ติดมากับการตั้งค่าร้าน
-- ผู้จัดการจึงทำส่วนนี้ไม่ได้แล้ว ต้องใช้คนที่ถือสิทธิ์นั้น
insert into auth.users (id, email)
values ('99999999-0000-4000-8000-000000000004', 'admin@cafe.test');
insert into staff (user_id, username, display_name, role)
values ('99999999-0000-4000-8000-000000000004', 'admin', 'ผู้ดูแลบัญชี', 'owner');

set "test.user_id" = '99999999-0000-4000-8000-000000000004';  -- มีสิทธิ์ accounts

-- ============================ ล็อกอินด้วย username ============================

do $$
declare v_email text;
begin
  -- บัญชีเดิมถูกเติม username จากส่วนหน้า @ ของอีเมลให้อัตโนมัติ
  perform assert_eq('บัญชีเดิมได้ username จากอีเมล',
    (select username from staff where user_id = '99999999-0000-4000-8000-000000000001'),
    'staff');

  set local role anon;

  v_email := login_email_for('staff');
  perform assert_eq('แปลง username เป็นอีเมลที่ใช้ล็อกอินได้', v_email, 'staff@cafe.test');

  perform assert_eq('ไม่สนตัวพิมพ์ใหญ่เล็ก', login_email_for('STAFF'), 'staff@cafe.test');
  perform assert_eq('ตัดช่องว่างหัวท้าย', login_email_for('  staff  '), 'staff@cafe.test');

  -- พิมพ์อีเมลเต็มมาก็ยังใช้ได้ รองรับบัญชีที่สร้างก่อนมีระบบ username
  perform assert_eq('ใส่อีเมลเต็มก็ผ่าน',
    login_email_for('owner@example.com'), 'owner@example.com');

  -- ชื่อที่ไม่มีอยู่ต้องไม่บอกว่าไม่มี — คืนอีเมลปลอมให้ไปล้มที่ขั้นรหัสผ่านแทน
  v_email := login_email_for('ไม่มีคนนี้แน่นอน');
  perform assert_eq('ชื่อที่ไม่มีอยู่ไม่เปิดเผยว่าไม่มี',
    v_email like '%@invalid.local', true);

  reset role;
end;
$$;

-- ============================ เพิ่มพนักงานใหม่ ============================

do $$
declare
  v_new  uuid := '99999999-0000-4000-8000-00000000000a';
  v_row  staff;
begin
  insert into auth.users (id, email) values (v_new, 'somchai@staff.local');

  -- register_staff ถูกเรียกจาก Edge Function ด้วย service_role ซึ่ง auth.uid()
  -- เป็น null จึงต้องบอกว่าใครเป็นคนสั่งผ่าน p_actor
  v_row := register_staff(v_new, 'somchai', 'สมชาย', 'staff',
                          '99999999-0000-4000-8000-000000000004');
  perform assert_eq('เพิ่มพนักงานได้', v_row.display_name, 'สมชาย');
  perform assert_eq('เก็บ username', v_row.username, 'somchai');
  perform assert_eq('บันทึกว่าใครเป็นคนเพิ่ม',
    (select actor from audit_log where action = 'register_staff' and entity_id = v_new),
    '99999999-0000-4000-8000-000000000004'::uuid);

  perform assert_eq('ล็อกอินด้วย username ใหม่ได้',
    login_email_for('somchai'), 'somchai@staff.local');
end;
$$;

-- ---------------------------- ข้อมูลไม่ถูกต้อง ----------------------------

do $$
declare
  v_tmp uuid := '99999999-0000-4000-8000-00000000000b';
  v_mgr uuid := '99999999-0000-4000-8000-000000000004';  -- ผู้สั่ง ต้องมีสิทธิ์ accounts
  v_row staff;
begin
  insert into auth.users (id, email) values (v_tmp, 'tmp@staff.local');

  begin
    perform register_staff(v_tmp, 'somchai', 'ซ้ำ', 'staff', v_mgr);
    raise exception 'FAIL  username ซ้ำไม่ควรผ่าน';
  exception when sqlstate '23505' then
    raise notice 'PASS  username ซ้ำไม่ได้';
  end;

  -- พิมพ์ตัวใหญ่มาให้แปลงเป็นเล็กให้ ไม่ใช่ปฏิเสธ — ใจดีกว่าและกันชื่อซ้ำ
  -- แบบที่ต่างกันแค่ตัวพิมพ์
  v_row := register_staff(v_tmp, 'SomChai2', 'ตัวใหญ่', 'staff', v_mgr);
  perform assert_eq('ตัวพิมพ์ใหญ่ถูกแปลงเป็นเล็ก', v_row.username, 'somchai2');

  insert into auth.users (id, email)
  values ('99999999-0000-4000-8000-00000000000e', 'tmp2@staff.local');
  v_tmp := '99999999-0000-4000-8000-00000000000e';

  begin
    perform register_staff(v_tmp, 'ab', 'สั้นไป', 'staff', v_mgr);
    raise exception 'FAIL  username สั้นเกินไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  username ต้องยาวอย่างน้อย 3 ตัว';
  end;

  begin
    perform register_staff(v_tmp, 'มานี', 'ภาษาไทย', 'staff', v_mgr);
    raise exception 'FAIL  username ภาษาไทยไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  username ต้องเป็น a-z 0-9 เท่านั้น';
  end;

  begin
    perform register_staff(v_tmp, 'nobody', '', 'staff', v_mgr);
    raise exception 'FAIL  ไม่ใส่ชื่อไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ต้องใส่ชื่อพนักงาน';
  end;

  -- ระดับที่ไม่มีอยู่จริงต้องถูกปฏิเสธ
  begin
    perform register_staff(v_tmp, 'nobody', 'ระดับมั่ว', 'superuser', v_mgr);
    raise exception 'FAIL  ระดับที่ไม่มีอยู่ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ตั้งระดับที่ไม่มีอยู่ไม่ได้';
  end;

  -- พนักงานหน้าร้านเพิ่มคนไม่ได้เลย
  begin
    perform register_staff(v_tmp, 'nobody', 'x', 'staff',
                           '99999999-0000-4000-8000-000000000003');
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรเพิ่มคนได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาเพิ่มบัญชีไม่ได้';
  end;
end;
$$;

-- ============================ เปลี่ยนสิทธิ์/ปิดใช้งาน ============================

do $$
declare
  v_new uuid := '99999999-0000-4000-8000-00000000000a';
  v_row staff;
begin
  v_row := set_staff_role(v_new, 'manager');
  perform assert_eq('เลื่อนเป็นผู้จัดการได้', v_row.role, 'manager');
  v_row := set_staff_role(v_new, 'staff');
  perform assert_eq('ลดกลับเป็นพนักงานได้', v_row.role, 'staff');

  begin
    perform set_staff_role(v_new, 'superuser');
    raise exception 'FAIL  ระดับที่ไม่มีอยู่ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ตั้งระดับสิทธิ์ที่ไม่มีอยู่ไม่ได้';
  end;


  -- เปลี่ยนสิทธิ์ตัวเองไม่ได้ (ผู้สั่งตอนนี้คือ ...0004)
  begin
    perform set_staff_role('99999999-0000-4000-8000-000000000004', 'staff');
    raise exception 'FAIL  เปลี่ยนสิทธิ์ตัวเองไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้';
  end;

  -- ปิดบัญชีตัวเองไม่ได้
  begin
    perform set_staff_active('99999999-0000-4000-8000-000000000004', false);
    raise exception 'FAIL  ปิดบัญชีตัวเองไม่ควรได้';
  exception when sqlstate '22023' then
    raise notice 'PASS  ปิดการใช้งานบัญชีตัวเองไม่ได้';
  end;

  v_row := set_staff_active(v_new, false);
  perform assert_eq('ปิดการใช้งานคนอื่นได้', v_row.active, false);
  perform assert_eq('คนที่ถูกปิดไม่นับเป็นพนักงานแล้ว',
    (select count(*) from staff where user_id = v_new and active), 0::bigint);
  v_row := set_staff_active(v_new, true);
  perform assert_eq('เปิดกลับได้', v_row.active, true);

  v_row := rename_staff(v_new, 'สมชาย ใจดี');
  perform assert_eq('เปลี่ยนชื่อได้', v_row.display_name, 'สมชาย ใจดี');

  perform assert_eq('รายชื่อมีครบทุกคนพร้อมอีเมล',
    (select count(*) from jsonb_array_elements(list_staff()) e
      where e ->> 'email' is not null) >= 3, true);
end;
$$;

-- หมายเหตุ: กฎ "ต้องเหลือคนที่จัดการบัญชีได้อย่างน้อย 1 คน" ย้ายไปอยู่ใน
-- 80_capability_test.sql แล้ว เพราะตอนนี้ผูกกับสิทธิ์ accounts ไม่ใช่ชื่อ role
-- 'owner' การมีเทสต์สองชุดที่เช็คกฎเดียวกันคนละนิยามจะเพี้ยนจากกันแน่นอน

-- ============================ ขอบเขตสิทธิ์ ============================

set "test.user_id" = '99999999-0000-4000-8000-000000000003';  -- พนักงานหน้าร้าน

do $$
begin
  begin
    perform list_staff();
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรดูรายชื่อพนักงานได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาดูรายชื่อพนักงานไม่ได้';
  end;

  begin
    perform set_staff_role('99999999-0000-4000-8000-00000000000a', 'owner');
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรเปลี่ยนสิทธิ์ใครได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาเปลี่ยนสิทธิ์คนอื่นไม่ได้';
  end;

  begin
    perform set_staff_active('99999999-0000-4000-8000-00000000000a', false);
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรปิดบัญชีใครได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาปิดบัญชีคนอื่นไม่ได้';
  end;
end;
$$;

set "test.user_id" = '99999999-0000-4000-8000-000000000004';

select '=== จัดการบัญชีพนักงานผ่านทั้งหมด ===' as result;
