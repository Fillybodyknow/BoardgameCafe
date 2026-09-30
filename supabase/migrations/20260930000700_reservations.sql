-- ============================================================================
-- จองโต๊ะออนไลน์
--
-- กติกาที่ตกลงไว้:
--   - ลูกค้าจองแล้วได้สถานะ "รอยืนยัน" พนักงานกดยืนยันอีกที
--   - ลูกค้าเลือกโต๊ะเองจากผัง (เห็นว่าโต๊ะไหนว่างในช่วงเวลาที่เลือก)
--   - ไม่มี OTP — ลูกค้าได้ "รหัสจอง" ไว้เปิดดูและยกเลิกเอง
--   - ร้านเปิด 11:00–23:00 ทุกวัน (แก้ได้ในตาราง shop_hours)
--
-- ความปลอดภัย: ลูกค้าไม่ได้ล็อกอิน จึงอ่านตาราง reservations ตรงไม่ได้เลย
--   ต้องมีทั้งรหัสจองและเบอร์โทรจึงจะเปิดดูรายการของตัวเองได้
--   (รหัสอย่างเดียวไม่พอ กันคนสุ่มรหัสแล้วไล่ดูข้อมูลคนอื่น)
-- ============================================================================

-- ------------------------------------------------------------ เวลาทำการ ----

create table shop_hours (
  weekday    smallint primary key check (weekday between 0 and 6),  -- 0 = อาทิตย์
  open_time  time not null,
  close_time time not null,
  closed     boolean not null default false
);

insert into shop_hours (weekday, open_time, close_time)
select g, '11:00', '23:00' from generate_series(0, 6) g;

create table reservation_config (
  id                       int primary key default 1 check (id = 1),
  -- ลูกค้าเลือกเวลาได้ทีละกี่นาที
  slot_minutes             int not null default 30,
  default_duration_minutes int not null default 120,
  min_duration_minutes     int not null default 60,
  max_duration_minutes     int not null default 300,
  -- เลยเวลานัดเท่านี้แล้วยังไม่มา ถือว่าไม่มา แล้วปล่อยโต๊ะ
  grace_minutes            int not null default 20,
  -- เผื่อเวลาเก็บโต๊ะระหว่างรอบ
  buffer_minutes           int not null default 15,
  -- จองล่วงหน้าได้ไม่เกินกี่วัน
  max_advance_days         int not null default 30,
  -- ต้องจองล่วงหน้าอย่างน้อยกี่นาที (กันจองตอนยืนอยู่หน้าร้าน)
  min_advance_minutes      int not null default 30,
  -- โต๊ะที่มีลูกค้านั่งอยู่ ไม่รับจองในช่วงกี่นาทีข้างหน้า
  occupied_hold_minutes    int not null default 90,
  -- กันจองมั่ว: เบอร์เดียวจองค้างได้กี่รายการ
  max_pending_per_phone    int not null default 3
);

insert into reservation_config (id) values (1);

-- --------------------------------------------------------- reservations ----

alter table reservations
  add column code         text unique,
  -- เก็บเป็นคอลัมน์จริงแล้วให้ trigger ดูแล ใช้ generated column ไม่ได้
  -- เพราะ timestamptz + interval เป็น STABLE ไม่ใช่ IMMUTABLE (เรื่อง DST)
  add column end_at       timestamptz,
  add column source       text not null default 'staff'
                          check (source in ('staff', 'online')),
  add column confirmed_at timestamptz,
  add column closed_at    timestamptz,
  add column staff_note   text;

create function reservations_set_end_at() returns trigger
language plpgsql as $$
begin
  new.end_at := new.start_at + make_interval(mins => new.duration_minutes);
  return new;
end;
$$;

create trigger reservations_end_at
  before insert or update of start_at, duration_minutes on reservations
  for each row execute function reservations_set_end_at();

-- เติมให้แถวที่มีอยู่ก่อนหน้า
update reservations set start_at = start_at;

create index reservations_window_idx on reservations (start_at, end_at)
  where status in ('pending', 'confirmed', 'seated');

create index reservations_tables_idx on reservations using gin (table_ids);

-- รหัสจอง: อ่านง่าย พูดทางโทรศัพท์ได้ ไม่มีตัวที่สับสน (0/O, 1/I)
create function new_reservation_code() returns text
language plpgsql volatile as $$
declare
  v_chars constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code  text;
  v_i     int;
