-- ============================================================================
-- จัดการบัญชีพนักงานจากในแอป + เข้าสู่ระบบด้วย username
--
-- Supabase Auth ไม่มีการล็อกอินด้วย username ให้ มีแต่อีเมล/เบอร์/OAuth
-- วิธีที่ใช้คือให้ทุกบัญชีมีอีเมลภายในที่พนักงานไม่เคยเห็น แล้วเก็บ username
-- ไว้ในตาราง staff เป็นตัวแมปกลับไปหาอีเมลนั้น
--
-- ทำไมต้องแมปผ่านตาราง แทนที่จะต่อ "@โดเมน" เอาเองทั้งสองฝั่ง:
--   1. ถ้าฝั่งหน้าจอกับฝั่งสร้างบัญชีใช้โดเมนคนละตัว จะล็อกอินไม่ได้แบบเงียบ ๆ
--   2. บัญชีเดิมที่สร้างด้วยอีเมลจริงจะยังใช้ได้ ไม่ต้องสร้างใหม่
--
-- ส่วน "สร้างบัญชี" ต้องใช้ service_role key ซึ่งอยู่ในเว็บ static ไม่ได้
-- จึงอยู่ใน Edge Function — ดู supabase/functions/create-staff/
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
alter table staff add column if not exists username text;

-- เทียบ username แบบไม่สนตัวพิมพ์ แต่เก็บตามที่พิมพ์มา
create unique index if not exists staff_username_key on staff (lower(username));

-- บัญชีที่มีอยู่แล้วต้องยังล็อกอินได้ ตั้ง username จากส่วนหน้า @ ของอีเมล
-- ถ้าชนกันให้ต่อเลขท้าย เพื่อให้ unique index ผ่าน
with numbered as (
  select s.user_id,
         lower(split_part(u.email, '@', 1)) as base,
         row_number() over (
           partition by lower(split_part(u.email, '@', 1))
           order by s.created_at
         ) as n
    from staff s
    join auth.users u on u.id = s.user_id
)
update staff s
   set username = case when n.n = 1 then n.base else n.base || n.n::text end
  from numbered n
 where n.user_id = s.user_id
   and s.username is null;   -- รันซ้ำแล้วไม่ทับของเดิม

alter table staff drop constraint if exists staff_username_format;
alter table staff
  add constraint staff_username_format
  check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,29}$');

-- ---------------------------------------------------------------------------
-- เติม username ให้อัตโนมัติถ้าไม่ได้ระบุมา
--
-- จำเป็นเพราะแถวใน staff ถูกสร้างได้หลายทาง ไม่ใช่แค่ผ่านหน้าแอป — บัญชีแรก
-- ของร้านสร้างด้วย SQL มือใน Dashboard ตามคู่มือติดตั้ง ถ้าปล่อยให้ username
-- เป็น null คนนั้นจะล็อกอินด้วยชื่อผู้ใช้ไม่ได้เลย และไม่มีอะไรบอกว่าทำไม
-- (เติมย้อนหลังครั้งเดียวตอน migration ไม่พอ เพราะครอบเฉพาะแถวที่มีอยู่ตอนนั้น)
-- ---------------------------------------------------------------------------
create or replace function staff_default_username() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_base text;
  v_try  text;
  v_n    int := 1;
begin
  if new.username is not null then
    new.username := lower(trim(new.username));
    return new;
  end if;

  select lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9._-]', '', 'g'))
    into v_base
    from auth.users where id = new.user_id;

  -- อีเมลบางแบบเหลือสั้นเกินกฎหลังตัดอักขระต้องห้าม ต้องมีชื่อสำรองเสมอ
  if v_base is null or length(v_base) < 3 then
    v_base := 'staff' || substr(replace(new.user_id::text, '-', ''), 1, 6);
  end if;

  v_try := v_base;
  while exists (select 1 from staff where lower(username) = v_try) loop
    v_n := v_n + 1;
    v_try := v_base || v_n::text;
  end loop;

  new.username := v_try;
  return new;
