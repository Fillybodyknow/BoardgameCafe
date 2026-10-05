-- ============================================================================
-- ลูกค้าลงชื่อตัวเองผ่าน QR
--
-- ของเดิมพนักงานต้องพิมพ์ชื่อทุกคนตอนเปิดโต๊ะ ซึ่งช้าและชื่อมักเพี้ยน
-- ให้แต่ละคนสแกน QR แล้วลงชื่อเองครั้งเดียว เครื่องจะจำไว้ ตอนสั่งของจึง
-- ไม่ต้องเลือกว่าใครสั่งอีก
--
-- สิ่งที่แลกมาคือ "ใครสแกน QR ได้ ก็สร้างคนที่ต้องจ่ายค่าเล่นได้" จึงต้องมี
--   - เพดานจำนวนคนต่อโต๊ะ กันกดรัวจนเป็นร้อย
--   - ทางให้พนักงานลบคนที่ถูกสร้างผิดออก (void_pass) ซึ่งเดิมไม่มีเลย
--     check_out_pass แค่หยุดเวลาแต่ยังคิดเงิน ใช้แก้เคสนี้ไม่ได้
--
-- เรทค่าเล่นให้เรทมาตรฐานไปก่อน พนักงานเห็นรายชื่อแล้วค่อยปรับเป็น
-- นักเรียน/สมาชิกทีหลัง — ลูกค้าเลือกเรทเองไม่ได้ เพราะกดเลือกเรทถูกสุด
-- ย่อมเป็นเรื่องปกติ
-- ============================================================================

-- จำนวนคนต่อหนึ่งโต๊ะที่ยอมให้ลงชื่อเองได้ กันการกดรัว
-- ไม่ได้กันคนตั้งใจป่วน แค่จำกัดความเสียหายให้พนักงานตามแก้ไหว
create or replace function guest_register_limit() returns int
language sql immutable as $$ select 20 $$;

-- ---------------------------------------------------------------------------
-- ลูกค้าลงชื่อตัวเอง
--
-- คืน passId ให้เครื่องเก็บไว้ ครั้งต่อไปจะได้ไม่ต้องลงชื่อซ้ำ
-- ลงชื่อซ้ำด้วยชื่อเดิมในโต๊ะเดิมคืนใบเดิม ไม่สร้างซ้ำ — กันกดสองที
-- ---------------------------------------------------------------------------
create or replace function guest_register(p_token uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_visit uuid;
  v_name  text;
  v_plan  uuid;
  v_pass  guest_passes;
begin
  v_visit := visit_for_token(p_token);
  if v_visit is null then
    raise exception 'โต๊ะนี้ยังไม่ได้เปิด กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  v_name := nullif(trim(p_name), '');
  if v_name is null then
    raise exception 'กรุณาใส่ชื่อ' using errcode = '22023';
  end if;
  if length(v_name) > 40 then
    raise exception 'ชื่อยาวเกินไป' using errcode = '22023';
  end if;

  -- ชื่อเดิมในโต๊ะเดิมที่ยังนั่งอยู่ = คนเดิม ไม่ใช่คนใหม่
  select * into v_pass
    from guest_passes
   where visit_id = v_visit
     and lower(display_name) = lower(v_name)
     and status in ('active', 'paused')
   limit 1;
  if found then
    return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
  end if;

  if (select count(*) from guest_passes where visit_id = v_visit) >= guest_register_limit() then
    raise exception 'โต๊ะนี้มีคนครบแล้ว กรุณาแจ้งพนักงาน' using errcode = '22023';
  end if;

  -- เรทมาตรฐาน = เรทที่เปิดใช้อยู่ตัวแรกตามลำดับที่เจ้าของร้านจัดไว้
  select id into v_plan from rate_plans where active order by sort_order, name limit 1;
  if v_plan is null then
    raise exception 'ร้านยังไม่ได้ตั้งเรทค่าเล่น' using errcode = '22023';
  end if;

  insert into guest_passes (visit_id, display_name, rate_plan_id)
  values (v_visit, v_name, v_plan)
  returning * into v_pass;

  return jsonb_build_object('passId', v_pass.id, 'displayName', v_pass.display_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- ลบคนที่ถูกสร้างผิดออก — พนักงานเท่านั้น
--
-- ต่างจาก check_out_pass ตรงที่อันนั้นแปลว่า "กลับไปแล้ว" ซึ่งยังต้องจ่าย
-- ส่วนอันนี้แปลว่า "ไม่เคยมีคนนี้" จึงลบทิ้งได้จริง
--
-- ลบได้เฉพาะใบที่ยังไม่ผูกกับเงิน ถ้าสั่งของไปแล้วหรือจ่ายไปแล้ว ต้องแก้
-- ด้วยวิธีอื่น ไม่ใช่ลบให้หลักฐานหาย
-- ---------------------------------------------------------------------------
create or replace function void_pass(p_pass_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pass  guest_passes;
  v_visit visits;
begin
  perform assert_staff();

  select * into v_pass from guest_passes where id = p_pass_id;
  if not found then
    raise exception 'ไม่พบผู้เล่นคนนี้' using errcode = 'P0002';
  end if;
  if v_pass.status = 'billed' then
    raise exception 'คนนี้ชำระเงินไปแล้ว ลบไม่ได้' using errcode = '22023';
  end if;

  select * into v_visit from visits where id = v_pass.visit_id;
  if v_visit.status <> 'open' then
    raise exception 'visit นี้ปิดไปแล้ว' using errcode = '22023';
  end if;

  if exists (select 1 from orders where ordered_by_pass_id = p_pass_id) then
    raise exception 'คนนี้สั่งของไปแล้ว ลบไม่ได้ — ใช้ "กลับก่อน" แทน'
      using errcode = '22023';
  end if;

  if (select count(*) from guest_passes where visit_id = v_pass.visit_id) <= 1 then
    raise exception 'โต๊ะต้องมีอย่างน้อย 1 คน' using errcode = '22023';
  end if;

  insert into audit_log (actor, action, entity, entity_id, detail)
  values (auth.uid(), 'void_pass', 'guest_pass', p_pass_id, to_jsonb(v_pass));

  delete from guest_passes where id = p_pass_id;
end;
$$;

revoke all on function guest_register(uuid, text) from public, anon, authenticated;
revoke all on function void_pass(uuid)            from public, anon, authenticated;
revoke all on function guest_register_limit()     from public, anon, authenticated;

grant execute on function guest_register(uuid, text) to anon, authenticated;
grant execute on function void_pass(uuid)            to authenticated;
