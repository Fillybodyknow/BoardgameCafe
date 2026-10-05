-- ============================================================================
-- ชื่อร้านและโลโก้ — เจ้าของร้านแก้เองได้
--
-- เดิมชื่อ "Boardgame Cafe" ฝังอยู่ในโค้ดหลายจุด (แถบเมนู หน้าล็อกอิน
-- หน้าลูกค้าสแกน QR หน้าจอง ใบ QR ที่พิมพ์) ร้านที่เอาไปใช้ต้องแก้โค้ดเอง
--
-- สิทธิ์: แยกเป็นสิทธิ์ใหม่ 'branding' ให้เฉพาะเจ้าของร้าน ไม่ใช้ 'settings'
-- เพราะผู้จัดการแก้เมนู/ราคาได้ทุกวันเป็นเรื่องปกติ แต่ชื่อและโลโก้คือหน้าตา
-- ของร้านที่ลูกค้าเห็นทุกครั้ง — ทำตามแนวของ migration 1200 ที่ให้ระดับ
-- พนักงานเป็นชุดของสิทธิ์ย่อย แทนการเช็คชื่อ role ตรง ๆ
--
-- ชื่อและโลโก้เป็นข้อมูลสาธารณะ (อยู่บนป้ายหน้าร้านอยู่แล้ว) คนที่ไม่ล็อกอิน
-- จึงอ่านได้ — หน้าจองและหน้าสแกน QR ต้องใช้
-- ============================================================================
-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย

-- ------------------------------------------------------------ สิทธิ์ใหม่ ----
alter table role_capabilities drop constraint if exists role_capabilities_capability_check;
alter table role_capabilities add constraint role_capabilities_capability_check
  check (capability in ('floor', 'kitchen', 'settings', 'accounts', 'branding'));

insert into role_capabilities (role, capability) values ('owner', 'branding')
on conflict do nothing;

create or replace function assert_cap(p_cap text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_cap(p_cap) then
    raise exception '%', case p_cap
      when 'floor'    then 'ต้องมีสิทธิ์ดูแลหน้าร้าน'
      when 'kitchen'  then 'ต้องมีสิทธิ์ดูแลห้องครัว'
      when 'settings' then 'ต้องมีสิทธิ์ตั้งค่าร้าน'
      when 'accounts' then 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน'
      when 'branding' then 'เฉพาะเจ้าของร้านที่แก้ชื่อและโลโก้ร้านได้'
      else 'ไม่มีสิทธิ์ทำรายการนี้'
    end using errcode = '42501';
  end if;
end;
$$;

-- -------------------------------------------------------------- ตาราง ----
-- แถวเดียวทั้งระบบ (id = true เสมอ) เหมือน tax_config
create table if not exists shop_profile (
  id         boolean primary key default true check (id),
  name       text not null default 'Boardgame Cafe'
             check (length(trim(name)) between 1 and 60),
  tagline    text not null default 'โรงเตี๊ยมนักเล่น'
             check (length(tagline) <= 80),
  -- เก็บแค่ path ใน bucket ไม่ใช่ URL เต็ม เหตุผลเดียวกับรูปเมนู (migration 1000)
  logo_path  text check (logo_path is null or logo_path ~ '^logo/[0-9a-zA-Z._-]+$'),
  updated_at timestamptz not null default now()
);

insert into shop_profile (id) values (true) on conflict do nothing;

alter table shop_profile enable row level security;
drop policy if exists public_read_shop_profile on shop_profile;
create policy public_read_shop_profile on shop_profile
  for select to anon, authenticated using (true);

-- อ่านได้ทุกคน แต่แก้ได้ทางเดียวคือผ่าน RPC ด้านล่าง
revoke all on shop_profile from anon, authenticated;
grant select on shop_profile to anon, authenticated;

-- ---------------------------------------------------------------- RPC ----
create or replace function update_shop_profile(p_name text, p_tagline text)
returns shop_profile
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name    text := nullif(trim(p_name), '');
  v_tagline text := coalesce(trim(p_tagline), '');
  v_row     shop_profile;
begin
  perform assert_cap('branding');

  if v_name is null then
    raise exception 'กรุณาใส่ชื่อร้าน' using errcode = '22023';
  end if;
  if length(v_name) > 60 then
    raise exception 'ชื่อร้านยาวเกิน 60 ตัวอักษร' using errcode = '22023';
  end if;
  if length(v_tagline) > 80 then
    raise exception 'คำโปรยยาวเกิน 80 ตัวอักษร' using errcode = '22023';
  end if;

  update shop_profile
     set name = v_name, tagline = v_tagline, updated_at = now()
   where id
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'update_shop_profile', 'shop_profile', null,
          jsonb_build_object('name', v_name, 'tagline', v_tagline));

  return v_row;
end;
$$;

-- ผูก/ถอดโลโก้ — คืน path เดิมให้หน้าจอเอาไปลบไฟล์เก่า (เหมือน set_menu_image)
create or replace function set_shop_logo(p_path text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old text;
begin
  perform assert_cap('branding');

  -- กันไม่ให้ชี้ไปไฟล์นอก bucket ของเรา หรือยัด URL เต็มเข้ามา
  if p_path is not null and p_path !~ '^logo/[0-9a-zA-Z._-]+$' then
    raise exception 'path โลโก้ไม่ถูกต้อง' using errcode = '22023';
  end if;

  select logo_path into v_old from shop_profile where id;
  update shop_profile set logo_path = p_path, updated_at = now() where id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_shop_logo', 'shop_profile', null,
          jsonb_build_object('from', v_old, 'to', p_path));

  return v_old;
end;
$$;

revoke all on function update_shop_profile(text, text) from public, anon, authenticated;
revoke all on function set_shop_logo(text)              from public, anon, authenticated;
grant execute on function update_shop_profile(text, text) to authenticated;
grant execute on function set_shop_logo(text)              to authenticated;

-- ------------------------------------------------------------- Storage ----
-- bucket แยกจากรูปเมนู: รูปเมนูรับแค่ JPEG และผู้จัดการอัปได้ ส่วนโลโก้ต้องเป็น
-- PNG พื้นใสได้ และเฉพาะคนที่มีสิทธิ์ branding
-- ข้ามได้ถ้ารันบน Postgres เปล่าที่ไม่มี Supabase Storage (เช่นตอนทดสอบ)
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'ไม่มี Supabase Storage — ข้ามการตั้งค่า bucket โลโก้';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('shop-assets', 'shop-assets', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
  on conflict (id) do update
    set public = true,
        file_size_limit = 524288,
        allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

  drop policy if exists shop_assets_public_read  on storage.objects;
  drop policy if exists shop_assets_owner_insert on storage.objects;
  drop policy if exists shop_assets_owner_update on storage.objects;
  drop policy if exists shop_assets_owner_delete on storage.objects;

  create policy shop_assets_public_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'shop-assets');

  create policy shop_assets_owner_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'shop-assets' and has_cap('branding'));

  create policy shop_assets_owner_update on storage.objects
    for update to authenticated
    using (bucket_id = 'shop-assets' and has_cap('branding'))
    with check (bucket_id = 'shop-assets' and has_cap('branding'));

  create policy shop_assets_owner_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'shop-assets' and has_cap('branding'));
end;
$$;
