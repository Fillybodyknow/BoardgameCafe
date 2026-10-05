-- ============================================================================
-- แยกสิทธิ์เป็น 4 อย่าง แล้วให้ระดับพนักงานเป็นชุดสำเร็จของสิทธิ์เหล่านั้น
--
-- ทำไมไม่เพิ่มเป็น role ตายตัวไปเรื่อย ๆ: ระดับที่ร้านอยากได้คือการจับคู่ของ
-- สิทธิ์ย่อย (ดูโต๊ะ / ดูครัว / ตั้งค่า / จัดการบัญชี) ถ้าทำเป็น role ล้วน ๆ
-- พอวันหน้าอยากได้ "ครัว + ตั้งค่า" ก็ต้องเพิ่ม role ใหม่และแก้ทุกฟังก์ชันอีกรอบ
-- เก็บเป็นตารางแทน ทำให้เพิ่ม/ปรับชุดสิทธิ์ได้โดยไม่ต้องแก้โค้ดเลย
--
--   floor     เปิดโต๊ะ รับออเดอร์ เช็คบิล จัดการคิวจอง
--   kitchen   จอครัว เปลี่ยนสถานะออเดอร์
--   settings  ตั้งค่าร้าน (เมนู โต๊ะ เรตราคา เวลาทำการ รูป)
--   accounts  เพิ่ม/แก้บัญชีพนักงาน
--
-- ระดับเดิมทั้งสามได้สิทธิ์เท่าเดิมเป๊ะ ไม่มีใครได้เพิ่มหรือถูกตัดจากการ migrate
-- ============================================================================

-- ไฟล์นี้ออกแบบให้รันซ้ำได้ ถ้าล้มกลางทางให้รันใหม่ทั้งไฟล์ได้เลย
create table if not exists role_capabilities (
  role       text not null,
  capability text not null check (capability in ('floor', 'kitchen', 'settings', 'accounts')),
  primary key (role, capability)
);

insert into role_capabilities (role, capability) values
  -- ดูโต๊ะและการจอง
  ('floor',   'floor'),
  -- ดูเฉพาะห้องครัว
  ('kitchen', 'kitchen'),
  -- ดูได้ทั้งหน้าร้านและครัว (ความหมายเดิมของ staff)
  ('staff',   'floor'), ('staff',   'kitchen'),
  -- เพิ่มการตั้งค่าร้าน (ความหมายเดิมของ manager)
  ('manager', 'floor'), ('manager', 'kitchen'), ('manager', 'settings'),
  -- เพิ่มการจัดการบัญชีพนักงาน (ความหมายเดิมของ owner)
  ('owner',   'floor'), ('owner',   'kitchen'), ('owner',   'settings'), ('owner', 'accounts')
on conflict do nothing;

alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('floor', 'kitchen', 'staff', 'manager', 'owner'));

-- ---------------------------------------------------------------------------
-- ตรวจสิทธิ์รายข้อ
-- ---------------------------------------------------------------------------
create or replace function has_cap(p_cap text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = auth.uid() and s.active and rc.capability = p_cap
  );
$$;

create or replace function assert_cap(p_cap text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_cap(p_cap) then
    raise exception '%', case p_cap
      when 'floor'    then 'ต้องมีสิทธิ์ดูแลหน้าร้าน'
      when 'kitchen'  then 'ต้องมีสิทธิ์ดูแลห้องครัว'
      when 'settings' then 'ต้องมีสิทธิ์ตั้งค่าร้าน'
      when 'accounts' then 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน'
      else 'ไม่มีสิทธิ์ทำรายการนี้'
    end using errcode = '42501';
  end if;
end;
$$;

/** หน้าจอใช้ซ่อน/แสดงเมนู — การซ่อนเมนูไม่ใช่กำแพง ด่านจริงอยู่ที่ RPC */
create or replace function my_capabilities() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(rc.capability order by rc.capability), '{}')
    from staff s
    join role_capabilities rc on rc.role = s.role
   where s.user_id = auth.uid() and s.active;
$$;

-- ---------------------------------------------------------------------------
-- เปลี่ยนนิยามของด่านเดิม แทนที่จะไล่แก้ทุก RPC
--
-- assert_staff()   ถูกเรียกจาก 14 RPC ซึ่งเป็นงานหน้าร้านทั้งหมด ยกเว้น
--                  update_order_status ที่เป็นงานครัว จึงประกาศแยกด้านล่าง
-- assert_manager() ถูกเรียกจาก RPC ตั้งค่าร้านทุกตัว
-- is_manager()     ถูกเรียกจาก policy ของ storage ตอนอัปโหลดรูปเมนู
-- is_staff()       ใช้ใน RLS สำหรับ "อ่าน" ข้อมูล — ยังหมายถึงพนักงานที่ใช้งานอยู่
--                  ไม่เปลี่ยน เพราะคนครัวก็ต้องอ่านออเดอร์และโต๊ะได้
-- ---------------------------------------------------------------------------
create or replace function assert_staff() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('floor');
end;
$$;

create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_cap('settings');
$$;

create or replace function assert_manager() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('settings');
end;
$$;

-- งานครัว: เปลี่ยนสถานะออเดอร์
create or replace function update_order_status(p_order_id uuid, p_status order_status)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_from  order_status;
  v_ok    boolean;
