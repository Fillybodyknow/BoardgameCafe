-- ============================================================================
-- QR ต่อรอบ แทน QR ติดโต๊ะ
--
-- เดิม token ผูกกับโต๊ะ แล้วพิมพ์ติดโต๊ะไว้ถาวร ซึ่งมีปัญหาสามข้อ
--   1. ลูกค้าถ่ายรูป QR กลับบ้านได้ พอโต๊ะนั้นมีคนใหม่นั่ง ก็ลงชื่อเพิ่มคน
--      (guest_register) หรือสั่งของเข้าบิลของคนอื่นจากนอกร้านได้
--   2. โต๊ะที่นั่งร่วมได้ (โต๊ะยาว/เคาน์เตอร์) มีหลายกลุ่มพร้อมกัน แต่ token
--      ชี้ได้แค่ visit ล่าสุด กลุ่มที่มาก่อนจึงสั่งของเข้าบิลกลุ่มที่มาทีหลัง
--   3. ย้ายโต๊ะแล้ว QR ที่ลูกค้าถืออยู่ชี้ไปโต๊ะเดิม ไม่ใช่กลุ่มเดิม
--
-- ย้าย token มาไว้ที่ visit แทน: เปิดโต๊ะหนึ่งครั้ง = QR ใหม่หนึ่งใบ
-- พนักงานพิมพ์ใบเสร็จความร้อนให้ลูกค้าตอนเปิดโต๊ะ QR ตามกลุ่มไปทุกโต๊ะที่ย้าย
-- และตายทันทีที่ปิดบิล
--
-- cafe_tables.qr_token ยังเก็บไว้ เพื่อให้สติกเกอร์เก่าที่ยังติดโต๊ะอยู่
-- บอกลูกค้าได้ว่า "ขอ QR จากพนักงาน" แทนที่จะขึ้นว่าใช้ไม่ได้เฉย ๆ
-- แต่สั่งของหรือลงชื่อผ่านสติกเกอร์เก่าไม่ได้อีกแล้ว
-- ============================================================================

alter table visits add column if not exists qr_token uuid not null default gen_random_uuid();
create unique index if not exists visits_qr_token_idx on visits (qr_token);

-- ---------------------------------------------------------------------------
-- token → visit ที่ยังเปิดอยู่ (null ถ้าปิดบิลแล้วหรือไม่ใช่ token ของรอบไหนเลย)
--
-- ทุก RPC ฝั่งลูกค้า (guest_orders / guest_bill / guest_place_order /
-- guest_register) ผ่านฟังก์ชันนี้ แก้ที่นี่ที่เดียวจึงเปลี่ยนทั้งระบบ
-- ---------------------------------------------------------------------------
create or replace function visit_for_token(p_token uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from visits where qr_token = p_token and status = 'open';
$$;

-- ---------------------------------------------------------------------------
-- ข้อมูลที่ลูกค้าเห็นหลังสแกน QR
--
-- visitId = null + ended = true   → รอบนี้ปิดบิลไปแล้ว
-- visitId = null + ended = false  → สติกเกอร์ QR ติดโต๊ะแบบเก่า
-- ---------------------------------------------------------------------------
create or replace function guest_session(p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_visit visits;
  v_table cafe_tables;
  v_codes text;
  v_zone  text;
begin
  select * into v_visit from visits where qr_token = p_token;

  if not found then
    select * into v_table from cafe_tables where qr_token = p_token and not archived;
    if not found then
      raise exception 'QR นี้ใช้ไม่ได้' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'tableCode', v_table.code,
      'zone',      v_table.zone,
      'visitId',   null,
      'ended',     false,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  -- รวมโต๊ะหลายตัวเป็น "B1+B2" ถ้ากลุ่มใหญ่ต่อโต๊ะ
  -- ปิดบิลแล้วไม่มีโต๊ะที่ครองอยู่ ใช้โต๊ะสุดท้ายที่นั่งแทน
  select string_agg(t.code, '+' order by t.sort_order, t.code), min(t.zone)
    into v_codes, v_zone
    from occupancies o join cafe_tables t on t.id = o.table_id
   where o.visit_id = v_visit.id and o.to_at is null;

  if v_codes is null then
    select t.code, t.zone into v_codes, v_zone
      from occupancies o join cafe_tables t on t.id = o.table_id
     where o.visit_id = v_visit.id
     order by o.from_at desc
     limit 1;
  end if;

  if v_visit.status <> 'open' then
    return jsonb_build_object(
      'tableCode', coalesce(v_codes, '—'),
      'zone',      coalesce(v_zone, ''),
      'visitId',   null,
      'ended',     true,
      'kitchen',   kitchen_window(),
      'passes',    '[]'::jsonb,
      'menu',      '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'tableCode', coalesce(v_codes, '—'),
    'zone',      coalesce(v_zone, ''),
    'visitId',   v_visit.id,
    'ended',     false,
    'kitchen',   kitchen_window(),
    'passes', coalesce((
      select jsonb_agg(jsonb_build_object('id', gp.id, 'displayName', gp.display_name)
                       order by gp.checked_in_at)
        from guest_passes gp
       where gp.visit_id = v_visit.id
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
-- ออก QR ใหม่ให้รอบที่ยังเปิดอยู่ — ใช้เมื่อลูกค้าทำใบหาย หรือสงสัยว่าหลุดออกไป
-- ใบเดิมใช้ไม่ได้ทันที
-- ---------------------------------------------------------------------------
create or replace function rotate_visit_token(p_visit_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid;
begin
  perform assert_staff();

  update visits set qr_token = gen_random_uuid()
   where id = p_visit_id and status = 'open'
  returning qr_token into v_token;

  if not found then
    raise exception 'ไม่พบรอบที่ยังเปิดอยู่' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, entity, entity_id)
  values (auth.uid(), 'rotate_visit_token', 'visit', p_visit_id);

  return v_token;
end;
$$;

-- QR ติดโต๊ะเลิกใช้แล้ว เปลี่ยน token ของโต๊ะไปก็ไม่มีผลอะไร
drop function if exists rotate_table_token(uuid);

revoke all on function rotate_visit_token(uuid) from public, anon, authenticated;
grant execute on function rotate_visit_token(uuid) to authenticated;
