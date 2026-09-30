-- ============================================================================
-- รูปประกอบเมนู
--
-- Storage มี RLS แยกจากตารางปกติ เทสต์ตรวจสิทธิ์ฟังก์ชันใน 20_operations_test
-- ไม่ครอบถึงตรงนี้ จึงต้องถามใหม่หมดว่า: ใครอัปโหลดทับรูปเมนูได้บ้าง
-- ============================================================================

set "test.user_id" = '99999999-0000-4000-8000-000000000001';  -- manager

do $$
declare
  v_item menu_items;
  v_old  text;
begin
  select * into v_item from menu_items where sku = 'D01';

  perform assert_eq('bucket ถูกสร้างและเปิดให้อ่านสาธารณะ',
    (select public from storage.buckets where id = 'menu-images'), true);
  perform assert_eq('bucket จำกัดขนาดไฟล์',
    (select file_size_limit from storage.buckets where id = 'menu-images'), 2097152::bigint);
  perform assert_eq('bucket รับเฉพาะ JPEG',
    (select allowed_mime_types from storage.buckets where id = 'menu-images'),
    array['image/jpeg']);

  -- ผูกรูปเข้ากับเมนู
  v_old := set_menu_image(v_item.id, 'menu/abc123.jpg');
  perform assert_eq('ครั้งแรกไม่มีรูปเดิม', v_old, null::text);
  perform assert_eq('บันทึก path แล้ว',
    (select image_path from menu_items where id = v_item.id), 'menu/abc123.jpg');

  -- เปลี่ยนรูป ต้องคืน path เดิมกลับไปให้หน้าจอลบไฟล์ทิ้ง
  v_old := set_menu_image(v_item.id, 'menu/def456.jpg');
  perform assert_eq('คืน path เดิมไว้เก็บกวาดไฟล์เก่า', v_old, 'menu/abc123.jpg');

  -- ถอดรูปออก
  v_old := set_menu_image(v_item.id, null);
  perform assert_eq('ถอดรูปออกได้', (select image_path from menu_items where id = v_item.id),
    null::text);
  perform assert_eq('ยังคืน path เดิมให้ลบ', v_old, 'menu/def456.jpg');

  -- path ต้องอยู่ในรูปแบบที่กำหนด กันการชี้ไปไฟล์นอก bucket
  begin
    perform set_menu_image(v_item.id, 'https://evil.example.com/a.jpg');
    raise exception 'FAIL  URL เต็มไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  ใส่ URL เต็มแทน path ไม่ได้';
  end;

  begin
    perform set_menu_image(v_item.id, '../../etc/passwd');
    raise exception 'FAIL  path ที่ไต่ออกนอกโฟลเดอร์ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  path ไต่ออกนอกโฟลเดอร์ไม่ได้';
  end;

  begin
    perform set_menu_image(v_item.id, 'other-bucket/a.jpg');
    raise exception 'FAIL  path นอกโฟลเดอร์ menu/ ไม่ควรผ่าน';
  exception when sqlstate '22023' then
    raise notice 'PASS  path ต้องอยู่ใต้ menu/ เท่านั้น';
  end;
end;
$$;

-- ======================== สิทธิ์บน Storage ========================

-- ผู้จัดการอัปโหลดได้
do $$
begin
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
  values ('menu-images', 'menu/by-manager.jpg', auth.uid());
  raise notice 'PASS  ผู้จัดการอัปโหลดรูปเมนูได้';
  reset role;
end;
$$;

-- ลูกค้าที่ไม่ได้ล็อกอิน: ดูได้ แต่แตะอะไรไม่ได้
set "test.user_id" = '';
set role anon;

do $$
declare v_n bigint;
begin
  select count(*) into v_n from storage.objects where bucket_id = 'menu-images';
  perform assert_eq('anon ดูรูปเมนูได้', v_n > 0, true);
end;
$$;

do $$
begin
  insert into storage.objects (bucket_id, name) values ('menu-images', 'menu/hack.jpg');
  raise exception 'FAIL  anon ไม่ควรอัปโหลดได้';
exception when insufficient_privilege then
  raise notice 'PASS  anon อัปโหลดรูปไม่ได้';
end;
$$;

-- UPDATE/DELETE ที่ไม่ผ่าน policy จะไม่ throw แต่จะ "ไม่โดนแถวไหนเลย"
-- เพราะ RLS กรองแถวออกก่อน ต้องวัดที่จำนวนแถวที่เปลี่ยน ไม่ใช่รอ exception
do $$
declare v_n int;
begin
  update storage.objects set name = 'menu/tampered.jpg' where bucket_id = 'menu-images';
  get diagnostics v_n = row_count;
  perform assert_eq('anon แก้ไฟล์ไม่ได้ (ไม่โดนแถวไหนเลย)', v_n, 0);

  delete from storage.objects where bucket_id = 'menu-images';
  get diagnostics v_n = row_count;
  perform assert_eq('anon ลบรูปเมนูไม่ได้ (ไม่โดนแถวไหนเลย)', v_n, 0);
end;
$$;

-- ไฟล์ที่ผู้จัดการอัปไว้ต้องยังอยู่ครบหลังจากที่ anon พยายามแตะ
do $$
begin
  perform assert_eq('ไฟล์เดิมยังอยู่',
    (select count(*) from storage.objects where name = 'menu/by-manager.jpg'), 1::bigint);
end;
$$;

reset role;

-- พนักงานหน้าร้าน (role = staff) ล็อกอินแล้วแต่ไม่ใช่ระดับจัดการ
set "test.user_id" = '99999999-0000-4000-8000-000000000003';
set role authenticated;

do $$
declare v_n int;
begin
  perform assert_eq('ไม่ใช่ระดับจัดการ', is_manager(), false);

  begin
    insert into storage.objects (bucket_id, name) values ('menu-images', 'menu/crew.jpg');
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรอัปโหลดรูปเมนูได้';
  exception when insufficient_privilege then
    raise notice 'PASS  พนักงานธรรมดาอัปโหลดรูปเมนูไม่ได้';
  end;

  delete from storage.objects where bucket_id = 'menu-images';
  get diagnostics v_n = row_count;
  perform assert_eq('พนักงานธรรมดาลบรูปเมนูไม่ได้', v_n, 0);

  begin
    perform set_menu_image((select id from menu_items limit 1), 'menu/x.jpg');
    raise exception 'FAIL  พนักงานธรรมดาไม่ควรผูกรูปกับเมนูได้';
  exception when sqlstate '42501' then
    raise notice 'PASS  พนักงานธรรมดาผูกรูปกับเมนูไม่ได้';
  end;
end;
$$;

reset role;
set "test.user_id" = '99999999-0000-4000-8000-000000000001';

select '=== รูปประกอบเมนูผ่านทั้งหมด ===' as result;
