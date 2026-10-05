-- ============================================================================
-- รูปประกอบเมนู
--
-- เก็บไฟล์ใน Supabase Storage bucket 'menu-images' และเก็บเฉพาะ "path"
-- ลงตาราง ไม่เก็บ URL เต็ม เพราะโดเมนของโปรเจกต์เปลี่ยนได้ (ย้ายโปรเจกต์
-- ย้าย region) ถ้าเก็บ URL เต็มไว้ รูปทั้งร้านจะตายพร้อมกัน
--
-- ความปลอดภัย: Storage มี RLS เป็นของตัวเองบน storage.objects ซึ่งเป็นคนละ
-- พื้นผิวกับ RLS ของตารางปกติ เทสต์ตรวจสิทธิ์ฟังก์ชันที่มีอยู่ไม่ครอบถึงตรงนี้
-- จึงต้องเขียน policy และเทสต์แยกต่างหาก
--
-- ด่านกันไฟล์ใหญ่/ผิดชนิดอยู่ที่ bucket ไม่ใช่ที่หน้าจอ — การย่อรูปฝั่ง client
-- เป็นเรื่องประสบการณ์ใช้งานและค่า egress ไม่ใช่ความปลอดภัย
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
alter table menu_items add column if not exists image_path text;

-- ---------------------------------------------------------------------------
-- is_manager() คืนค่า boolean ไว้ใช้ใน policy ของ storage
-- (assert_manager() โยน exception ซึ่งใช้ใน policy ไม่ได้)
-- ---------------------------------------------------------------------------
create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from staff
     where user_id = auth.uid() and active and role in ('manager', 'owner')
  );
$$;

create or replace function assert_manager() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_manager() then
    raise exception 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ผูก/ถอดรูปออกจากเมนู
--
-- คืน path เดิมกลับไปให้หน้าจอเอาไปลบไฟล์เก่าทิ้ง ถ้าไม่คืน ไฟล์เก่าจะค้าง
-- เป็นขยะทุกครั้งที่เปลี่ยนรูป
-- ---------------------------------------------------------------------------
create or replace function set_menu_image(p_id uuid, p_path text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform assert_manager();

  select image_path into v_old from menu_items where id = p_id;
  if not found then
    raise exception 'ไม่พบเมนู %', p_id using errcode = 'P0002';
  end if;

  -- กันไม่ให้ชี้ไปไฟล์นอก bucket ของเรา หรือยัด URL เต็มเข้ามา
  if p_path is not null and p_path !~ '^menu/[0-9a-zA-Z._-]+$' then
    raise exception 'path รูปไม่ถูกต้อง' using errcode = '22023';
  end if;

  update menu_items set image_path = p_path where id = p_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_menu_image', 'menu_item', p_id,
          jsonb_build_object('from', v_old, 'to', p_path));

  return v_old;
end;
$$;

-- เมนูที่ลูกค้าเห็นหลังสแกน QR ต้องมีรูปด้วย
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token and not archived;
  if not found then
    raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
  end if;

  v_visit := visit_for_token(p_token);

  return jsonb_build_object(
    'tableCode', v_table.code,
    'zone',      v_table.zone,
    'visitId',   v_visit,
    'passes', coalesce((
      select jsonb_agg(jsonb_build_object('id', gp.id, 'displayName', gp.display_name)
                       order by gp.checked_in_at)
        from guest_passes gp
       where gp.visit_id = v_visit and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function
  is_manager(),
  set_menu_image(uuid, text)
from public, anon, authenticated;

grant execute on function set_menu_image(uuid, text) to authenticated;

-- is_manager() ถูกเรียกจาก policy ของ storage.objects ซึ่งประเมินด้วยสิทธิ์
-- ของผู้ใช้ที่ยิงคำสั่ง ถ้าไม่ให้ EXECUTE การอัปโหลดจะพังด้วย
-- "permission denied for function is_manager" ทั้งที่ policy เขียนถูก
-- (เป็น SECURITY DEFINER และบอกแค่สถานะของตัวผู้เรียกเอง จึงไม่รั่วอะไร)
grant execute on function is_manager() to authenticated;

-- ------------------------------------------------------------- Storage ----
-- ข้ามได้ถ้ารันบน Postgres เปล่าที่ไม่มี Supabase Storage (เช่นตอนทดสอบ)

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'ไม่มี Supabase Storage — ข้ามการตั้งค่า bucket';
    return;
  end if;

  -- public = true ให้ลูกค้าเปิดรูปได้โดยไม่ต้องล็อกอิน
  -- ขนาดและชนิดไฟล์ถูกบังคับที่นี่ เป็นด่านจริง ไม่ใช่ที่หน้าจอ
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg'])
  on conflict (id) do update
    set public = true,
        file_size_limit = 2097152,
        allowed_mime_types = array['image/jpeg'];

  -- ลบ policy เดิมก่อน เพื่อให้รันไฟล์นี้ซ้ำได้
  drop policy if exists menu_images_public_read on storage.objects;
  drop policy if exists menu_images_manager_insert on storage.objects;
  drop policy if exists menu_images_manager_update on storage.objects;
  drop policy if exists menu_images_manager_delete on storage.objects;

  -- ใครก็ดูรูปเมนูได้ เหมือนเมนูที่ติดอยู่หน้าร้าน
  create policy menu_images_public_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'menu-images');

  -- แต่เขียนได้เฉพาะระดับผู้จัดการ และเฉพาะใน bucket นี้
  create policy menu_images_manager_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'menu-images' and is_manager());

  create policy menu_images_manager_update on storage.objects
    for update to authenticated
    using (bucket_id = 'menu-images' and is_manager())
    with check (bucket_id = 'menu-images' and is_manager());

  create policy menu_images_manager_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'menu-images' and is_manager());
end;
$$;
