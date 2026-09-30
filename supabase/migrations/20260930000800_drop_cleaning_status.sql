-- ============================================================================
-- เลิกใช้สถานะ "กำลังเก็บ" (cleaning)
--
-- ปัญหา: close_visit กับ move_visit_to_tables ตั้งโต๊ะเป็น 'cleaning' แต่ไม่มี
--        โค้ดไหนตั้งกลับเป็น 'free' เลยสักที่ โต๊ะจึงค้างสถานะนั้นถาวร
--        แล้วเปิดโต๊ะใหม่ไม่ได้อีก เพราะหน้าผังโต๊ะรับเฉพาะโต๊ะที่ว่าง
--
-- ทางแก้ที่ร้านเลือก: ไม่ต้องมีสถานะนี้ — ปิดบิลแล้วโต๊ะกลับมาว่างทันที
--   ร้านเล็กที่พนักงานเก็บโต๊ะเสร็จในไม่กี่นาที การให้กดยืนยันอีกทีคือภาระเปล่า
--
-- ไม่ลบค่าออกจาก enum เพราะ Postgres ลบค่า enum ไม่ได้ตรง ๆ และการมีค่าที่
-- ไม่ถูกใช้ไม่ได้ทำให้เสียหาย แค่ต้องไม่มีใครตั้งมันอีก
-- ============================================================================

-- โต๊ะที่ค้างอยู่จากบั๊กนี้ ปล่อยกลับมาว่าง
update cafe_tables set status = 'free' where status = 'cleaning';

-- ---------------------------------------------------------------------------
-- ย้าย/เพิ่มโต๊ะ — โต๊ะเดิมกลับมาว่างทันที
-- ---------------------------------------------------------------------------
create or replace function move_visit_to_tables(p_visit_id uuid, p_table_ids uuid[])
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

  update cafe_tables set status = 'free' where id = any(v_old);

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

-- ---------------------------------------------------------------------------
-- ปิดบิล — โต๊ะกลับมาว่างทันที รับลูกค้าคิวถัดไปได้เลย
-- ---------------------------------------------------------------------------
create or replace function close_visit(p_visit_id uuid, p_payments jsonb default '[]'::jsonb)
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

  update guest_passes
     set checked_out_at = coalesce(checked_out_at, now()),
         paused_at = null,
         status = 'billed'
   where visit_id = p_visit_id;

  -- โต๊ะกลับมาว่างทันที ไม่ต้องรอใครกดยืนยันว่าเก็บเสร็จ
  update cafe_tables set status = 'free'
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

-- create or replace รักษาสิทธิ์เดิมไว้ แต่ประกาศซ้ำให้ชัด กันกรณีถูกรันบน
-- ฐานข้อมูลที่สิทธิ์เพี้ยน (เทสต์ตรวจสิทธิ์จะจับได้ถ้าหลุด)
revoke all on function
  move_visit_to_tables(uuid, uuid[]),
  close_visit(uuid, jsonb)
from public, anon, authenticated;

grant execute on function move_visit_to_tables(uuid, uuid[]) to authenticated;
grant execute on function close_visit(uuid, jsonb)           to authenticated;
