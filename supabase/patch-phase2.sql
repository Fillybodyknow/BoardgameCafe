-- ============================================================================
-- Boardgame Cafe — patch Phase 2 (ลูกค้าสั่งผ่าน QR + อุดสิทธิ์ EXECUTE)
--
-- สำหรับฐานข้อมูลที่ติดตั้งเวอร์ชันก่อนหน้าไปแล้ว
-- ถ้าเป็นการติดตั้งใหม่ ใช้ setup-all.sql แทน (รวมไฟล์นี้ไว้แล้ว)
--
-- รันซ้ำได้ แต่รันย้อนลำดับไม่ได้ — ถ้ามี patch ที่ใหม่กว่าติดตั้งไปแล้ว
-- ไฟล์นี้จะหยุดทันทีพร้อมบอกเหตุผล แทนที่จะทับของใหม่ด้วยของเก่าเงียบ ๆ
-- ============================================================================

create table if not exists schema_patches (
  name       text primary key,
  seq        bigint not null,
  applied_at timestamptz not null default now()
);

do $$
declare v_newer text;
begin
  select string_agg(name, ', ' order by seq) into v_newer
    from schema_patches where seq > 20260930000600;

  if v_newer is not null then
    raise exception
      'ฐานข้อมูลนี้ติดตั้ง % ซึ่งใหม่กว่า patch-phase2 ไปแล้ว การรันไฟล์นี้จะทับของใหม่ด้วยของเก่า — ไม่ต้องรัน', v_newer
      using errcode = '55000';
  end if;
end;
$$;

-- ###### supabase/migrations/20260930000500_guest_ordering.sql

-- ============================================================================
-- ลูกค้าสั่งเองผ่าน QR ที่โต๊ะ
--
-- ปัญหา: ลูกค้าไม่ได้ล็อกอิน แต่ต้องสั่งของเข้าครัวได้ และต้องไม่เห็นข้อมูล
--        ของโต๊ะอื่นเลย
--
-- วิธี: QR ของแต่ละโต๊ะพก token ติดตัว (capability URL)
--       ทุก RPC ฝั่งลูกค้ารับ token แทนการล็อกอิน แล้วแปลง token → โต๊ะ → visit
--       ที่เปิดอยู่ ลูกค้าไม่เคยส่ง visit_id หรือ table_id มาเอง จึงอ้างถึง
--       โต๊ะอื่นไม่ได้
--
-- token ใช้ได้เฉพาะตอนที่โต๊ะนั้นมี visit เปิดอยู่จริง
-- พอปิดบิล QR เดิมก็ใช้สั่งอะไรไม่ได้อีกจนกว่าจะมีลูกค้าใหม่นั่ง
-- ============================================================================

alter table cafe_tables add column qr_token uuid not null default gen_random_uuid();
create unique index cafe_tables_qr_token_idx on cafe_tables (qr_token);

-- token ไม่ใช่ข้อมูลสาธารณะ — ใครได้ไปก็สั่งของลงโต๊ะนั้นได้
-- ก่อนหน้านี้ anon อ่าน cafe_tables ได้ทั้งแถว ถ้าปล่อยไว้ qr_token จะหลุด
-- ทันทีที่คนนอกเปิดผังโต๊ะ จึงตัดสิทธิ์อ่านตารางตรง แล้วเปิดเป็น view
-- ที่ไม่มีคอลัมน์ token แทน
drop policy public_read_tables on cafe_tables;
revoke select on cafe_tables from anon;

-- ไม่ใส่ security_invoker → view รันด้วยสิทธิ์เจ้าของ (พฤติกรรมปริยายของ Postgres)
-- ซึ่งจำเป็น เพราะ anon อ่านตารางต้นทางไม่ได้แล้ว
create view public_tables as
  select id, code, zone, seat_min, seat_max, allow_share, status, sort_order
    from cafe_tables;

grant select on public_tables to anon, authenticated;

