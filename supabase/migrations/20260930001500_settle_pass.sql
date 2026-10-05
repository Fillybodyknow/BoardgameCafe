-- ============================================================================
-- จ่ายตอนกลับก่อน
--
-- ปัญหา: ร้านบอร์ดเกมเจอแทบทุกวัน — คนหนึ่งในกลุ่มต้องไปก่อน ขอจ่ายส่วนของ
--        ตัวเองแล้วไป แต่ของเดิมออกบิลได้ทางเดียวคือปิดทั้งโต๊ะ คนที่เหลือ
--        ยังเล่นอยู่ก็ปิดไม่ได้ พนักงานเลยต้องจดใส่กระดาษแล้วไปหักกันทีหลัง
--
-- วิธี: ออกบิลย่อยให้คนนั้นคนเดียว แล้วตีตรา pass เป็น 'billed'
--       (สถานะนี้มีใน enum มาตั้งแต่แรก ตอนนี้ได้ใช้จริง)
--
-- หัวใจคือ "ของที่หารกัน" ต้องไม่ถูกเก็บซ้ำและไม่ตกหล่น:
--   - preview_bill ตัดคนที่จ่ายแล้วออก ทั้งค่าเล่นและของที่สั่งเอง
--   - ส่วนที่หารกันยังแสดงเต็มจำนวน แล้วหักด้วยบรรทัด 'หักส่วนที่ชำระแล้ว'
--     ซึ่งอ่านแล้วตรวจสอบได้ ดีกว่าลดตัวเลขเงียบ ๆ ให้ไล่ไม่ออกว่าหายไปไหน
--   - คนที่เหลือคนสุดท้ายรับเศษไปทั้งหมด ยอดจึงบวกกลับได้เท่าเดิมเสมอ
--
-- ของที่สั่งเพิ่มหลังจากคนหนึ่งจ่ายไปแล้ว จะหารเฉพาะคนที่ยังอยู่ — ถูกต้อง
-- ตามที่ควรเป็น เพราะคนที่กลับไปแล้วไม่ได้กินด้วย
-- ============================================================================

-- ยอด "ของที่หารกัน" ที่ถูกชำระไปแล้วสะสม เก็บที่ visit เพราะเป็นของทั้งโต๊ะ
alter table visits add column if not exists shared_settled numeric(10,2) not null default 0;

-- ---------------------------------------------------------------------------
-- preview_bill — ต่อไปหมายถึง "ยอดที่ยังค้างอยู่" ไม่ใช่ยอดดิบทั้งหมด
--
-- ทุกหน้าจอที่เรียกอันนี้ (ผังโต๊ะ, หน้าปิดบิล, บิลฝั่งลูกค้า) ต้องการตัวเลข
-- เดียวกันคือ "ยังต้องเก็บอีกเท่าไร" จึงนิยามไว้ที่เดียวแทนที่จะให้แต่ละหน้า
-- ไปลบกันเอง
-- ---------------------------------------------------------------------------
create or replace function preview_bill(p_visit_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_lines    jsonb;
  v_subtotal numeric(10,2);
  v_service  numeric(10,2);
  v_vat      numeric(10,2);
  v_base     numeric(10,2);
  v_total    numeric(10,2);
  v_tax      tax_config;
  v_settled  numeric(10,2);
begin
  if not exists (select 1 from visits where id = p_visit_id) then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;

  select * into v_tax from tax_config where id = 1;
  select shared_settled into v_settled from visits where id = p_visit_id;

  with play as (
    select
      'bl-play-' || gp.id  as id,
      'play_time'          as source,
      gp.id                as source_id,
      gp.id                as guest_pass_id,
      'ค่าเล่น · ' || gp.display_name as label,
      1::numeric           as qty,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as unit_price,
      play_time_charge(billable_minutes(gp, p_now), gp.rate_price_per_hour,
                       gp.rate_round_to_minutes, gp.rate_minimum_minutes,
                       gp.rate_day_pass_cap) as amount,
      1                    as grp,
      gp.checked_in_at     as ord
    from guest_passes gp
    where gp.visit_id = p_visit_id
      -- คนที่จ่ายแล้วมีบิลของตัวเองไปแล้ว ไม่ต้องคิดซ้ำ
      and gp.status <> 'billed'
  ), food as (
    select
      'bl-ord-' || ol.id  as id,
      'order_item'        as source,
      ol.id               as source_id,
      case when o.split_mode = 'shared' then null else o.ordered_by_pass_id end as guest_pass_id,
      ol.name_snapshot    as label,
      ol.qty::numeric     as qty,
      ol.unit_price_snapshot as unit_price,
      round(ol.unit_price_snapshot * ol.qty, 2) as amount,
      2                   as grp,
      o.placed_at         as ord
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.visit_id = p_visit_id
      and o.status in ('placed', 'accepted', 'preparing', 'ready', 'served')
      -- ของที่คนจ่ายแล้วสั่งเองก็อยู่ในบิลของเขาแล้ว แต่ของที่หารกันยังอยู่
      and not (
        o.split_mode = 'owner'
        and o.ordered_by_pass_id in (
          select id from guest_passes where visit_id = p_visit_id and status = 'billed'
        )
      )
  ), penalty as (
    select
      'bl-pen-' || gl.id  as id,
      'game_penalty'      as source,
      gl.id               as source_id,
      null::uuid          as guest_pass_id,
      'ค่าปรับ · ' || gt.name as label,
      1::numeric          as qty,
      gl.penalty          as unit_price,
      gl.penalty          as amount,
      3                   as grp,
      gl.out_at           as ord
    from game_loans gl
    join game_titles gt on gt.id = gl.game_title_id
    where gl.visit_id = p_visit_id and gl.penalty > 0
  ), settled as (
    -- บรรทัดติดลบ ให้เห็นกับตาว่าหักอะไรออกไป ไม่ใช่ลดตัวเลขเงียบ ๆ
    select
      'bl-settled-' || p_visit_id as id,
      'adjustment'        as source,
      null::uuid          as source_id,
      null::uuid          as guest_pass_id,
      'หักส่วนที่ชำระแล้ว' as label,
      1::numeric          as qty,
      -v_settled          as unit_price,
      -v_settled          as amount,
      4                   as grp,
      p_now               as ord
    where v_settled > 0
  ), all_lines as (
    select * from play
    union all select * from food
    union all select * from penalty
    union all select * from settled
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id, 'source', source, 'sourceId', source_id,
        'guestPassId', guest_pass_id, 'label', label,
        'qty', qty, 'unitPrice', unit_price, 'amount', amount
      ) order by grp, ord
    ), '[]'::jsonb),
    coalesce(round(sum(amount), 2), 0)
  into v_lines, v_subtotal
  from all_lines;

  v_service := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base    := v_subtotal + v_service;

  if v_tax.vat_included then
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'visitId', p_visit_id, 'lines', v_lines, 'subtotal', v_subtotal,
    'serviceCharge', v_service, 'vat', v_vat, 'total', v_total,
    'computedAt', p_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ยอดที่คนนี้ต้องจ่ายถ้ากลับตอนนี้ — ให้หน้าจอเรียกดูก่อนกดเก็บเงิน
