-- ============================================================================
-- RPC สำหรับทุกการเปลี่ยนแปลงข้อมูล
--
-- client ไม่มีสิทธิ์ INSERT/UPDATE ตรงกับตารางใดเลย (ดู RLS ในไฟล์ถัดไป)
-- ทุกอย่างต้องผ่านฟังก์ชันที่นี่ ซึ่งตรวจสิทธิ์และกติกาธุรกิจเอง
-- ============================================================================

-- ปฏิเสธถ้าไม่ใช่พนักงาน — เรียกเป็นบรรทัดแรกของทุก RPC
create function assert_staff() returns void
language plpgsql stable as $$
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบด้วยบัญชีพนักงาน' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- visit ----

create function open_visit(
  p_table_ids uuid[],
  p_guests    jsonb,          -- [{"name": "...", "ratePlanId": "..."}]
  p_source    visit_source default 'walkin'
) returns visits
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit  visits;
  v_table  cafe_tables;
  v_guest  jsonb;
  v_id     uuid;
begin
  perform assert_staff();

  if jsonb_typeof(p_guests) <> 'array' or jsonb_array_length(p_guests) = 0 then
    raise exception 'ต้องระบุผู้เล่นอย่างน้อย 1 คน' using errcode = '22023';
  end if;

  insert into visits (source) values (p_source) returning * into v_visit;

  foreach v_id in array coalesce(p_table_ids, '{}') loop
    select * into v_table from cafe_tables where id = v_id for update;
    if not found then
      raise exception 'ไม่พบโต๊ะ %', v_id using errcode = 'P0002';
    end if;

    insert into occupancies (visit_id, table_id, exclusive)
    values (v_visit.id, v_table.id, not v_table.allow_share);

    update cafe_tables set status = 'occupied' where id = v_table.id;
  end loop;

  for v_guest in select * from jsonb_array_elements(p_guests) loop
    insert into guest_passes (visit_id, display_name, rate_plan_id)
    values (
      v_visit.id,
      coalesce(nullif(trim(v_guest ->> 'name'), ''), 'ผู้เล่น'),
      (v_guest ->> 'ratePlanId')::uuid
    );
  end loop;

  return v_visit;
end;
$$;

create function add_pass(
  p_visit_id     uuid,
  p_name         text,
  p_rate_plan_id uuid
) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass guest_passes;
begin
  perform assert_staff();

  if not exists (select 1 from visits where id = p_visit_id and status = 'open') then
    raise exception 'visit นี้ไม่ได้เปิดอยู่' using errcode = '22023';
  end if;

  -- นาฬิกาของคนนี้เริ่มนับตอนนี้ ไม่กระทบคนที่มาก่อน
  insert into guest_passes (visit_id, display_name, rate_plan_id)
  values (p_visit_id, coalesce(nullif(trim(p_name), ''), 'ผู้เล่นใหม่'), p_rate_plan_id)
  returning * into v_pass;

  return v_pass;
end;
$$;

create function pause_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  update guest_passes
     set status = 'paused', paused_at = now()
   where id = p_pass_id and status = 'active'
  returning * into v_pass;

  if not found then
    raise exception 'พักได้เฉพาะคนที่กำลังเล่นอยู่' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function resume_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  update guest_passes
     set paused_minutes = paused_minutes
                          + greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int),
         paused_at = null,
         status = 'active'
   where id = p_pass_id and status = 'paused'
  returning * into v_pass;

  if not found then
    raise exception 'คนนี้ไม่ได้อยู่ในสถานะพัก' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function check_out_pass(p_pass_id uuid) returns guest_passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pass guest_passes;
begin
  perform assert_staff();
  -- กลับก่อนขณะกำลังพัก → เก็บนาทีที่ค้างก่อน ไม่งั้นเวลาหาย
  update guest_passes
     set paused_minutes = paused_minutes + case
           when paused_at is not null
           then greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int)
           else 0 end,
         paused_at = null,
         checked_out_at = now(),
         status = 'checked_out'
   where id = p_pass_id and status in ('active', 'paused')
  returning * into v_pass;

  if not found then
    raise exception 'คนนี้เช็คเอาต์ไปแล้ว' using errcode = '22023';
  end if;
  return v_pass;
end;
$$;