-- พนักงานยังต้องอ่านตารางเต็ม (ต้องใช้ qr_token ไปสร้าง QR)
create policy staff_read_tables on cafe_tables
  for select to authenticated using (is_staff());

-- ปิดช่องที่เปิดไว้รอบก่อน: anon เรียก preview_bill ด้วย visit_id ของใครก็ได้
-- ต่อไปลูกค้าดูบิลได้ทางเดียวคือผ่าน guest_bill() ซึ่งต้องมี token ของโต๊ะตัวเอง
revoke execute on function preview_bill(uuid, timestamptz) from anon;

-- ---------------------------------------------------------------------------
-- แปลง token เป็น visit ที่เปิดอยู่ของโต๊ะนั้น
-- คืน null ถ้าโต๊ะยังไม่ได้เปิด (ลูกค้าต้องไปหาพนักงานก่อน)
-- ---------------------------------------------------------------------------
create function visit_for_token(p_token uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select v.id
    from cafe_tables t
    join occupancies o on o.table_id = t.id and o.to_at is null
    join visits v on v.id = o.visit_id and v.status = 'open'
   where t.qr_token = p_token
   order by o.from_at desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- ข้อมูลที่ลูกค้าเห็นหลังสแกน QR
-- จงใจคืนเฉพาะสิ่งที่จำเป็น: โต๊ะไหน มีใครนั่งอยู่บ้าง (ชื่อเล่น) และเมนู
-- ไม่มียอดเงิน ไม่มีข้อมูลโต๊ะอื่น
-- ---------------------------------------------------------------------------
create function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_visit uuid;
begin
  select * into v_table from cafe_tables where qr_token = p_token;
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
       where gp.visit_id = v_visit
         and gp.status in ('active', 'paused')
    ), '[]'::jsonb),
    'menu', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'sku', m.sku, 'name', m.name,
               'category', m.category, 'price', m.price, 'available', m.available)
             order by m.sort_order)
        from menu_items m
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- แกนกลางของการสั่งของ — ไม่ตรวจสิทธิ์เอง
-- ให้ place_order (พนักงาน) กับ guest_place_order (ลูกค้า) เรียกร่วมกัน
-- เพื่อไม่ให้กติกาแตกเป็นสองชุดแล้วเพี้ยนจากกันภายหลัง
-- ---------------------------------------------------------------------------
create function place_order_core(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_item  jsonb;
  v_menu  menu_items;
  v_table uuid;
  v_qty   int;
begin
  select * into v_order from orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if not exists (select 1 from visits where id = p_visit_id and status = 'open') then
    raise exception 'visit นี้ปิดแล้ว สั่งเพิ่มไม่ได้' using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ตะกร้าว่าง' using errcode = '22023';
  end if;

  if p_split_mode = 'owner' then
    if p_ordered_by_pass_id is null then
      raise exception 'ต้องระบุว่าใครสั่ง' using errcode = '22023';
    end if;
    if not exists (
      select 1 from guest_passes
       where id = p_ordered_by_pass_id
         and visit_id = p_visit_id
         and status in ('active', 'paused')
    ) then
      raise exception 'ผู้สั่งไม่ได้อยู่ในกลุ่มนี้แล้ว' using errcode = '22023';
    end if;
  end if;

  select table_id into v_table
    from occupancies
   where visit_id = p_visit_id and to_at is null
   order by from_at
   limit 1;

  insert into orders (
    visit_id, ordered_by_pass_id, placed_by, split_mode,
    table_id_snapshot, idempotency_key
  ) values (
    p_visit_id,
    case when p_split_mode = 'shared' then null else p_ordered_by_pass_id end,
    p_placed_by, p_split_mode, v_table, p_idempotency_key
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_menu from menu_items where id = (v_item ->> 'menuItemId')::uuid;
    if not found then
      raise exception 'ไม่พบเมนู %', v_item ->> 'menuItemId' using errcode = 'P0002';
    end if;
    if not v_menu.available then
      raise exception '% หมดแล้ว', v_menu.name using errcode = '22023';
    end if;

    v_qty := coalesce((v_item ->> 'qty')::int, 0);
    if v_qty <= 0 then
      raise exception 'จำนวนต้องมากกว่า 0' using errcode = '22023';
    end if;

    -- ราคามาจาก DB เสมอ ไม่ว่าใครเป็นคนสั่ง
    insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty, note)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, nullif(v_item ->> 'note', ''));
  end loop;

  return v_order;