--
-- แยกเป็นฟังก์ชันของตัวเองเพื่อให้หน้าจอกับตอนเก็บเงินจริงใช้สูตรเดียวกัน
-- ไม่ใช่ต่างคนต่างคิดแล้วได้ตัวเลขไม่ตรงกัน
-- ---------------------------------------------------------------------------
create or replace function pass_settlement(p_pass_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_pass      guest_passes;
  v_preview   jsonb;
  v_own       jsonb;
  v_own_total numeric(10,2);
  v_shared    numeric(10,2);
  v_heads     int;
  v_share     numeric(10,2);
  v_subtotal  numeric(10,2);
  v_service   numeric(10,2);
  v_vat       numeric(10,2);
  v_base      numeric(10,2);
  v_total     numeric(10,2);
  v_tax       tax_config;
begin
  select * into v_pass from guest_passes where id = p_pass_id;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว' using errcode = '22023';
  end if;

  select * into v_tax from tax_config where id = 1;
  v_preview := preview_bill(v_pass.visit_id, p_now);

  select
    coalesce(jsonb_agg(l), '[]'::jsonb),
    coalesce(sum((l ->> 'amount')::numeric), 0)
  into v_own, v_own_total
  from jsonb_array_elements(v_preview -> 'lines') l
  where l ->> 'guestPassId' = p_pass_id::text;

  -- บรรทัดที่ไม่มีเจ้าของ = ของที่หารกัน รวมบรรทัดหักส่วนที่ชำระแล้วด้วย
  -- จึงเป็นยอดสุทธิที่ยังไม่มีใครรับผิดชอบ
  select coalesce(sum((l ->> 'amount')::numeric), 0)
    into v_shared
    from jsonb_array_elements(v_preview -> 'lines') l
   where l ->> 'guestPassId' is null;

  select count(*) into v_heads
    from guest_passes
   where visit_id = v_pass.visit_id and status <> 'billed';

  -- คนสุดท้ายรับเศษไปทั้งหมด ยอดรวมของทุกบิลย่อยจึงเท่ากับยอดเต็มเสมอ
  if v_heads <= 1 then
    v_share := v_shared;
  else
    v_share := round(v_shared / v_heads, 2);
  end if;

  v_subtotal := round(v_own_total + v_share, 2);
  v_service  := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base     := v_subtotal + v_service;

  if v_tax.vat_included then
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'passId',        p_pass_id,
    'visitId',       v_pass.visit_id,
    'displayName',   v_pass.display_name,
    'ownLines',      v_own,
    'sharedShare',   v_share,
    'headcount',     v_heads,
    'subtotal',      v_subtotal,
    'serviceCharge', v_service,
    'vat',           v_vat,
    'total',         v_total,
    'computedAt',    p_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- เก็บเงินคนที่กลับก่อน แล้วออกบิลย่อยให้
--
-- ถ้ายังไม่ได้เช็คเอาต์จะเช็คเอาต์ให้ด้วย เพราะในทางปฏิบัติมันคือเรื่อง
-- เดียวกัน — ไม่มีใครจ่ายแล้วนั่งเล่นต่อโดยไม่นับเวลา
-- ---------------------------------------------------------------------------
create or replace function settle_pass(p_pass_id uuid, p_payments jsonb default '[]'::jsonb)
returns bills
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass   guest_passes;
  v_visit  visits;
  v_calc   jsonb;
  v_bill   bills;
  v_line   jsonb;
  v_pay    jsonb;
  v_paid   numeric(10,2);
begin
  perform assert_staff();

  select * into v_pass from guest_passes where id = p_pass_id for update;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว' using errcode = '22023';
  end if;

  -- ล็อก visit ไว้ตลอดการคิดเงิน กันสองเครื่องกดเก็บเงินคนละคนพร้อมกัน
  -- แล้วต่างคนต่างอ่าน shared_settled ค่าเดิม ทำให้หารกันผิด
  select * into v_visit from visits where id = v_pass.visit_id for update;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  if v_pass.status in ('active', 'paused') then
    -- หยุดนาฬิกาก่อนคิดเงิน ไม่งั้นค่าเล่นจะเดินต่อระหว่างนับเงิน
    update guest_passes
       set paused_minutes = paused_minutes + case
             when paused_at is not null
             then greatest(0, floor(extract(epoch from (now() - paused_at)) / 60)::int)
             else 0 end,
           paused_at = null,
           checked_out_at = now(),
           status = 'checked_out'
     where id = p_pass_id
    returning * into v_pass;
  end if;

  v_calc := pass_settlement(p_pass_id);

  insert into bills (visit_id, subtotal, service_charge, vat, total, closed_by)
  values (
    v_pass.visit_id,
    (v_calc ->> 'subtotal')::numeric,
    (v_calc ->> 'serviceCharge')::numeric,
    (v_calc ->> 'vat')::numeric,
    (v_calc ->> 'total')::numeric,
    auth.uid()
  ) returning * into v_bill;

  for v_line in select * from jsonb_array_elements(v_calc -> 'ownLines') loop
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id,
      (v_line ->> 'source')::bill_line_source,
      (v_line ->> 'sourceId')::uuid,
      p_pass_id,
      v_line ->> 'label',
      (v_line ->> 'qty')::numeric,
      (v_line ->> 'unitPrice')::numeric,
      (v_line ->> 'amount')::numeric
    );
  end loop;

  if (v_calc ->> 'sharedShare')::numeric <> 0 then
    insert into bill_lines (bill_id, source, source_id, guest_pass_id, label, qty, unit_price, amount)
    values (
      v_bill.id, 'adjustment', null, p_pass_id,
      'ส่วนแบ่งรายการที่หารกัน (' || (v_calc ->> 'headcount') || ' คน)',
      1,
      (v_calc ->> 'sharedShare')::numeric,
      (v_calc ->> 'sharedShare')::numeric
    );
  end if;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into payments (bill_id, method, amount, paid_for, taken_by)
    values (v_bill.id, v_pay ->> 'method', (v_pay ->> 'amount')::numeric,
            array[p_pass_id], auth.uid());
  end loop;

  select coalesce(sum(amount), 0) into v_paid from payments where bill_id = v_bill.id;
  if v_paid >= v_bill.total then
    update bills set status = 'paid' where id = v_bill.id returning * into v_bill;
  end if;

  -- จดส่วนที่หารกันซึ่งถูกรับผิดชอบไปแล้ว คนที่เหลือจะได้ไม่ต้องจ่ายซ้ำ
  update visits
     set shared_settled = shared_settled + (v_calc ->> 'sharedShare')::numeric
   where id = v_pass.visit_id;

  update guest_passes set status = 'billed' where id = p_pass_id;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'settle_pass', 'guest_pass', p_pass_id,
          jsonb_build_object('billId', v_bill.id, 'total', v_bill.total, 'paid', v_paid));

  return v_bill;
end;
$$;

revoke all on function pass_settlement(uuid, timestamptz) from public, anon, authenticated;
revoke all on function settle_pass(uuid, jsonb)            from public, anon, authenticated;
grant execute on function pass_settlement(uuid, timestamptz) to authenticated;
grant execute on function settle_pass(uuid, jsonb)           to authenticated;
