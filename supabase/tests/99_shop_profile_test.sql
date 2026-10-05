-- ============================================================================
-- ชื่อร้านและโลโก้
--
-- คำถามที่ไฟล์นี้ตอบ: ใครเปลี่ยนหน้าตาร้านได้บ้าง — ต้องเป็นเจ้าของร้านเท่านั้น
-- ผู้จัดการแก้เมนู/ราคาได้ แต่ชื่อและโลโก้ไม่ได้ ลูกค้าอ่านได้แต่แตะไม่ได้
-- ============================================================================

insert into auth.users (id, email) values
  ('99999999-0000-4000-8000-0000000000f1', 'owner-brand@cafe.test'),
  ('99999999-0000-4000-8000-0000000000f2', 'manager-brand@cafe.test');

insert into staff (user_id, display_name, role) values
  ('99999999-0000-4000-8000-0000000000f1', 'เจ้าของทดสอบโลโก้', 'owner'),
  ('99999999-0000-4000-8000-0000000000f2', 'ผู้จัดการทดสอบโลโก้', 'manager');

-- ============================== ค่าเริ่มต้น ==============================
do $$
begin
  perform assert_eq('มีแถวตั้งต้นแถวเดียว', (select count(*) from shop_profile), 1::bigint);
  perform assert_eq('ชื่อตั้งต้น', (select name from shop_profile), 'Boardgame Cafe');
  perform assert_eq('ยังไม่มีโลโก้', (select logo_path from shop_profile), null::text);
  perform assert_eq('เจ้าของร้านมีสิทธิ์แก้หน้าตาร้าน',
    exists (select 1 from role_capabilities where role = 'owner' and capability = 'branding'), true);
  perform assert_eq('ผู้จัดการไม่มีสิทธิ์แก้หน้าตาร้าน',
    exists (select 1 from role_capabilities where role = 'manager' and capability = 'branding'), false);
  perform assert_eq('bucket โลโก้เปิดให้อ่านสาธารณะ',
    (select public from storage.buckets where id = 'shop-assets'), true);
  perform assert_eq('bucket โลโก้รับ PNG (พื้นใส)',
    (select 'image/png' = any(allowed_mime_types) from storage.buckets where id = 'shop-assets'), true);
end $$;

-- ============================== ผู้จัดการ ==============================
set "test.user_id" = '99999999-0000-4000-8000-0000000000f2';
set role authenticated;

do $$
begin
  begin
    perform update_shop_profile('ร้านของผู้จัดการ', '');
    raise exception 'FAIL  ผู้จัดการไม่ควรแก้ชื่อร้านได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  ผู้จัดการแก้ชื่อร้านไม่ได้';
  end;

  begin
    perform set_shop_logo('logo/manager.png');
    raise exception 'FAIL  ผู้จัดการไม่ควรเปลี่ยนโลโก้ได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  ผู้จัดการเปลี่ยนโลโก้ไม่ได้';
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('shop-assets', 'logo/manager.png');
    raise exception 'FAIL  ผู้จัดการไม่ควรอัปโหลดโลโก้ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  ผู้จัดการอัปโหลดไฟล์โลโก้ไม่ได้';
  end;
end $$;

reset role;

-- ============================== เจ้าของร้าน ==============================
set "test.user_id" = '99999999-0000-4000-8000-0000000000f1';
set role authenticated;

do $$
declare
  v_row shop_profile;
  v_old text;
begin
  v_row := update_shop_profile('  ร้านเกมป้าแดง  ', 'เล่นจนลืมเวลา');
  perform assert_eq('ตัดช่องว่างหน้าหลังชื่อ', v_row.name, 'ร้านเกมป้าแดง');
  perform assert_eq('บันทึกคำโปรย', v_row.tagline, 'เล่นจนลืมเวลา');

  begin
    perform update_shop_profile('   ', '');
    raise exception 'FAIL  ชื่อว่างไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ชื่อร้านว่างไม่ได้';
  end;

  begin
    perform update_shop_profile(repeat('ก', 61), '');
    raise exception 'FAIL  ชื่อยาวเกินไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ชื่อร้านยาวเกิน 60 ตัวไม่ได้';
  end;

  -- อัปไฟล์ได้ แล้วค่อยผูกเข้ากับร้าน
  insert into storage.objects (bucket_id, name, owner) values ('shop-assets', 'logo/one.png', auth.uid());
  raise notice 'PASS  เจ้าของร้านอัปโหลดไฟล์โลโก้ได้';

  v_old := set_shop_logo('logo/one.png');
  perform assert_eq('ครั้งแรกไม่มีโลโก้เดิม', v_old, null::text);
  v_old := set_shop_logo('logo/two.png');
  perform assert_eq('เปลี่ยนโลโก้แล้วได้ path เดิมคืนไปลบไฟล์', v_old, 'logo/one.png');

  begin
    perform set_shop_logo('https://evil.example/logo.png');
    raise exception 'FAIL  URL ภายนอกไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  โลโก้ต้องอยู่ใต้ logo/ ใน bucket ของเราเท่านั้น';
  end;

  v_old := set_shop_logo(null);
  perform assert_eq('ถอดโลโก้ได้', (select logo_path from shop_profile), null::text);

  -- แก้ตารางตรงไม่ได้ ต้องผ่าน RPC ที่ตรวจสิทธิ์และจดประวัติเท่านั้น
  begin
    update shop_profile set name = 'แอบแก้';
    raise exception 'FAIL  ไม่ควรแก้ตารางตรงได้';
  exception when insufficient_privilege then
    raise notice 'PASS  แก้ shop_profile ตรง ๆ ไม่ได้ แม้เป็นเจ้าของร้าน';
  end;
end $$;

reset role;

-- ================================ ลูกค้า ================================
set "test.user_id" = '';
set role anon;

do $$
begin
  perform assert_eq('ลูกค้าเห็นชื่อร้านใหม่', (select name from shop_profile), 'ร้านเกมป้าแดง');

  begin
    perform update_shop_profile('ร้านปลอม', '');
    raise exception 'FAIL  anon ไม่ควรเรียก update_shop_profile ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  ลูกค้าแก้ชื่อร้านไม่ได้';
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('shop-assets', 'logo/hack.png');
    raise exception 'FAIL  anon ไม่ควรอัปโหลดโลโก้ได้';
  exception when insufficient_privilege then
    raise notice 'PASS  ลูกค้าอัปโหลดโลโก้ไม่ได้';
  end;
end $$;

reset role;

-- คืนค่าเดิม ไม่ให้ไปกวนอย่างอื่น
update shop_profile set name = 'Boardgame Cafe', tagline = 'โรงเตี๊ยมนักเล่น', logo_path = null;
set "test.user_id" = '';

select '=== ชื่อร้านและโลโก้ผ่านทั้งหมด ===' as result;
