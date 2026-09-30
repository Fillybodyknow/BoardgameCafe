-- ============================================================================
-- ยอดจาก SQL ต้องตรงกับ src/domain/pricing.test.ts ทุกเคส
-- ใช้เวลาอ้างอิงตายตัว 2026-09-30T18:00:00Z เหมือนฝั่ง TypeScript
-- ============================================================================

\set NOW '2026-09-30T18:00:00Z'

do $$
declare
  v_now    constant timestamptz := '2026-09-30T18:00:00Z';
  v_std    rate_plans;
  v_nocap  rate_plans;
  v_visit  visits;
  v_p1     guest_passes;
  v_p2     guest_passes;
  v_menu1  uuid;
  v_menu2  uuid;
  v_menu3  uuid;
  v_order  orders;
  v_bill   jsonb;
  v_lines  jsonb;
begin
  -- ------------------------------------------------------------ setup ----
  insert into rate_plans (name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap)
  values ('ทั่วไป', 60, 30, 60, 199) returning * into v_std;

  insert into rate_plans (name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap)
  values ('ไม่มีเพดาน', 60, 30, 60, null) returning * into v_nocap;

  insert into visits (source) values ('walkin') returning * into v_visit;

  -- --------------------------------------------------- billable_minutes ----

  insert into guest_passes (visit_id, display_name, rate_plan_id, checked_in_at)
  values (v_visit.id, 'A', v_std.id, v_now - interval '95 minutes') returning * into v_p1;
  perform assert_eq('อยู่ 95 นาที', billable_minutes(v_p1, v_now), 95);

  update guest_passes set paused_minutes = 12 where id = v_p1.id returning * into v_p1;
  perform assert_eq('หักเวลาพัก 12 นาที', billable_minutes(v_p1, v_now), 83);

  update guest_passes
     set paused_minutes = 0, status = 'paused', paused_at = v_now - interval '9 minutes'
   where id = v_p1.id returning * into v_p1;
  perform assert_eq('กำลังพักอยู่ 9 นาที หยุดนับ', billable_minutes(v_p1, v_now), 86);

  update guest_passes
     set status = 'checked_out', paused_at = null,
         checked_in_at = v_now - interval '120 minutes',
         checked_out_at = v_now - interval '30 minutes'
   where id = v_p1.id returning * into v_p1;
  perform assert_eq('กลับไปแล้ว นับถึงเวลาที่ออก', billable_minutes(v_p1, v_now), 90);

  -- -------------------------------------------------- play_time_charge ----

  perform assert_eq('10 นาที คิดขั้นต่ำ 1 ชม.',  play_time_charge(10,  v_std),   60::numeric);
  perform assert_eq('61 นาที ปัดเป็น 90 นาที',   play_time_charge(61,  v_std),   90::numeric);
  perform assert_eq('90 นาที พอดี',             play_time_charge(90,  v_std),   90::numeric);
  perform assert_eq('เกินเพดานเหมาวัน',          play_time_charge(600, v_std),  199::numeric);
  perform assert_eq('ไม่มีเพดาน คิดตามจริง',      play_time_charge(600, v_nocap), 600::numeric);

  -- -------------------------------------------------------- preview_bill ----

  -- ล้างของเดิม แล้วสร้างสถานการณ์เดียวกับ pricing.test.ts
  delete from guest_passes where visit_id = v_visit.id;

  insert into guest_passes (visit_id, display_name, rate_plan_id, checked_in_at)
  values (v_visit.id, 'A', v_std.id, v_now - interval '60 minutes') returning * into v_p1;
  insert into guest_passes (visit_id, display_name, rate_plan_id, checked_in_at)
  values (v_visit.id, 'B', v_std.id, v_now - interval '60 minutes') returning * into v_p2;

  insert into menu_items (sku, name, category, price) values ('T01', 'กาแฟ', 'drink', 65)
    returning id into v_menu1;
  insert into menu_items (sku, name, category, price) values ('T02', 'เฟรนช์ฟรายส์', 'snack', 89)
    returning id into v_menu2;
  insert into menu_items (sku, name, category, price) values ('T03', 'ที่ยกเลิก', 'snack', 999)
    returning id into v_menu3;

  -- A สั่งเอง
  insert into orders (visit_id, ordered_by_pass_id, split_mode, status)
  values (v_visit.id, v_p1.id, 'owner', 'served') returning * into v_order;
  insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty)
  values (v_order.id, v_menu1, 'กาแฟ', 65, 1);

  -- แชร์ทั้งโต๊ะ
  insert into orders (visit_id, split_mode, status)
  values (v_visit.id, 'shared', 'preparing') returning * into v_order;
  insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty)
  values (v_order.id, v_menu2, 'เฟรนช์ฟรายส์', 89, 1);

  -- ยกเลิกไปแล้ว ต้องไม่ถูกนับ
  insert into orders (visit_id, ordered_by_pass_id, split_mode, status)
  values (v_visit.id, v_p2.id, 'owner', 'cancelled') returning * into v_order;
  insert into order_lines (order_id, menu_item_id, name_snapshot, unit_price_snapshot, qty)
  values (v_order.id, v_menu3, 'ที่ยกเลิก', 999, 1);

  v_bill  := preview_bill(v_visit.id, v_now);
  v_lines := v_bill -> 'lines';

  perform assert_eq('subtotal 60+60+65+89 ไม่รวมที่ยกเลิก',
                    (v_bill ->> 'subtotal')::numeric, 274::numeric);
  perform assert_eq('VAT ถอดจากราคาที่รวมแล้ว',
                    (v_bill ->> 'vat')::numeric, 17.93::numeric);
  perform assert_eq('ยอดสุทธิไม่เปลี่ยนเพราะ VAT รวมอยู่แล้ว',
                    (v_bill ->> 'total')::numeric, 274::numeric);
  perform assert_eq('จำนวนบรรทัดในบิล', jsonb_array_length(v_lines), 4);

  perform assert_eq(
    'ของแชร์ไม่ผูกกับใครคนใดคนหนึ่ง',
    (select count(*) from jsonb_array_elements(v_lines) l
      where l ->> 'guestPassId' is null and (l ->> 'amount')::numeric = 89),
    1::bigint
  );

  perform assert_eq(
    'ค่าเล่นของ A ผูกกับ pass ของ A',
    (select (l ->> 'amount')::numeric from jsonb_array_elements(v_lines) l
      where l ->> 'source' = 'play_time' and (l ->> 'guestPassId')::uuid = v_p1.id),
    60::numeric
  );

  perform assert_eq(
    'ออเดอร์ที่ยกเลิกไม่โผล่ในบิล',
    (select count(*) from jsonb_array_elements(v_lines) l where l ->> 'label' = 'ที่ยกเลิก'),
    0::bigint
  );

  raise notice '--- ตรรกะคิดเงินฝั่ง SQL ผ่านทั้งหมด ---';
end;
$$;
