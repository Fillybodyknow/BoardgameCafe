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