end;
$$;

drop trigger if exists staff_username_default on staff;
create trigger staff_username_default
  before insert on staff
  for each row execute function staff_default_username();

-- ---------------------------------------------------------------------------
-- หาอีเมลที่ใช้ล็อกอินจาก username
--
-- เรียกได้โดยไม่ต้องล็อกอิน เพราะต้องใช้ "ก่อน" ล็อกอิน
-- คืนอีเมลปลอมเมื่อหาไม่เจอ เพื่อไม่ให้ใครไล่เดาได้ว่ามี username ไหนอยู่บ้าง
-- — ไม่ว่าจะใส่ชื่อถูกหรือผิด ผลที่ได้คือ "รหัสผ่านไม่ถูกต้อง" เหมือนกัน
-- ---------------------------------------------------------------------------
create or replace function login_email_for(p_username text)
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_input text := lower(trim(coalesce(p_username, '')));
  v_email text;
begin
  -- พิมพ์อีเมลเต็มมาก็ให้ผ่านไปตรง ๆ รองรับบัญชีที่สร้างไว้ก่อนมีระบบ username
  if v_input like '%@%' then
    return v_input;
  end if;

  select u.email into v_email
    from staff s
    join auth.users u on u.id = s.user_id
   where lower(s.username) = v_input;

  return coalesce(v_email, 'unknown-' || v_input || '@invalid.local');
end;
$$;

-- ---------------------------------------------------------------------------
-- รายชื่อพนักงาน
--
-- อีเมลอยู่ใน auth.users ซึ่ง client อ่านตรงไม่ได้ จึงต้องผ่าน SECURITY DEFINER
-- ที่ตรวจสิทธิ์เองก่อน
-- ---------------------------------------------------------------------------
create or replace function list_staff()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_manager();

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', s.user_id,
             'username', s.username,
             'displayName', s.display_name,
             'role', s.role,
             'active', s.active,
             'email', u.email,
             'createdAt', s.created_at,
             'isSelf', s.user_id = auth.uid()
           ) order by
             -- เรียงตามอำนาจ แล้วค่อยตามชื่อ
             case s.role when 'owner' then 0 when 'manager' then 1 else 2 end,
             s.display_name)
      from staff s
      join auth.users u on u.id = s.user_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- กันร้านล็อกตัวเอง: ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คน
-- ไม่งั้นจะไม่มีใครเข้าไปแก้อะไรได้อีก และกู้คืนได้ทางเดียวคือเข้า Dashboard
-- ไปแก้ SQL เอง
-- ---------------------------------------------------------------------------
create or replace function assert_owner_remains(p_user_id uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from staff where user_id = p_user_id and role = 'owner' and active
  ) and (select count(*) from staff where role = 'owner' and active) <= 1 then
    raise exception 'ต้องเหลือเจ้าของร้านที่ใช้งานได้อย่างน้อย 1 คน'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function set_staff_role(p_user_id uuid, p_role text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if p_role not in ('staff', 'manager', 'owner') then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  -- ตั้งคนเป็นเจ้าของร้านได้เฉพาะเจ้าของร้านด้วยกัน
  -- ไม่งั้นผู้จัดการจะเลื่อนคนอื่น (หรือวางหมากให้ตัวเอง) ขึ้นเป็นเจ้าของได้
  if p_role = 'owner' and my_staff_role() <> 'owner' then
    raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่ตั้งเจ้าของร้านคนใหม่ได้'
      using errcode = '42501';
  end if;

  -- เปลี่ยนสิทธิ์ตัวเองไม่ได้ กันกดพลาดแล้วหลุดออกจากหน้าตั้งค่าของตัวเอง
  if p_user_id = auth.uid() and p_role <> my_staff_role() then
    raise exception 'เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้ ให้คนอื่นเปลี่ยนให้'
      using errcode = '22023';
  end if;

  if p_role <> 'owner' then
    perform assert_owner_remains(p_user_id);
  end if;

  update staff set role = p_role where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_role', 'staff', p_user_id,
          jsonb_build_object('role', p_role));
  return v_row;
