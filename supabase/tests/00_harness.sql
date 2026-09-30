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
