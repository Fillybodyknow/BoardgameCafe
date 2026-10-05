-- ============================================================================
-- เวลาปิดครัว
--
-- ร้านส่วนใหญ่ปิดครัวก่อนปิดร้าน (ที่เจอบ่อยคือสี่ทุ่ม) แต่บาร์ยังเสิร์ฟต่อ
-- ของเดิมมีแต่เวลาเปิด-ปิดร้าน ซึ่งใช้กับการจองออนไลน์อย่างเดียว
--
-- กติกาที่ตกลงกันไว้:
--   - ปิดครัวแล้ว สั่งได้เฉพาะเครื่องดื่มกับของกินเล่น (หมวด food/dessert ตัดออก)
--   - ตั้งแยกรายวัน เสาร์-อาทิตย์ปิดดึกกว่าได้
--   - ลูกค้าสแกน QR สั่งไม่ได้เลย ส่วนพนักงานสั่งแทนได้ถ้ายืนยัน เพราะบางที
--     ครัวยังอยู่หรือรับปากลูกค้าไว้แล้ว — ระบบไม่ควรขวางคนที่รู้หน้างานดีกว่า
--
-- ไม่รองรับร้านที่ปิดหลังเที่ยงคืน เหมือนกับเวลาร้าน (ดู upsert_shop_hours)
-- ============================================================================

-- null = ครัวปิดพร้อมร้าน ซึ่งเป็นพฤติกรรมเดิมก่อนมีฟีเจอร์นี้
alter table shop_hours add column if not exists kitchen_close_time time;

-- ---------------------------------------------------------------------------
-- ตอนนี้ครัวเปิดอยู่ไหม
--
-- คิดตามเวลาไทย ไม่ใช่ UTC และอ้างแถวของวันตามเวลาไทยเช่นกัน
-- ตีครึ่งคืนวันเสาร์จะไปเทียบกับเวลาเปิดของวันเสาร์ (11:00) จึงนับว่าปิด
-- ซึ่งถูกต้องสำหรับร้านที่ไม่ได้เปิดข้ามวัน
-- ---------------------------------------------------------------------------
create or replace function kitchen_window(p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_local timestamp;
  v_hours shop_hours;
  v_close time;
begin
  v_local := p_now at time zone 'Asia/Bangkok';
  select * into v_hours from shop_hours where weekday = extract(dow from v_local)::smallint;

  if not found or v_hours.closed then
    return jsonb_build_object('open', false, 'closeAt', null, 'reason', 'วันนี้ร้านปิด');
  end if;

  v_close := coalesce(v_hours.kitchen_close_time, v_hours.close_time);

  if v_local::time < v_hours.open_time then
    return jsonb_build_object(
      'open', false,
      'closeAt', to_char(v_close, 'HH24:MI'),
      'reason', 'ร้านเปิด ' || to_char(v_hours.open_time, 'HH24:MI') || ' น.');
  end if;

  if v_local::time >= v_close then
    return jsonb_build_object(
      'open', false,
      'closeAt', to_char(v_close, 'HH24:MI'),
      'reason', 'ครัวปิดแล้ว (' || to_char(v_close, 'HH24:MI') || ' น.)');
  end if;

  return jsonb_build_object('open', true, 'closeAt', to_char(v_close, 'HH24:MI'), 'reason', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- ของชิ้นไหนต้องใช้ครัว
--
-- ยึดตามหมวดเพื่อไม่ให้เจ้าของร้านต้องมาติ๊กทีละเมนู ถ้าวันหนึ่งมีของที่
-- คาบเกี่ยว ค่อยเพิ่มสวิตช์รายเมนูทีหลัง — ตรงนี้คือจุดเดียวที่ต้องแก้
-- ---------------------------------------------------------------------------
create or replace function needs_kitchen(p_items jsonb)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it
      join menu_items m on m.id = (it ->> 'menuItemId')::uuid
     where m.category in ('food', 'dessert')
  );
$$;

-- ---------------------------------------------------------------------------
-- ลูกค้าสแกน QR — ปิดครัวแล้วสั่งของที่ต้องเข้าครัวไม่ได้
-- ---------------------------------------------------------------------------
create or replace function guest_place_order(
  p_token              uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_items              jsonb,
  p_idempotency_key    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit  uuid;
  v_order  orders;
  v_window jsonb;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_window := kitchen_window();
  if not (v_window ->> 'open')::boolean and needs_kitchen(p_items) then
    raise exception '% สั่งได้เฉพาะเครื่องดื่มและของกินเล่น', v_window ->> 'reason'
      using errcode = '22023';
  end if;

  v_order := place_order_core(
    p_idempotency_key, v_visit, p_ordered_by_pass_id,
    p_split_mode, 'guest', p_items
  );

  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- พนักงาน — สั่งแทนได้ แต่ต้องตั้งใจ ไม่ใช่เผลอ
--
-- ค่าเริ่มต้นของพารามิเตอร์ใหม่คือ false เพื่อให้โค้ดเดิมที่ยังไม่ได้อัปเดต
-- ยังถูกกันไว้ ไม่ใช่ปล่อยผ่านเงียบ ๆ
-- ---------------------------------------------------------------------------
create or replace function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb,
  p_allow_closed_kitchen boolean default false
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_window jsonb;
begin
  perform assert_staff();

  if not p_allow_closed_kitchen then
    v_window := kitchen_window();
    if not (v_window ->> 'open')::boolean and needs_kitchen(p_items) then
      raise exception '% ยืนยันอีกครั้งถ้าครัวยังทำให้ได้', v_window ->> 'reason'
        using errcode = '22023';
    end if;
  end if;

  return place_order_core(
    p_idempotency_key, p_visit_id, p_ordered_by_pass_id,
    p_split_mode, p_placed_by, p_items
  );
end;
$$;

-- ของเดิมที่ไม่มีพารามิเตอร์ท้าย ต้องหายไป ไม่งั้นจะเหลือทางเรียกที่ข้ามด่าน
drop function if exists place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb);

-- ---------------------------------------------------------------------------
-- ลูกค้าที่สแกน QR ต้องรู้ตั้งแต่เปิดเมนู ไม่ใช่กดสั่งแล้วค่อยโดนปฏิเสธ
-- ---------------------------------------------------------------------------
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
    'kitchen',   kitchen_window(),
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
               'category', m.category, 'price', m.price,
               'available', m.available, 'imagePath', m.image_path)
             order by m.sort_order)
        from menu_items m
       where not m.archived
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- หน้าตั้งค่าของเจ้าของร้าน
-- ---------------------------------------------------------------------------
drop function if exists upsert_shop_hours(smallint, time, time, boolean);