end;
$$;

create or replace function set_staff_active(p_user_id uuid, p_active boolean)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if p_user_id = auth.uid() and not p_active then
    raise exception 'ปิดการใช้งานบัญชีตัวเองไม่ได้' using errcode = '22023';
  end if;

  if not p_active then
    perform assert_owner_remains(p_user_id);
  end if;

  update staff set active = p_active where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'set_staff_active', 'staff', p_user_id,
          jsonb_build_object('active', p_active));
  return v_row;
end;
$$;

create or replace function rename_staff(p_user_id uuid, p_name text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_manager();

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อ' using errcode = '22023';
  end if;

  update staff set display_name = trim(p_name)
   where user_id = p_user_id returning * into v_row;
  if not found then
    raise exception 'ไม่พบพนักงานคนนี้' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edge Function เรียกตัวนี้หลังสร้างบัญชี Auth เสร็จ
--
-- แยกออกมาเพื่อให้กติกา "ใครตั้งใครเป็นอะไรได้" อยู่ในฐานข้อมูลที่เดียว
-- ไม่กระจายไปอยู่ในโค้ด Edge Function ด้วย
--
-- p_actor ส่งมาจาก Edge Function เพราะเวลาเรียกด้วย service_role นั้น
-- auth.uid() เป็น null — ถ้าไม่บอกว่าใครสั่ง audit_log จะว่างเปล่า
-- ---------------------------------------------------------------------------
create or replace function register_staff(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_role     text,
  p_actor    uuid
) returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row        staff;
  v_actor_role text;
  v_username   text := lower(trim(coalesce(p_username, '')));
begin
  select role into v_actor_role from staff where user_id = p_actor and active;
  if v_actor_role is null or v_actor_role not in ('manager', 'owner') then
    raise exception 'ต้องเป็นผู้จัดการหรือเจ้าของร้าน' using errcode = '42501';
  end if;

  if p_role not in ('staff', 'manager', 'owner') then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  if p_role = 'owner' and v_actor_role <> 'owner' then
    raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่ตั้งเจ้าของร้านคนใหม่ได้'
      using errcode = '42501';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'ต้องใส่ชื่อพนักงาน' using errcode = '22023';
  end if;

  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'ชื่อผู้ใช้ต้องยาว 3–30 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข'
      using errcode = '22023';
  end if;

  if exists (select 1 from staff where lower(username) = v_username) then
    raise exception 'ชื่อผู้ใช้ "%" ถูกใช้ไปแล้ว', v_username using errcode = '23505';
  end if;

  insert into staff (user_id, username, display_name, role)
  values (p_user_id, v_username, trim(p_name), p_role)
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (p_actor, 'register_staff', 'staff', p_user_id,
          jsonb_build_object('username', v_username, 'name', v_row.display_name,
                             'role', p_role));

  return v_row;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

revoke all on function
  staff_default_username(),
  login_email_for(text),
  list_staff(),
  assert_owner_remains(uuid),
  set_staff_role(uuid, text),
  set_staff_active(uuid, boolean),
  rename_staff(uuid, text),
  register_staff(uuid, text, text, text, uuid)
from public, anon, authenticated;

-- ต้องเรียกได้ก่อนล็อกอิน จึงเปิดให้ anon
grant execute on function login_email_for(text)           to anon, authenticated;

grant execute on function list_staff()                    to authenticated;
grant execute on function set_staff_role(uuid, text)      to authenticated;
grant execute on function set_staff_active(uuid, boolean) to authenticated;
grant execute on function rename_staff(uuid, text)        to authenticated;

-- register_staff ไม่เปิดให้เรียกจากเบราว์เซอร์เลย — Edge Function เรียกด้วย
-- service_role ซึ่งข้ามการตรวจสิทธิ์ของ Postgres อยู่แล้ว
