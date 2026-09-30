-- จำลองสิ่งที่ Supabase มีให้อยู่แล้ว เพื่อให้ migration รันบน Postgres เปล่าได้
-- ใช้เฉพาะตอนทดสอบ ไม่ต้อง apply ขึ้น Supabase

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase อ่าน user id จาก JWT — ตอนทดสอบใช้ GUC แทน
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid;
$$;

create extension if not exists pgcrypto;

-- Supabase เปิดให้ทุก role เรียก auth.uid() ได้อยู่แล้ว จำลองให้ตรงกัน
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- ------------------------------------------------------------- assert ----

create function assert_eq(p_label text, p_got anyelement, p_want anyelement)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL  %  got=%  want=%', p_label, p_got, p_want;
  end if;
  raise notice 'PASS  %  = %', p_label, p_got;
end;
$$;

-- ------------------------------------------------------------- Storage ----
-- จำลองโครงของ Supabase Storage เท่าที่ policy ของเราต้องใช้
-- จะได้ทดสอบได้จริงว่าใครอัปโหลด/ลบรูปเมนูได้บ้าง ไม่ใช่เขียน policy แล้วหวัง

create schema storage;

create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets,
  name      text not null,
  owner     uuid,
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