end;
$$;

-- พนักงานสั่งแทนลูกค้า — เหลือแค่ตรวจสิทธิ์แล้วส่งต่อ
create or replace function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform assert_staff();
  return place_order_core(
    p_idempotency_key, p_visit_id, p_ordered_by_pass_id,
    p_split_mode, p_placed_by, p_items
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าสั่งเอง — เข้าครัวทันที ไม่ต้องรอพนักงานอนุมัติ
-- ลูกค้าส่งมาแค่ token กับ pass ของตัวเอง visit_id มาจากฝั่งเซิร์ฟเวอร์เท่านั้น
-- ---------------------------------------------------------------------------
create function guest_place_order(
  p_token              uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_items              jsonb,
  p_idempotency_key    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_order orders;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_order := place_order_core(
    p_idempotency_key, v_visit, p_ordered_by_pass_id,
    p_split_mode, 'guest', p_items
  );

  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าดูออเดอร์ของโต๊ะตัวเอง (ติดตามสถานะ) และยอดปัจจุบัน
-- ---------------------------------------------------------------------------
create function guest_orders(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_visit uuid;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', o.id,
             'status', o.status,
             'placedAt', o.placed_at,
             'orderedByPassId', o.ordered_by_pass_id,
             'splitMode', o.split_mode,
             'lines', (
               select jsonb_agg(jsonb_build_object(
                        'id', ol.id, 'name', ol.name_snapshot,
                        'qty', ol.qty, 'amount', round(ol.unit_price_snapshot * ol.qty, 2)))
                 from order_lines ol where ol.order_id = o.id
             )
           ) order by o.placed_at desc)
      from orders o where o.visit_id = v_visit
  ), '[]'::jsonb);
end;
$$;

create function guest_bill(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_visit uuid;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด' using errcode = '22023';
  end if;
  return preview_bill(v_visit);
end;
$$;

-- ---------------------------------------------------------------------------
-- เปลี่ยน token ของโต๊ะ — ใช้เมื่อสงสัยว่า QR หลุดออกนอกร้าน
-- QR ใบเดิมใช้ไม่ได้ทันที ต้องพิมพ์ใหม่
-- ---------------------------------------------------------------------------
create function rotate_table_token(p_table_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid;
begin
  perform assert_staff();
  update cafe_tables set qr_token = gen_random_uuid()
   where id = p_table_id
  returning qr_token into v_token;

  if not found then
    raise exception 'ไม่พบโต๊ะ %', p_table_id using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id)
  values (auth.uid(), 'rotate_table_token', 'cafe_table', p_table_id);

  return v_token;
end;
$$;

-- ----------------------------------------------------------------- สิทธิ์ ----

grant execute on function guest_session(uuid)                                   to anon, authenticated;
grant execute on function guest_orders(uuid)                                    to anon, authenticated;
grant execute on function guest_bill(uuid)                                      to anon, authenticated;
grant execute on function guest_place_order(uuid, uuid, split_mode, jsonb, text) to anon, authenticated;

grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb) to authenticated;
grant execute on function rotate_table_token(uuid) to authenticated;

-- แกนกลางเรียกตรงไม่ได้ ต้องผ่าน place_order หรือ guest_place_order เท่านั้น
revoke execute on function place_order_core(text, uuid, uuid, split_mode, placed_by_actor, jsonb)
  from anon, authenticated, public;
revoke execute on function visit_for_token(uuid) from anon, authenticated, public;

-- ###### supabase/migrations/20260930000600_harden_execute.sql

