-- ============================================================================
-- ข้อความในแจ้งเตือน
--
-- ของเดิมส่ง push เปล่า ๆ แล้วให้ service worker เขียนข้อความตายตัวว่า
-- "มีออเดอร์ใหม่เข้าครัว" เพราะ push ที่มีเนื้อหาต้องเข้ารหัส aes128gcm
-- ตอนนี้ทำการเข้ารหัสแล้ว (ดู functions/notify-kitchen/webpush.ts) จึงส่ง
-- รายละเอียดไปได้
--
-- ให้ฐานข้อมูลเป็นคนประกอบข้อความ ไม่ใช่ Edge Function เพราะข้อมูลอยู่ที่นี่
-- และจะได้ไม่ต้อง deploy ฟังก์ชันใหม่ทุกครั้งที่อยากแก้ถ้อยคำ
-- ============================================================================

-- ต้องคืนกุญแจของอุปกรณ์มาด้วย เพราะการเข้ารหัสผูกกับเครื่องปลายทางรายเครื่อง
-- ของเดิมคืนแค่ endpoint ซึ่งพอสำหรับ push เปล่า ๆ แต่ไม่พอสำหรับส่งข้อความ
drop function if exists kitchen_push_endpoints();

create function kitchen_push_endpoints()
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct ps.id, ps.endpoint, ps.p256dh, ps.auth
    from push_subscriptions ps
    join staff s on s.user_id = ps.user_id and s.active
    join role_capabilities rc on rc.role = s.role and rc.capability = 'kitchen';
$$;

revoke all on function kitchen_push_endpoints() from public, anon, authenticated;

create or replace function order_push_summary(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_order  orders;
  v_table  text;
  v_items  text;
  v_count  int;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then
    return jsonb_build_object('title', 'มีออเดอร์ใหม่เข้าครัว', 'body', 'แตะเพื่อเปิดจอครัว');
  end if;

  -- ใช้โต๊ะปัจจุบัน ไม่ใช่โต๊ะตอนสั่ง ลูกค้าอาจย้ายโต๊ะไปแล้ว
  select t.code into v_table
    from occupancies o
    join cafe_tables t on t.id = o.table_id
   where o.visit_id = v_order.visit_id and o.to_at is null
   order by o.from_at
   limit 1;

  -- จำกัดไว้ 4 รายการแรก กันข้อความยาวจนถูกตัดบนหน้าจอล็อก
  select string_agg(line, ', ' order by ord), max(total)
    into v_items, v_count
    from (
      select ol.name_snapshot || ' ×' || ol.qty as line,
             row_number() over (order by ol.id) as ord,
             count(*) over () as total
        from order_lines ol
       where ol.order_id = p_order_id
    ) x
   where ord <= 4;

  return jsonb_build_object(
    'title', 'ออเดอร์ใหม่ · โต๊ะ ' || coalesce(v_table, '—'),
    'body', coalesce(v_items, 'แตะเพื่อเปิดจอครัว')
            || case when v_count > 4 then ' และอีก ' || (v_count - 4) || ' รายการ' else '' end,
    'orderId', p_order_id
  );
end;
$$;

revoke all on function order_push_summary(uuid) from public, anon, authenticated;
-- เรียกได้เฉพาะ Edge Function ด้วย service_role เท่านั้น