begin
  loop
    v_code := '';
    for v_i in 1..6 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from reservations where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- โต๊ะว่างในช่วงเวลาที่ขอหรือเปล่า
--
-- ติดทั้งหมด 3 กรณี:
--   1. มีการจองอื่นคาบเกี่ยว (เผื่อ buffer เก็บโต๊ะหัวท้าย)
--   2. ตอนนี้มีลูกค้านั่งอยู่ และเวลาที่ขอใกล้เกินกว่าจะรับปากได้
--   3. โต๊ะกำลังเก็บ/ปิดใช้ชั่วคราว
-- โต๊ะที่นั่งร่วมกันได้ (allow_share) ไม่ติดกรณีที่ 1
-- ---------------------------------------------------------------------------
create function table_available(
  p_table_id uuid,
  p_start    timestamptz,
  p_end      timestamptz,
  p_exclude_reservation uuid default null
) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg   reservation_config;
  v_table cafe_tables;
begin
  select * into v_cfg from reservation_config where id = 1;
  select * into v_table from cafe_tables where id = p_table_id;
  if not found then return false; end if;

  if not v_table.allow_share and exists (
    select 1 from reservations r
     where r.status in ('pending', 'confirmed', 'seated')
       and p_table_id = any(r.table_ids)
       and (p_exclude_reservation is null or r.id <> p_exclude_reservation)
       -- คาบเกี่ยวกันเมื่อขยายช่วงของการจองเดิมออกหัวท้ายด้วย buffer
       and tstzrange(r.start_at - make_interval(mins => v_cfg.buffer_minutes),
                     r.end_at   + make_interval(mins => v_cfg.buffer_minutes))
           && tstzrange(p_start, p_end)
  ) then
    return false;
  end if;

  if not v_table.allow_share
     and p_start < now() + make_interval(mins => v_cfg.occupied_hold_minutes)
     and exists (
       select 1 from occupancies o
        where o.table_id = p_table_id and o.to_at is null
     ) then
    return false;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- ผังโต๊ะพร้อมสถานะว่าง/ไม่ว่าง สำหรับช่วงเวลาที่ลูกค้าเลือก
-- ลูกค้าเรียกได้โดยไม่ล็อกอิน — ไม่มี qr_token และไม่บอกว่าใครจอง
-- ---------------------------------------------------------------------------
create function available_tables(
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
             'id', t.id,
             'code', t.code,
             'zone', t.zone,
             'seatMin', t.seat_min,
             'seatMax', t.seat_max,
             'allowShare', t.allow_share,
             'available', table_available(t.id, p_start, v_end)
           ) order by t.sort_order)
      from cafe_tables t
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- ตรวจว่าเวลาที่ขออยู่ในเวลาทำการและอยู่ในกรอบที่รับจอง
-- แยกออกมาเพื่อให้ทั้งฝั่งลูกค้าและพนักงานใช้กติกาชุดเดียวกัน
-- ---------------------------------------------------------------------------
create function assert_bookable(p_start timestamptz, p_duration int)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg    reservation_config;
  v_hours  shop_hours;
  v_local  timestamp;
  v_end    timestamp;
begin
  select * into v_cfg from reservation_config where id = 1;

  if p_duration < v_cfg.min_duration_minutes or p_duration > v_cfg.max_duration_minutes then
    raise exception 'จองได้ครั้งละ %–% นาที',
      v_cfg.min_duration_minutes, v_cfg.max_duration_minutes using errcode = '22023';
  end if;

  if p_start < now() + make_interval(mins => v_cfg.min_advance_minutes) then
    raise exception 'ต้องจองล่วงหน้าอย่างน้อย % นาที', v_cfg.min_advance_minutes
      using errcode = '22023';
  end if;

  if p_start > now() + make_interval(days => v_cfg.max_advance_days) then
    raise exception 'จองล่วงหน้าได้ไม่เกิน % วัน', v_cfg.max_advance_days
      using errcode = '22023';
  end if;

  -- เทียบกับเวลาทำการตามเวลาไทย ไม่ใช่ UTC
  v_local := p_start at time zone 'Asia/Bangkok';
  v_end   := v_local + make_interval(mins => p_duration);

  select * into v_hours from shop_hours where weekday = extract(dow from v_local)::smallint;
  if not found or v_hours.closed then
    raise exception 'วันนั้นร้านปิด' using errcode = '22023';
  end if;

  if v_local::time < v_hours.open_time then
    raise exception 'ร้านเปิด % น.', to_char(v_hours.open_time, 'HH24:MI') using errcode = '22023';
  end if;

  -- ต้องเล่นจบก่อนร้านปิด และห้ามข้ามวัน
  if v_end::date <> v_local::date or v_end::time > v_hours.close_time then
    raise exception 'ต้องจบก่อนร้านปิด % น.', to_char(v_hours.close_time, 'HH24:MI')
      using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าจองเอง — ได้สถานะ "รอยืนยัน" และรหัสจองกลับไป
