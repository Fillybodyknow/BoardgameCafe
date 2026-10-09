-- ============================================================================
-- รูปประกอบโต๊ะ
--
-- ลูกค้าจองออนไลน์เห็นแค่รหัสโต๊ะกับจำนวนที่นั่ง ซึ่งตัดสินใจยาก
-- โต๊ะริมหน้าต่างกับโต๊ะกลางร้านนั่งได้เท่ากันแต่บรรยากาศคนละเรื่อง
--
-- ทำตามแบบเดียวกับรูปเมนู (ดู migration 1000) ทุกประการ:
--   - เก็บเฉพาะ path ไม่เก็บ URL เต็ม เพราะโดเมนของโปรเจกต์เปลี่ยนได้
--   - ด่านกันไฟล์ใหญ่/ผิดชนิดอยู่ที่ bucket ไม่ใช่ที่หน้าจอ
--   - คืน path เดิมกลับไปให้หน้าจอลบไฟล์เก่าทิ้ง ไม่งั้นเป็นขยะสะสม
--
-- ใช้ bucket แยกจากรูปเมนู เพราะคนละอายุการใช้งานและคนละขนาด ถ้าวันหนึ่ง
-- อยากล้างรูปเมนูทั้ง bucket จะได้ไม่ลบรูปโต๊ะไปด้วย
-- ============================================================================

alter table cafe_tables add column if not exists image_path text;

-- ---------------------------------------------------------------------------
-- ผูก/ถอดรูปออกจากโต๊ะ
-- ---------------------------------------------------------------------------
create or replace function set_table_image(p_id uuid, p_path text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform assert_manager();

  select image_path into v_old from cafe_tables where id = p_id;
  if not found then
    raise exception 'ไม่พบโต๊ะ %', p_id using errcode = 'P0002';
  end if;

  -- กันไม่ให้ชี้ไปไฟล์นอก bucket ของเรา หรือยัด URL เต็มเข้ามา
  if p_path is not null and p_path !~ '^table/[0-9a-zA-Z._-]+$' then
    raise exception 'path รูปไม่ถูกต้อง' using errcode = '22023';
  end if;

  update cafe_tables set image_path = p_path where id = p_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_table_image', 'cafe_table', p_id,
          jsonb_build_object('from', v_old, 'to', p_path));

  return v_old;
end;
$$;

-- ---------------------------------------------------------------------------
-- ส่งรูปไปให้คนที่ต้องใช้ตัดสินใจ
--
-- หน้าจองเป็นเป้าหมายหลักของฟีเจอร์นี้ ส่วน public_tables ใส่ไว้ด้วยเพราะ
-- เป็นทางที่ลูกค้าอ่านข้อมูลโต๊ะได้ ถ้าไม่ใส่จะต้องมาเพิ่มทีหลังอยู่ดี
-- ---------------------------------------------------------------------------
create or replace view public_tables as
  select id, code, zone, seat_min, seat_max, allow_share, status, sort_order, image_path
    from cafe_tables
   where not archived;

create or replace function available_tables(
  p_start    timestamptz,
  p_duration int default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg reservation_config;
  v_end timestamptz;
begin
  select * into v_cfg from reservation_config where id = 1;
  v_end := p_start + make_interval(mins => coalesce(p_duration, v_cfg.default_duration_minutes));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'code', t.code, 'zone', t.zone,
             'seatMin', t.seat_min, 'seatMax', t.seat_max,
             'allowShare', t.allow_share,
             'imagePath', t.image_path,
             'available', table_available(t.id, p_start, v_end)
           ) order by t.sort_order)
      from cafe_tables t
     where not t.archived
  ), '[]'::jsonb);
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function set_table_image(uuid, text) from public, anon, authenticated;
grant execute on function set_table_image(uuid, text) to authenticated;

-- view ถูกสร้างใหม่ สิทธิ์เดิมหายไปด้วย ต้องให้คืน
grant select on public_tables to anon, authenticated;

-- ------------------------------------------------------------- Storage ----
-- ข้ามได้ถ้ารันบน Postgres เปล่าที่ไม่มี Supabase Storage (เช่นตอนทดสอบ)

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'ไม่มี Supabase Storage — ข้ามการตั้งค่า bucket';
    return;
  end if;

  -- public = true ให้ลูกค้าเปิดรูปได้โดยไม่ต้องล็อกอิน
  -- รูปโต๊ะกว้างกว่ารูปเมนู จึงให้โควตาไฟล์มากกว่าเล็กน้อย
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('table-images', 'table-images', true, 3145728, array['image/jpeg'])
  on conflict (id) do update
    set public = true,
        file_size_limit = 3145728,
        allowed_mime_types = array['image/jpeg'];

  -- ลบ policy เดิมก่อน เพื่อให้รันไฟล์นี้ซ้ำได้
  drop policy if exists table_images_public_read on storage.objects;
  drop policy if exists table_images_manager_insert on storage.objects;
  drop policy if exists table_images_manager_update on storage.objects;
  drop policy if exists table_images_manager_delete on storage.objects;

  -- ใครก็ดูได้ เพราะคนที่ยังไม่ได้มาร้านคือคนที่ต้องใช้รูปนี้ตัดสินใจ
  create policy table_images_public_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'table-images');

  create policy table_images_manager_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'table-images' and is_manager());

  create policy table_images_manager_update on storage.objects
    for update to authenticated
    using (bucket_id = 'table-images' and is_manager())
    with check (bucket_id = 'table-images' and is_manager());

  create policy table_images_manager_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'table-images' and is_manager());
end;
$$;
