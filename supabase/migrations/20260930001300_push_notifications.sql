-- ============================================================================
-- แจ้งเตือนขึ้นมือถือเมื่อมีออเดอร์เข้าครัว (Web Push)
--
-- เส้นทาง: มีออเดอร์ใหม่ → trigger → pg_net ยิงไปที่ Edge Function
--          → Edge Function ส่ง push ไปยังอุปกรณ์ของคนที่มีสิทธิ์ 'kitchen'
--
-- ทำไมต้องผ่าน Edge Function: การส่ง Web Push ต้องเซ็น JWT ด้วยกุญแจ VAPID
-- ซึ่งเป็นความลับ อยู่ในเบราว์เซอร์ไม่ได้ และ Postgres เซ็น ES256 เองไม่ได้
--
-- ส่ง push แบบ "ไม่มีเนื้อหา" โดยตั้งใจ — Web Push ที่มี payload ต้องเข้ารหัส
-- aes128gcm ซึ่งซับซ้อนและพังง่าย ส่วนข้อความแจ้งเตือนเขียนไว้ใน service worker
-- อยู่แล้ว คนครัวกดแล้วเปิดจอครัวเห็นรายละเอียดครบ
-- ============================================================================

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  -- URL ที่เบราว์เซอร์ให้มา ใช้เป็นตัวระบุอุปกรณ์
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- ค่าที่ trigger ต้องใช้ยิงไปหา Edge Function
--
-- notify_secret สุ่มตอนสร้างตาราง ไม่ได้ฝังไว้ในไฟล์นี้ เพราะไฟล์นี้อยู่ใน
-- โค้ดสาธารณะ เจ้าของร้านอ่านค่าไปใส่เป็น secret ของ Edge Function เอง
-- ---------------------------------------------------------------------------
create table if not exists push_config (
  id            int primary key default 1 check (id = 1),
  function_url  text,
  notify_secret text not null default gen_random_uuid()::text,
  enabled       boolean not null default true
);

insert into push_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- อุปกรณ์ลงทะเบียน/ยกเลิก
-- ---------------------------------------------------------------------------
create or replace function save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;

  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = ''
     or coalesce(p_auth, '') = '' then
    raise exception 'ข้อมูลการลงทะเบียนไม่ครบ' using errcode = '22023';
  end if;

  -- อุปกรณ์เดิมอาจถูกใช้โดยคนใหม่ (เปลี่ยนคนเฝ้าจอ) จึงทับเจ้าของเดิมได้
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent;
end;
$$;

create or replace function delete_push_subscription(p_endpoint text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;

  -- ลบได้เฉพาะอุปกรณ์ของตัวเอง
  delete from push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

/** หน้าจอใช้บอกว่าอุปกรณ์นี้เปิดแจ้งเตือนไว้แล้วหรือยัง */
create or replace function has_push_subscription(p_endpoint text)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from push_subscriptions
     where endpoint = p_endpoint and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- รายชื่ออุปกรณ์ที่ต้องส่งแจ้งเตือนไปหา
--
-- ให้ฐานข้อมูลเป็นคนตอบว่า "ใครควรได้รับ" แทนที่จะให้ Edge Function ไปต่อ
-- ความสัมพันธ์เอง — push_subscriptions.user_id อ้าง auth.users ไม่ใช่ staff
-- จึง join ข้ามไปหา role_capabilities ผ่าน PostgREST ตรง ๆ ไม่ได้
-- ---------------------------------------------------------------------------
-- drop ก่อนเสมอ เพราะไฟล์ถัดไปเปลี่ยนคอลัมน์ที่คืนกลับ ถ้าใช้ create or replace
-- แล้วรันไฟล์นี้ซ้ำทีหลัง Postgres จะปฏิเสธว่าเปลี่ยนชนิดที่คืนไม่ได้
drop function if exists kitchen_push_endpoints();

create function kitchen_push_endpoints()
returns table (id uuid, endpoint text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct ps.id, ps.endpoint
    from push_subscriptions ps
    join staff s on s.user_id = ps.user_id and s.active
    join role_capabilities rc on rc.role = s.role and rc.capability = 'kitchen';
$$;

-- ---------------------------------------------------------------------------
-- ยิงบอก Edge Function เมื่อมีออเดอร์ใหม่
--
-- ใช้ trigger ไม่ใช่เรียกจากฝั่งแอป เพราะออเดอร์เข้าได้สองทาง (พนักงานสั่งแทน
-- และลูกค้าสแกน QR สั่งเอง) ถ้าเรียกจากแอปต้องไปใส่สองที่แล้วลืมที่หนึ่งแน่
-- ---------------------------------------------------------------------------
create or replace function notify_kitchen_on_order() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_cfg push_config;
begin
  select * into v_cfg from push_config where id = 1;

  if not found or not v_cfg.enabled or coalesce(v_cfg.function_url, '') = '' then
    return new;  -- ยังไม่ได้ตั้งค่า — ไม่ใช่ข้อผิดพลาด
  end if;

  if to_regproc('net.http_post') is null then
    return new;  -- ไม่มี pg_net (เช่นตอนทดสอบบน Postgres เปล่า)
  end if;

  -- ยิงแบบไม่รอผล ถ้าปลายทางล่ม ออเดอร์ต้องยังบันทึกสำเร็จอยู่ดี
  -- การแจ้งเตือนพังไม่ควรทำให้ลูกค้าสั่งของไม่ได้
  begin
    perform net.http_post(
      url := v_cfg.function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', v_cfg.notify_secret
      ),
      body := jsonb_build_object('orderId', new.id),
      timeout_milliseconds := 3000
    );
  exception when others then
    raise warning 'ส่งแจ้งเตือนครัวไม่สำเร็จ: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists orders_notify_kitchen on orders;
create trigger orders_notify_kitchen
  after insert on orders
  for each row
  when (new.status = 'placed')
  execute function notify_kitchen_on_order();

-- ----------------------------------------------------------------- สิทธิ์ ----

alter table push_subscriptions enable row level security;
alter table push_config        enable row level security;

-- ไม่มี policy ใด ๆ = ไม่มีใครอ่าน/เขียนตรงได้เลย แม้แต่พนักงาน
-- ทุกอย่างผ่าน RPC และ Edge Function (service_role) เท่านั้น
-- push_config มีความลับอยู่ข้างใน จึงต้องไม่หลุดไปถึง client เด็ดขาด

revoke all on push_subscriptions, push_config from anon, authenticated;

revoke all on function
  kitchen_push_endpoints(),
  save_push_subscription(text, text, text, text),
  delete_push_subscription(text),
  has_push_subscription(text),
  notify_kitchen_on_order()
from public, anon, authenticated;

grant execute on function save_push_subscription(text, text, text, text) to authenticated;
grant execute on function delete_push_subscription(text)                 to authenticated;
grant execute on function has_push_subscription(text)                    to authenticated;

-- ---------------------------------------------------------------------------
-- หลัง apply ไฟล์นี้ เจ้าของร้านต้องทำอีกสองอย่าง (ดู supabase/README.md)
--
--   1. เปิด pg_net:
--        create extension if not exists pg_net with schema extensions;
--
--   2. บอกที่อยู่ของ Edge Function แล้วอ่านรหัสลับไปใส่ใน Secrets ของฟังก์ชัน:
--        update push_config
--           set function_url = 'https://<project-ref>.supabase.co/functions/v1/notify-kitchen';
--        select notify_secret from push_config;
-- ---------------------------------------------------------------------------