-- ---------------------------------------------------------------------------
create function create_reservation(
  p_customer_name text,
  p_phone         text,
  p_party_size    int,
  p_start_at      timestamptz,
  p_duration      int,
  p_table_ids     uuid[],
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg   reservation_config;
  v_res   reservations;
  v_end   timestamptz;
  v_id    uuid;
  v_seats int;
  v_phone text;
begin
  select * into v_cfg from reservation_config where id = 1;

  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_phone) < 9 then
    raise exception 'เบอร์โทรไม่ถูกต้อง' using errcode = '22023';
  end if;
  if coalesce(trim(p_customer_name), '') = '' then
    raise exception 'กรุณาใส่ชื่อผู้จอง' using errcode = '22023';
  end if;
  if p_party_size < 1 then
    raise exception 'จำนวนคนไม่ถูกต้อง' using errcode = '22023';
  end if;
  if coalesce(array_length(p_table_ids, 1), 0) = 0 then
    raise exception 'กรุณาเลือกโต๊ะ' using errcode = '22023';
  end if;

  perform assert_bookable(p_start_at, p_duration);

  -- กันจองมั่ว: เบอร์เดียวค้างได้ไม่เกินที่ตั้งไว้
  if (select count(*) from reservations
       where regexp_replace(phone, '[^0-9]', '', 'g') = v_phone
         and status in ('pending', 'confirmed')) >= v_cfg.max_pending_per_phone then
    raise exception 'เบอร์นี้มีรายการจองค้างอยู่ % รายการแล้ว กรุณาติดต่อร้าน',
      v_cfg.max_pending_per_phone using errcode = '22023';
  end if;

  v_end := p_start_at + make_interval(mins => p_duration);

  v_seats := 0;
  foreach v_id in array p_table_ids loop
    if not table_available(v_id, p_start_at, v_end) then
      raise exception 'โต๊ะ % ไม่ว่างในช่วงเวลานี้แล้ว',
        (select code from cafe_tables where id = v_id) using errcode = '22023';
    end if;
    v_seats := v_seats + (select seat_max from cafe_tables where id = v_id);
  end loop;

  if p_party_size > v_seats then
    raise exception 'โต๊ะที่เลือกนั่งได้ % คน แต่จอง % คน', v_seats, p_party_size
      using errcode = '22023';
  end if;

  insert into reservations (
    code, customer_name, phone, party_size, start_at, duration_minutes,
    table_ids, status, source, note
  ) values (
    new_reservation_code(), trim(p_customer_name), p_phone, p_party_size,
    p_start_at, p_duration, p_table_ids, 'pending', 'online', nullif(trim(p_note), '')
  ) returning * into v_res;

  return jsonb_build_object(
    'code', v_res.code,
    'status', v_res.status,
    'startAt', v_res.start_at,
    'durationMinutes', v_res.duration_minutes,
    'tables', (select jsonb_agg(code order by code) from cafe_tables where id = any(v_res.table_ids))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าเปิดดูรายการของตัวเอง — ต้องมีทั้งรหัสจองและเบอร์โทร
-- รหัสอย่างเดียวไม่พอ กันคนสุ่มรหัสไล่ดูข้อมูลคนอื่น
-- ---------------------------------------------------------------------------
create function reservation_by_code(p_code text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  select * into v_res from reservations
   where upper(code) = upper(trim(p_code))
     and regexp_replace(phone, '[^0-9]', '', 'g')
         = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  if not found then
    raise exception 'ไม่พบรายการจอง ตรวจรหัสและเบอร์โทรอีกครั้ง' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'code', v_res.code,
    'customerName', v_res.customer_name,
    'partySize', v_res.party_size,
    'startAt', v_res.start_at,
    'durationMinutes', v_res.duration_minutes,
    'status', v_res.status,
    'note', v_res.note,
    'tables', coalesce((select jsonb_agg(code order by code)
                          from cafe_tables where id = any(v_res.table_ids)), '[]'::jsonb)
  );
end;
$$;

create function cancel_reservation_by_code(p_code text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  select * into v_res from reservations
   where upper(code) = upper(trim(p_code))
     and regexp_replace(phone, '[^0-9]', '', 'g')
         = regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
   for update;

  if not found then
    raise exception 'ไม่พบรายการจอง' using errcode = 'P0002';
  end if;
  if v_res.status not in ('pending', 'confirmed') then
    raise exception 'รายการนี้ยกเลิกไม่ได้แล้ว' using errcode = '22023';
  end if;

  update reservations
     set status = 'cancelled', closed_at = now()
   where id = v_res.id;

  insert into audit_log (action, entity, entity_id, detail)
  values ('cancel_reservation', 'reservation', v_res.id,
          jsonb_build_object('by', 'guest', 'code', v_res.code));

  return jsonb_build_object('code', v_res.code, 'status', 'cancelled');
end;
$$;

-- --------------------------------------------------------------- พนักงาน ----

create function confirm_reservation(p_id uuid)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'confirmed', confirmed_at = now()
   where id = p_id and status = 'pending'
  returning * into v_res;

  if not found then
    raise exception 'ยืนยันได้เฉพาะรายการที่รอยืนยัน' using errcode = '22023';
  end if;
  return v_res;
end;
$$;

create function reject_reservation(p_id uuid, p_reason text default null)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'cancelled', closed_at = now(), staff_note = nullif(trim(p_reason), '')
   where id = p_id and status in ('pending', 'confirmed')
  returning * into v_res;

  if not found then
    raise exception 'รายการนี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'reject_reservation', 'reservation', p_id,
          jsonb_build_object('reason', p_reason));
  return v_res;
end;
$$;

create function mark_no_show(p_id uuid)
returns reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res reservations;
begin
  perform assert_staff();
  update reservations
     set status = 'no_show', closed_at = now()
   where id = p_id and status in ('pending', 'confirmed')
  returning * into v_res;

  if not found then
    raise exception 'รายการนี้ปิดไปแล้ว' using errcode = '22023';
  end if;
  return v_res;
end;
$$;

-- เช็คอินลูกค้าที่จองไว้ → เปิด visit จากโต๊ะที่จองไว้
--
-- p_table_ids: ใส่มาเพื่อย้ายไปโต๊ะอื่นตอนเช็คอิน เช่นกลุ่มก่อนหน้านั่งเลยเวลา
-- หรือลูกค้ามาไม่ครบ ไม่ใส่ = ใช้โต๊ะที่จองไว้
create function seat_reservation(
  p_id        uuid,
  p_guests    jsonb,
  p_table_ids uuid[] default null
) returns visits
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res    reservations;
  v_visit  visits;
  v_tables uuid[];
  v_busy   text;
begin
  perform assert_staff();

  select * into v_res from reservations where id = p_id for update;
  if not found then
    raise exception 'ไม่พบรายการจอง' using errcode = 'P0002';
  end if;
  if v_res.status not in ('pending', 'confirmed') then
    raise exception 'รายการนี้เช็คอินไม่ได้แล้ว' using errcode = '22023';
  end if;

  v_tables := coalesce(p_table_ids, v_res.table_ids);

  -- โต๊ะที่จองไว้อาจยังมีกลุ่มก่อนหน้านั่งอยู่ (นั่งเลยเวลา)
  -- บอกให้ชัดว่าโต๊ะไหนติด ดีกว่าปล่อยให้ชน constraint แล้วขึ้น error ที่อ่านไม่รู้เรื่อง
  select string_agg(t.code, ', ' order by t.code) into v_busy
    from cafe_tables t
    join occupancies o on o.table_id = t.id and o.to_at is null
   where t.id = any(v_tables) and not t.allow_share;

  if v_busy is not null then
    raise exception 'โต๊ะ % ยังมีลูกค้าอยู่ ปิดบิลโต๊ะเดิมก่อน หรือเลือกโต๊ะอื่นให้', v_busy
      using errcode = '22023';
  end if;

  v_visit := open_visit(v_tables, p_guests, 'reservation');

  update reservations
     set status = 'seated', visit_id = v_visit.id, closed_at = now(),
         -- บันทึกโต๊ะที่นั่งจริง ไม่ใช่โต๊ะที่จองไว้ตอนแรก
         table_ids = v_tables
   where id = p_id;

  return v_visit;
end;
$$;

-- ---------------------------------------------------------------------------
-- ปล่อยโต๊ะของคนที่เลยเวลานัดแล้วยังไม่มา
-- ตั้งให้ pg_cron เรียกทุก 5 นาที (ดูท้ายไฟล์)
-- ---------------------------------------------------------------------------
create function release_overdue_reservations()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg reservation_config;
  v_n   int;
begin
  select * into v_cfg from reservation_config where id = 1;

  with released as (
    update reservations
       set status = 'no_show', closed_at = now()
     where status in ('pending', 'confirmed')
       and start_at + make_interval(mins => v_cfg.grace_minutes) < now()
    returning id
  )
  select count(*) into v_n from released;

  return v_n;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----
--
-- ⚠️ ทุก migration ที่สร้างฟังก์ชันใหม่ต้องมีบล็อกแบบนี้
-- Postgres ให้ EXECUTE กับ PUBLIC ทุกฟังก์ชันที่สร้างใหม่ การตัดสิทธิ์ใน
-- migration ก่อนหน้าจึงไม่คุ้มถึงฟังก์ชันที่เพิ่มทีหลัง
-- (เทสต์ตรวจสิทธิ์ใน 20_operations_test.sql จะจับได้ถ้าลืม)

revoke all on function
  new_reservation_code(),
  reservations_set_end_at(),
  table_available(uuid, timestamptz, timestamptz, uuid),
  assert_bookable(timestamptz, int),
  available_tables(timestamptz, int),
  create_reservation(text, text, int, timestamptz, int, uuid[], text),
  reservation_by_code(text, text),
  cancel_reservation_by_code(text, text),
  confirm_reservation(uuid),
  reject_reservation(uuid, text),
  mark_no_show(uuid),
  seat_reservation(uuid, jsonb, uuid[]),
  release_overdue_reservations()
from public, anon, authenticated;

-- ลูกค้าที่ไม่ล็อกอิน: ดูโต๊ะว่าง จอง และจัดการรายการของตัวเองด้วยรหัส+เบอร์
grant execute on function available_tables(timestamptz, int)                      to anon, authenticated;
grant execute on function create_reservation(text, text, int, timestamptz, int, uuid[], text)
  to anon, authenticated;
grant execute on function reservation_by_code(text, text)                         to anon, authenticated;
grant execute on function cancel_reservation_by_code(text, text)                  to anon, authenticated;

-- พนักงาน (ข้างในเรียก assert_staff() อีกชั้น)
grant execute on function confirm_reservation(uuid)        to authenticated;
grant execute on function reject_reservation(uuid, text)   to authenticated;
grant execute on function mark_no_show(uuid)               to authenticated;
grant execute on function seat_reservation(uuid, jsonb, uuid[]) to authenticated;

-- ไม่เปิดให้ใครเรียกตรง: table_available, assert_bookable, new_reservation_code,
-- reservations_set_end_at (trigger), release_overdue_reservations (cron เรียกเอง)

alter table shop_hours         enable row level security;
alter table reservation_config enable row level security;

grant select on shop_hours, reservation_config to anon, authenticated;

create policy public_read_hours on shop_hours
  for select to anon, authenticated using (true);
create policy public_read_reservation_config on reservation_config
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------------ cron ----

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'release-overdue-reservations', '*/5 * * * *',
      'select release_overdue_reservations()'
    );
  else
    raise notice 'ไม่มี pg_cron — ต้องเรียก release_overdue_reservations() เองเป็นระยะ';
  end if;
exception when others then
  raise notice 'ตั้ง pg_cron ไม่สำเร็จ (%) — ตั้งเองได้ที่ Dashboard → Database → Cron', sqlerrm;
end;
$$;