begin
  perform assert_cap('kitchen');

  select status into v_from from orders where id = p_order_id for update;
  if not found then
    raise exception 'ไม่พบออเดอร์ %', p_order_id using errcode = 'P0002';
  end if;

  v_ok := case v_from
    when 'placed'    then p_status in ('accepted', 'rejected', 'cancelled')
    when 'accepted'  then p_status in ('preparing', 'cancelled')
    when 'preparing' then p_status = 'ready'
    when 'ready'     then p_status = 'served'
    else false
  end;

  if not v_ok then
    raise exception 'เปลี่ยนสถานะจาก % เป็น % ไม่ได้', v_from, p_status using errcode = '22023';
  end if;

  update orders set status = p_status where id = p_order_id returning * into v_order;
  return v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- จัดการบัญชีพนักงาน: แยกออกจาก "ตั้งค่าร้าน" เป็นสิทธิ์ของตัวเอง
-- คนที่แก้ราคาได้ ไม่จำเป็นต้องเพิ่มบัญชีคนอื่นได้
-- ---------------------------------------------------------------------------
create or replace function list_staff()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform assert_cap('accounts');

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
             case s.role
               when 'owner' then 0 when 'manager' then 1
               when 'staff' then 2 when 'floor' then 3 else 4
             end,
             s.display_name)
      from staff s
      join auth.users u on u.id = s.user_id
  ), '[]'::jsonb);
end;
$$;

create or replace function set_staff_role(p_user_id uuid, p_role text)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_cap('accounts');

  if not exists (select 1 from role_capabilities where role = p_role) then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
  end if;

  -- ยกสิทธิ์จัดการบัญชีให้คนอื่นได้เฉพาะคนที่มีสิทธิ์นั้นอยู่แล้ว
  -- ไม่งั้นคนที่ได้สิทธิ์นี้มาจะแต่งตั้งใครก็ได้ให้เท่าเทียมตัวเอง โดยที่
  -- เจ้าของร้านไม่รู้ตัว
  if exists (select 1 from role_capabilities
              where role = p_role and capability = 'accounts')
     and not has_cap('accounts') then
    raise exception 'ต้องมีสิทธิ์จัดการบัญชีพนักงานก่อน จึงจะยกสิทธิ์นี้ให้คนอื่นได้'
      using errcode = '42501';
  end if;

  if p_user_id = auth.uid() and p_role <> (select role from staff where user_id = auth.uid()) then
    raise exception 'เปลี่ยนระดับสิทธิ์ของตัวเองไม่ได้ ให้คนอื่นเปลี่ยนให้'
      using errcode = '22023';
  end if;

  -- ต้องเหลือคนที่จัดการบัญชีได้อย่างน้อยหนึ่งคน ไม่งั้นจะไม่มีใครแก้อะไรได้อีก
  if not exists (select 1 from role_capabilities
                  where role = p_role and capability = 'accounts') then
    perform assert_admin_remains(p_user_id);
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

-- ---------------------------------------------------------------------------
-- เดิมผูกกับ role 'owner' ตรง ๆ ตอนนี้ผูกกับ "สิทธิ์จัดการบัญชี" แทน
-- เพราะระดับที่ถือสิทธิ์นั้นอาจมีมากกว่าหนึ่งชื่อในอนาคต
-- ---------------------------------------------------------------------------
create or replace function assert_admin_remains(p_user_id uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_is_admin boolean;
begin
  select exists (
    select 1 from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = p_user_id and s.active and rc.capability = 'accounts'
  ) into v_is_admin;

  if v_is_admin and (
    select count(distinct s.user_id) from staff s
      join role_capabilities rc on rc.role = s.role
     where s.active and rc.capability = 'accounts'
  ) <= 1 then
    raise exception 'ต้องเหลือคนที่จัดการบัญชีพนักงานได้อย่างน้อย 1 คน'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function set_staff_active(p_user_id uuid, p_active boolean)
returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row staff;
begin
  perform assert_cap('accounts');

  if p_user_id = auth.uid() and not p_active then
    raise exception 'ปิดการใช้งานบัญชีตัวเองไม่ได้' using errcode = '22023';
  end if;

  if not p_active then
    perform assert_admin_remains(p_user_id);
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
  perform assert_cap('accounts');

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

create or replace function register_staff(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_role     text,
  p_actor    uuid
) returns staff
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      staff;
  v_username text := lower(trim(coalesce(p_username, '')));
  v_can      boolean;
begin
  select exists (
    select 1 from staff s
      join role_capabilities rc on rc.role = s.role
     where s.user_id = p_actor and s.active and rc.capability = 'accounts'
  ) into v_can;

  if not v_can then
    raise exception 'ต้องมีสิทธิ์จัดการบัญชีพนักงาน' using errcode = '42501';
  end if;

  if not exists (select 1 from role_capabilities where role = p_role) then
    raise exception 'ระดับสิทธิ์ไม่ถูกต้อง' using errcode = '22023';
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
  has_cap(text),
  assert_cap(text),
  my_capabilities(),
  assert_admin_remains(uuid)
from public, anon, authenticated;

-- หน้าจอต้องรู้ว่าตัวเองทำอะไรได้บ้าง เพื่อซ่อนเมนูที่กดไปก็โดนปฏิเสธ
grant execute on function my_capabilities() to authenticated;
grant execute on function has_cap(text)     to authenticated;

grant select on role_capabilities to authenticated;
alter table role_capabilities enable row level security;
drop policy if exists staff_read_capabilities on role_capabilities;
create policy staff_read_capabilities on role_capabilities
  for select to authenticated using (is_staff());

-- ของเดิมผูกกับชื่อ role 'owner' ตรง ๆ ถูกแทนด้วย assert_admin_remains แล้ว
-- ลบทิ้งไม่ให้มีด่านสองชุดที่อาจเพี้ยนจากกัน
drop function if exists assert_owner_remains(uuid);