create or replace function upsert_shop_hours(
  p_weekday       smallint,
  p_open          time,
  p_close         time,
  p_closed        boolean,
  p_kitchen_close time default null
) returns shop_hours
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row shop_hours;
begin
  perform assert_manager();

  if p_weekday < 0 or p_weekday > 6 then
    raise exception 'วันไม่ถูกต้อง' using errcode = '22023';
  end if;
  -- ร้านที่ปิดหลังเที่ยงคืนยังไม่รองรับ เพราะ assert_bookable ห้ามการจองข้ามวัน
  if not p_closed and p_close <= p_open then
    raise exception 'เวลาปิดต้องหลังเวลาเปิด (ยังไม่รองรับร้านที่ปิดข้ามวัน)'
      using errcode = '22023';
  end if;
  -- ครัวปิดหลังร้านไม่มีความหมาย และปิดก่อนร้านเปิดก็เท่ากับไม่เปิดครัวทั้งวัน
  if not p_closed and p_kitchen_close is not null
     and (p_kitchen_close > p_close or p_kitchen_close <= p_open) then
    raise exception 'เวลาปิดครัวต้องอยู่ระหว่าง % ถึง % น.',
      to_char(p_open, 'HH24:MI'), to_char(p_close, 'HH24:MI') using errcode = '22023';
  end if;

  insert into shop_hours (weekday, open_time, close_time, closed, kitchen_close_time)
  values (p_weekday, p_open, p_close, p_closed, p_kitchen_close)
  on conflict (weekday) do update
    set open_time = excluded.open_time,
        close_time = excluded.close_time,
        closed = excluded.closed,
        kitchen_close_time = excluded.kitchen_close_time
  returning * into v_row;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'upsert_shop_hours', 'shop_hours', null,
          jsonb_build_object('weekday', p_weekday, 'open', p_open, 'close', p_close,
                             'closed', p_closed, 'kitchenClose', p_kitchen_close));
  return v_row;
end;
$$;

revoke all on function kitchen_window(timestamptz) from public, anon, authenticated;
revoke all on function needs_kitchen(jsonb)        from public, anon, authenticated;
revoke all on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function upsert_shop_hours(smallint, time, time, boolean, time)
  from public, anon, authenticated;

-- ลูกค้าไม่ต้องเรียกตรง ๆ เพราะ guest_session ส่งสถานะครัวไปให้อยู่แล้ว
-- ยิ่งเปิดน้อยยิ่งดี
grant execute on function kitchen_window(timestamptz) to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb, boolean)
  to authenticated;
grant execute on function upsert_shop_hours(smallint, time, time, boolean, time) to authenticated;
