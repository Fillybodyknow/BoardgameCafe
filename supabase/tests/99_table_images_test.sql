-- ============================================================================
-- รูปประกอบโต๊ะ
--
-- คำถามที่ไฟล์นี้ตอบ: "ลูกค้าที่ยังไม่ได้ล็อกอินเห็นรูปโต๊ะได้ แต่แก้ไม่ได้ใช่ไหม"
--
-- Storage มี RLS แยกจากตารางปกติ เทสต์ตรวจสิทธิ์ฟังก์ชันชุดอื่นไม่ครอบถึง
-- จึงต้องถามใหม่หมดเหมือนที่ทำกับรูปเมนู
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';  -- manager

do $$
declare
  v_table cafe_tables;
  v_old   text;
begin
  select * into v_table from cafe_tables where code = 'A1';

  perform assert_eq('bucket ถูกสร้างและเปิดให้อ่านสาธารณะ',
    (select public from storage.buckets where id = 'table-images'), true);
  perform assert_eq('bucket จำกัดขนาดไฟล์',
    (select file_size_limit from storage.buckets where id = 'table-images'), 3145728::bigint);
  perform assert_eq('bucket รับเฉพาะ JPEG',
    (select allowed_mime_types from storage.buckets where id = 'table-images'),
    array['image/jpeg']);

  v_old := set_table_image(v_table.id, 'table/abc123.jpg');
  perform assert_eq('ครั้งแรกไม่มีรูปเดิม', v_old, null::text);
  perform assert_eq('บันทึก path แล้ว',
    (select image_path from cafe_tables where id = v_table.id), 'table/abc123.jpg');

  -- เปลี่ยนรูปต้องคืน path เดิม ไม่งั้นไฟล์เก่าค้างเป็นขยะทุกครั้งที่เปลี่ยน
  v_old := set_table_image(v_table.id, 'table/def456.jpg');
  perform assert_eq('คืน path เดิมไว้เก็บกวาดไฟล์เก่า', v_old, 'table/abc123.jpg');

  -- ★ รูปต้องไปถึงหน้าจอง ไม่งั้นทำมาก็ไม่มีใครเห็น
  perform assert_eq('หน้าจองได้รูปไปด้วย',
    (select l ->> 'imagePath'
       from jsonb_array_elements(available_tables(now() + interval '1 day')) l
      where (l ->> 'id')::uuid = v_table.id),
    'table/def456.jpg');

  perform assert_eq('view สาธารณะมีรูปด้วย',
    (select image_path from public_tables where id = v_table.id), 'table/def456.jpg');

  v_old := set_table_image(v_table.id, null);
  perform assert_eq('ถอดรูปออกได้',
    (select image_path from cafe_tables where id = v_table.id), null::text);
  perform assert_eq('ยังคืน path เดิมให้ลบ', v_old, 'table/def456.jpg');

  -- path ต้องอยู่ในรูปแบบที่กำหนด กันการชี้ไปไฟล์นอก bucket
  begin
    perform set_table_image(v_table.id, 'https://evil.example.com/a.jpg');
    raise exception 'FAIL  URL เต็มไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ใส่ URL เต็มแทน path ไม่ได้';
  end;

  begin
    perform set_table_image(v_table.id, '../../etc/passwd');
    raise exception 'FAIL  path ย้อนโฟลเดอร์ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  path ย้อนโฟลเดอร์ไม่ได้';
  end;

  -- รูปเมนูกับรูปโต๊ะคนละ bucket จะได้ไม่ปนกัน
  begin
    perform set_table_image(v_table.id, 'menu/abc123.jpg');
    raise exception 'FAIL  path ของ bucket อื่นไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ใช้ path ของรูปเมนูไม่ได้';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- คนที่ไม่ใช่ผู้จัดการแก้ไม่ได้
-- ---------------------------------------------------------------------------
insert into auth.users (id, email)
values ('99999999-0000-4000-8000-0000000000d2', 'floorimg@cafe.test');

insert into staff (user_id, display_name, role)
values ('99999999-0000-4000-8000-0000000000d2', 'พนักงานหน้าร้าน', 'floor');

do $$
declare v_table cafe_tables;
begin
  select * into v_table from cafe_tables where code = 'A1';
  set local "test.user_id" = '99999999-0000-4000-8000-0000000000d2';

  begin
    perform set_table_image(v_table.id, 'table/xyz.jpg');
    raise exception 'FAIL  พนักงานหน้าร้านไม่ควรเปลี่ยนรูปโต๊ะได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานหน้าร้านเปลี่ยนรูปโต๊ะไม่ได้';
  end;
end $$;

do $$
begin
  perform assert_eq('ลูกค้าเปลี่ยนรูปโต๊ะไม่ได้',
    has_function_privilege('anon', 'set_table_image(uuid, text)', 'execute'), false);
  perform assert_eq('แต่ลูกค้าอ่านรายการโต๊ะได้',
    has_table_privilege('anon', 'public_tables', 'select'), true);
end $$;

select '=== รูปประกอบโต๊ะผ่านทั้งหมด ===' as result;
