-- ============================================================================
-- เครื่องคิดเงิน — ต้องให้ผลลัพธ์ตรงกับ src/domain/pricing.ts ทุกกรณี
--
-- ตั้งแต่ไฟล์นี้ถูก apply แล้ว pricing.ts ฝั่ง client เหลือหน้าที่แค่
-- "แสดงตัวเลขระหว่างรอ" เท่านั้น ยอดที่ใช้เก็บเงินจริงมาจากที่นี่
-- ============================================================================

-- อัตราภาษี — แก้ที่เดียว
create table tax_config (
  id                   int primary key default 1 check (id = 1),
  service_charge_rate  numeric(5,4) not null default 0,
  vat_rate             numeric(5,4) not null default 0.07,
  -- true = ราคาที่แสดงรวม VAT แล้ว (ถอดออกมาแสดงในใบเสร็จ)
  vat_included         boolean not null default true
);

insert into tax_config (id) values (1);

-- ---------------------------------------------------------------------------
-- นาทีที่คิดเงินได้ของ pass หนึ่งใบ
-- ตรงกับ billableMinutes() ใน pricing.ts
-- ---------------------------------------------------------------------------
create function billable_minutes(p guest_passes, p_now timestamptz default now())
returns int
language sql stable as $$
  select greatest(0,
    floor(extract(epoch from (coalesce(p.checked_out_at, p_now) - p.checked_in_at)) / 60)::int
    - p.paused_minutes
    -- กำลังพักอยู่ → หักช่วงที่พักมาจนถึงตอนนี้ด้วย
    - case
        when p.paused_at is not null
        then greatest(0, floor(extract(epoch from (p_now - p.paused_at)) / 60)::int)
        else 0
      end
  );
$$;

-- ---------------------------------------------------------------------------
-- ค่าเล่นจากจำนวนนาที
-- ปัดขึ้นตามช่วง → คิดขั้นต่ำ → เทียบเพดานเหมาวัน เลือกที่ถูกกว่าให้ลูกค้า
-- ตรงกับ playTimeCharge() ใน pricing.ts
-- ---------------------------------------------------------------------------
create function play_time_charge(p_minutes int, p_plan rate_plans)
returns numeric
language sql immutable as $$
  with charged as (
    select greatest(p_minutes, p_plan.minimum_minutes) as m
  ), raw as (
    select ceil(m::numeric / p_plan.round_to_minutes)
           * p_plan.round_to_minutes / 60.0
           * p_plan.price_per_hour as amount
    from charged
  )
  select round(
    case
      when p_plan.day_pass_cap is null then amount
      else least(amount, p_plan.day_pass_cap)
    end
  , 2)
  from raw;
$$;

-- ---------------------------------------------------------------------------
-- ยอดเรียลไทม์ของ visit — ไม่ commit อะไร
--
-- คืน jsonb แบบ camelCase ให้ตรงกับ type BillPreview ฝั่ง TypeScript
-- SECURITY DEFINER: อ่านข้ามตารางได้โดยไม่ต้องเปิด RLS ให้ client
-- ---------------------------------------------------------------------------
create function preview_bill(p_visit_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tax     tax_config;
  v_lines   jsonb;
  v_subtotal numeric(10,2);
  v_service numeric(10,2);
  v_base    numeric(10,2);
  v_vat     numeric(10,2);
  v_total   numeric(10,2);
begin
  if not exists (select 1 from visits where id = p_visit_id) then
    raise exception 'ไม่พบ visit %', p_visit_id using errcode = 'P0002';
  end if;

  select * into v_tax from tax_config where id = 1;

  with play as (
    -- 1) ค่าเล่นรายคน
    select
      'bl-play-' || gp.id                          as id,
      'play_time'                                  as source,
      gp.id                                        as source_id,
      gp.id                                        as guest_pass_id,
      'ค่าเล่น · ' || gp.display_name               as label,
      1::numeric                                   as qty,
      play_time_charge(billable_minutes(gp, p_now), rp) as unit_price,
      play_time_charge(billable_minutes(gp, p_now), rp) as amount,
      1                                            as grp,
      gp.checked_in_at                             as ord
    from guest_passes gp
    join rate_plans rp on rp.id = gp.rate_plan_id
    where gp.visit_id = p_visit_id
  ), food as (
    -- 2) อาหาร/เครื่องดื่ม ใช้ราคา snapshot ตอนสั่ง
    --    ออเดอร์ที่ rejected/cancelled ไม่นับ
    select
      'bl-ord-' || ol.id                           as id,
      'order_item'                                 as source,
      ol.id                                        as source_id,
      case when o.split_mode = 'shared' then null else o.ordered_by_pass_id end as guest_pass_id,
      ol.name_snapshot                             as label,
      ol.qty::numeric                              as qty,
      ol.unit_price_snapshot                       as unit_price,
      round(ol.unit_price_snapshot * ol.qty, 2)    as amount,
      2                                            as grp,
      o.placed_at                                  as ord
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.visit_id = p_visit_id
      and o.status in ('placed', 'accepted', 'preparing', 'ready', 'served')
  ), penalty as (
    -- 3) ค่าปรับชิ้นส่วนเกมหาย
    select
      'bl-pen-' || gl.id                           as id,
      'game_penalty'                               as source,
      gl.id                                        as source_id,
      null::uuid                                   as guest_pass_id,
      'ค่าปรับ · ' || gt.name                       as label,
      1::numeric                                   as qty,
      gl.penalty                                   as unit_price,
      gl.penalty                                   as amount,
      3                                            as grp,
      gl.out_at                                    as ord
    from game_loans gl
    join game_titles gt on gt.id = gl.game_title_id
    where gl.visit_id = p_visit_id and gl.penalty > 0
  ), all_lines as (
    select * from play
    union all select * from food
    union all select * from penalty
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'source', source,
        'sourceId', source_id,
        'guestPassId', guest_pass_id,
        'label', label,
        'qty', qty,
        'unitPrice', unit_price,
        'amount', amount
      ) order by grp, ord
    ), '[]'::jsonb),
    coalesce(round(sum(amount), 2), 0)
  into v_lines, v_subtotal
  from all_lines;

  v_service := round(v_subtotal * v_tax.service_charge_rate, 2);
  v_base    := v_subtotal + v_service;

  if v_tax.vat_included then
    -- ราคารวม VAT แล้ว → ถอดออกมาแสดง ยอดสุทธิไม่เปลี่ยน
    v_vat   := round(v_base - v_base / (1 + v_tax.vat_rate), 2);
    v_total := v_base;
  else
    v_vat   := round(v_base * v_tax.vat_rate, 2);
    v_total := v_base + v_vat;
  end if;

  return jsonb_build_object(
    'visitId',        p_visit_id,
    'lines',          v_lines,
    'subtotal',       v_subtotal,
    'serviceCharge',  v_service,
    'vat',            v_vat,
    'total',          v_total,
    'computedAt',     p_now
  );
end;
$$;