create function move_visit_to_tables(p_visit_id uuid, p_table_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table cafe_tables;
  v_id    uuid;
  v_old   uuid[];
begin
  perform assert_staff();

  if coalesce(array_length(p_table_ids, 1), 0) = 0 then
    raise exception 'ต้องเลือกอย่างน้อย 1 โต๊ะ' using errcode = '22023';
  end if;

  -- จำโต๊ะเดิมไว้ก่อนปิด occupancy ไม่งั้นหาย้อนกลับไม่เจอ
  select coalesce(array_agg(table_id), '{}') into v_old
    from occupancies where visit_id = p_visit_id and to_at is null;

  -- ปิด occupancy เดิม แล้วเปิดใหม่ — ประวัติยังอยู่ครบ บิลไม่กระทบ
  update occupancies set to_at = now()
   where visit_id = p_visit_id and to_at is null;

  update cafe_tables set status = 'cleaning' where id = any(v_old);

  foreach v_id in array p_table_ids loop
    select * into v_table from cafe_tables where id = v_id for update;
    if not found then
      raise exception 'ไม่พบโต๊ะ %', v_id using errcode = 'P0002';
    end if;

    insert into occupancies (visit_id, table_id, exclusive)
    values (p_visit_id, v_table.id, not v_table.allow_share);

    update cafe_tables set status = 'occupied' where id = v_table.id;
  end loop;
end;
$$;

-- -------------------------------------------------------------- ออเดอร์ ----

create function place_order(
  p_idempotency_key    text,
  p_visit_id           uuid,
  p_ordered_by_pass_id uuid,
  p_split_mode         split_mode,
  p_placed_by          placed_by_actor,
  p_items              jsonb     -- [{"menuItemId": "...", "qty": 1, "note": "..."}]
) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_item  jsonb;
  v_menu  menu_items;
  v_table uuid;
  v_qty   int;
begin
  perform assert_staff();

  -- retry จากมือถือที่เน็ตหลุด → คืนออเดอร์เดิม ไม่สร้างซ้ำ
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
    -- คนที่กลับไปแล้วสั่งเพิ่มไม่ได้
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

    -- ราคามาจาก DB เสมอ ไม่รับจาก client
    insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty, note)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, nullif(v_item ->> 'note', ''));
  end loop;

  return v_order;
end;
$$;

create function update_order_status(p_order_id uuid, p_status order_status)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_from  order_status;
  v_ok    boolean;
begin
  perform assert_staff();

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

-- ---------------------------------------------------------------- ปิดบิล ----

-- แช่แข็งยอดจาก preview_bill ลงตาราง bills/bill_lines แล้วปิด visit
-- หลังจากนี้ราคาเมนูหรือเรตจะเปลี่ยนยังไงก็ไม่กระทบใบเสร็จนี้อีก
create function close_visit(p_visit_id uuid, p_payments jsonb default '[]'::jsonb)
returns bills
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit   visits;
  v_preview jsonb;
  v_bill    bills;
  v_line    jsonb;
  v_pay     jsonb;
  v_paid    numeric(10,2);
begin
  perform assert_staff();

  select * into v_visit from visits where id = p_visit_id for update;
  if not found then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  v_preview := preview_bill(p_visit_id);

  insert into bills (visit_id, subtotal, service_charge, vat, total, closed_by)
  values (
    p_visit_id,
    (v_preview ->> 'subtotal')::numeric,
    (v_preview ->> 'serviceCharge')::numeric,
    (v_preview ->> 'vat')::numeric,
    (v_preview ->> 'total')::numeric,
    auth.uid()
  ) returning * into v_bill;

  for v_line in select * from jsonb_array_elements(v_preview -> 'lines') loop
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id,
      (v_line ->> 'source')::bill_line_source,
      (v_line ->> 'sourceId')::uuid,
      (v_line ->> 'guestPassId')::uuid,
      v_line ->> 'label',
      (v_line ->> 'qty')::numeric,
      (v_line ->> 'unitPrice')::numeric,
      (v_line ->> 'amount')::numeric
    );
  end loop;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into payments (bill_id, method, amount, paid_for, taken_by)
    values (
      v_bill.id,
      v_pay ->> 'method',
      (v_pay ->> 'amount')::numeric,
      coalesce(
        (select array_agg(value::uuid) from jsonb_array_elements_text(v_pay -> 'paidFor')),
        '{}'
      ),
      auth.uid()
    );
  end loop;

  select coalesce(sum(amount), 0) into v_paid from payments where bill_id = v_bill.id;
  if v_paid >= v_bill.total then
    update bills set status = 'paid' where id = v_bill.id returning * into v_bill;
  end if;

  -- ปิดผู้เล่นที่ยังค้างอยู่
  update guest_passes
     set checked_out_at = coalesce(checked_out_at, now()),
         paused_at = null,
         status = 'billed'
   where visit_id = p_visit_id;

  -- คืนโต๊ะเข้าสถานะรอเก็บ
  update cafe_tables set status = 'cleaning'
   where id in (select table_id from occupancies where visit_id = p_visit_id and to_at is null);

  update occupancies set to_at = now()
   where visit_id = p_visit_id and to_at is null;

  update visits
     set status = case when v_paid >= v_bill.total
                       then 'paid'::visit_status
                       else 'closed'::visit_status end,
         closed_at = now()
   where id = p_visit_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'close_visit', 'visit', p_visit_id,
          jsonb_build_object('billId', v_bill.id, 'total', v_bill.total, 'paid', v_paid));

  return v_bill;
end;
$$;