-- ============================================================================
-- อุดช่อง: EXECUTE ถูกให้กับ PUBLIC โดยปริยาย
--
-- Postgres ให้สิทธิ์ EXECUTE ของฟังก์ชันใหม่กับ PUBLIC เสมอ
-- การ revoke จาก anon/authenticated อย่างเดียวจึงไม่มีผลใด ๆ — สิทธิ์ยังมาทาง
-- PUBLIC อยู่ดี ผลคือก่อนไฟล์นี้ ใครก็เรียก RPC ทุกตัวได้
--
-- ที่ยังไม่เกิดความเสียหายเพราะ assert_staff() ข้างในปฏิเสธไว้อีกชั้น
-- แต่ preview_bill ไม่มีชั้นนั้น → คนนอกที่รู้ visit id จึงเปิดดูบิลคนอื่นได้
--
-- ไฟล์นี้ตัดสิทธิ์จาก PUBLIC ให้หมดก่อน แล้วคืนเฉพาะที่ตั้งใจ
-- เป็นรายการสิทธิ์ที่เชื่อถือได้เพียงชุดเดียว ทับของเดิมทั้งหมด
-- ============================================================================

revoke all on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------- ลูกค้าที่ไม่ล็อกอิน ----
-- เข้าถึงได้ทางเดียวคือถือ QR token ของโต๊ะตัวเอง
-- ทุกตัวแปลง token → visit เองฝั่งเซิร์ฟเวอร์ ลูกค้าระบุโต๊ะอื่นไม่ได้

grant execute on function guest_session(uuid)                                    to anon, authenticated;
grant execute on function guest_orders(uuid)                                     to anon, authenticated;
grant execute on function guest_bill(uuid)                                       to anon, authenticated;
grant execute on function guest_place_order(uuid, uuid, split_mode, jsonb, text)  to anon, authenticated;

-- ------------------------------------------------------------- พนักงาน ----
-- ยังเรียก assert_staff() ข้างในอีกชั้น — ล็อกอินเฉย ๆ ไม่พอ

grant execute on function is_staff()                                  to authenticated;
grant execute on function preview_bill(uuid, timestamptz)             to authenticated;
grant execute on function open_visit(uuid[], jsonb, visit_source)     to authenticated;
grant execute on function add_pass(uuid, text, uuid)                  to authenticated;
grant execute on function pause_pass(uuid)                            to authenticated;
grant execute on function resume_pass(uuid)                           to authenticated;
grant execute on function check_out_pass(uuid)                        to authenticated;
grant execute on function move_visit_to_tables(uuid, uuid[])          to authenticated;
grant execute on function update_order_status(uuid, order_status)     to authenticated;
grant execute on function close_visit(uuid, jsonb)                    to authenticated;
grant execute on function rotate_table_token(uuid)                    to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb)
  to authenticated;

-- ----------------------------------------------------- ไม่ให้ใครเรียกตรง ----
-- ฟังก์ชันภายใน เรียกได้เฉพาะจากฟังก์ชันอื่นที่ตรวจสิทธิ์แล้ว
--   place_order_core  — ไม่ตรวจสิทธิ์เลย ถ้าเรียกตรงได้คือสั่งของลงโต๊ะใครก็ได้
--   visit_for_token   — แปลง token เป็น visit id
--   assert_staff      — ไม่มีประโยชน์กับ client
--   billable_minutes / play_time_charge — ฟังก์ชันคำนวณภายใน
-- (ไม่ต้อง revoke ซ้ำ เพราะบรรทัดบนสุดตัดไปหมดแล้ว และไม่ได้ grant คืนที่นี่)

-- ตารางที่ Supabase สร้างใหม่ในอนาคตต้องไม่ได้สิทธิ์อัตโนมัติอีก
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- จดว่า patch นี้ติดตั้งแล้ว
insert into schema_patches (name, seq) values ('patch-phase2', 20260930000600)
  on conflict (name) do update set applied_at = now();
