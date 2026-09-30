-- ============================================================================
-- Row Level Security
--
-- ข้อเท็จจริงที่ทุก policy ตั้งอยู่บนนั้น:
--   เว็บเป็น static บน GitHub Pages → anon key เปิดเผยต่อสาธารณะ
--   ใครก็ยิง PostgREST ตรงได้ → RLS คือด่านเดียวที่กั้นอยู่
--
-- กติกา:
--   - ไม่มีตารางไหนเปิด INSERT / UPDATE / DELETE ให้ client เลย แม้แต่พนักงาน
--     การเขียนทุกอย่างผ่าน RPC (SECURITY DEFINER) ที่ตรวจกติกาธุรกิจเอง
--   - พนักงานที่ล็อกอินแล้วอ่านข้อมูลปฏิบัติการได้ทั้งหมด
--   - anon อ่านได้เฉพาะข้อมูลที่ติดหน้าร้านอยู่แล้ว (เมนู, คลังเกม, ผังโต๊ะ)
-- ============================================================================

-- ---------------------------------------------------------------- GRANT ----
-- Supabase ตั้ง default privileges ให้ตารางใหม่ทุกตารางได้สิทธิ์ ALL กับ
-- anon/authenticated อัตโนมัติ ถ้าไม่เพิกถอนก่อน การบอกว่า "ไม่เปิดให้เขียนตรง"
-- จะไม่เป็นจริง — RLS คุมได้แค่ "แถวไหน" ไม่ได้คุมว่า "ทำอะไรได้บ้าง"

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- อ่านอย่างเดียว ไม่มี INSERT/UPDATE/DELETE ให้ใครทั้งสิ้น
grant select on menu_items, game_titles, rate_plans, cafe_tables, tax_config
  to anon, authenticated;

grant select on visits, occupancies, guest_passes, orders, order_lines,
                game_loans, reservations, bills, bill_lines, payments,
                staff, audit_log
  to authenticated;

alter table staff         enable row level security;
alter table rate_plans    enable row level security;
alter table menu_items    enable row level security;
alter table cafe_tables   enable row level security;
alter table visits        enable row level security;
alter table occupancies   enable row level security;
alter table guest_passes  enable row level security;
alter table orders        enable row level security;
alter table order_lines   enable row level security;
alter table game_titles   enable row level security;
alter table game_loans    enable row level security;
alter table reservations  enable row level security;
alter table bills         enable row level security;
alter table bill_lines    enable row level security;
alter table payments      enable row level security;
alter table tax_config    enable row level security;
alter table audit_log     enable row level security;

-- ---------------------------------------------------- อ่านได้โดยไม่ล็อกอิน ----
-- ข้อมูลที่ติดอยู่บนกระดานหน้าร้านอยู่แล้ว ไม่มีอะไรต้องปิด

create policy public_read_menu on menu_items
  for select to anon, authenticated using (true);

create policy public_read_games on game_titles
  for select to anon, authenticated using (true);

create policy public_read_rate_plans on rate_plans
  for select to anon, authenticated using (active);

-- ผังโต๊ะ: บอกได้แค่ว่าโต๊ะไหนว่าง ไม่บอกว่าใครนั่ง
create policy public_read_tables on cafe_tables
  for select to anon, authenticated using (true);

create policy public_read_tax on tax_config
  for select to anon, authenticated using (true);

-- ------------------------------------------- ข้อมูลปฏิบัติการ เฉพาะพนักงาน ----

create policy staff_read_visits       on visits       for select to authenticated using (is_staff());
create policy staff_read_occupancies  on occupancies  for select to authenticated using (is_staff());
create policy staff_read_passes       on guest_passes for select to authenticated using (is_staff());
create policy staff_read_orders       on orders       for select to authenticated using (is_staff());
create policy staff_read_order_lines  on order_lines  for select to authenticated using (is_staff());
create policy staff_read_loans        on game_loans   for select to authenticated using (is_staff());
create policy staff_read_reservations on reservations for select to authenticated using (is_staff());

-- ------------------------------------------------------- เงิน: อ่านอย่างเดียว ----
-- ไม่มี policy INSERT/UPDATE เลยแม้แต่ของพนักงาน — เขียนได้ทางเดียวคือผ่าน
-- close_visit() ซึ่งเป็น SECURITY DEFINER และเขียน audit_log ทุกครั้ง

create policy staff_read_bills      on bills      for select to authenticated using (is_staff());
create policy staff_read_bill_lines on bill_lines for select to authenticated using (is_staff());
create policy staff_read_payments   on payments   for select to authenticated using (is_staff());

-- ------------------------------------------------------------------ staff ----

-- พนักงานเห็นโปรไฟล์ตัวเองได้เสมอ (ใช้เช็คว่าล็อกอินแล้วเป็นพนักงานจริงไหม)
create policy staff_read_self on staff
  for select to authenticated using (user_id = auth.uid());

create policy manager_read_staff on staff
  for select to authenticated using (
    exists (
      select 1 from staff s
      where s.user_id = auth.uid() and s.active and s.role in ('manager', 'owner')
    )
  );

-- audit_log: อ่านได้เฉพาะระดับจัดการ และไม่มีใครลบได้
create policy manager_read_audit on audit_log
  for select to authenticated using (
    exists (
      select 1 from staff s
      where s.user_id = auth.uid() and s.active and s.role in ('manager', 'owner')
    )
  );

-- ----------------------------------------------------------- สิทธิ์เรียก RPC ----

-- เพิกถอน EXECUTE ทั้งหมดไปแล้วข้างบน ที่นี่คืนให้เฉพาะที่ตั้งใจ

-- อ่านอย่างเดียว ไม่เปลี่ยนข้อมูล
grant execute on function preview_bill(uuid, timestamptz) to anon, authenticated;
grant execute on function is_staff() to authenticated;

-- ฟังก์ชันที่เปลี่ยนข้อมูล ให้เฉพาะคนที่ล็อกอิน
-- (ข้างในยังเรียก assert_staff() ซ้ำอีกชั้น — ล็อกอินเฉย ๆ ไม่พอ ต้องเป็นพนักงาน)
grant execute on function open_visit(uuid[], jsonb, visit_source)   to authenticated;
grant execute on function add_pass(uuid, text, uuid)                to authenticated;
grant execute on function pause_pass(uuid)                          to authenticated;
grant execute on function resume_pass(uuid)                         to authenticated;
grant execute on function check_out_pass(uuid)                      to authenticated;
grant execute on function move_visit_to_tables(uuid, uuid[])        to authenticated;
grant execute on function place_order(text, uuid, uuid, split_mode, placed_by_actor, jsonb) to authenticated;
grant execute on function update_order_status(uuid, order_status)   to authenticated;
grant execute on function close_visit(uuid, jsonb)                  to authenticated;

-- ----------------------------------------------------------------- Realtime ----
-- จอครัวและผังโต๊ะต้องอัปเดตเอง ไม่ต้องกด refresh
-- Realtime เคารพ RLS อยู่แล้ว → anon จะไม่ได้รับ event ของตารางที่อ่านไม่ได้

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      visits, occupancies, guest_passes, orders, order_lines, cafe_tables, reservations;
  end if;
end;
$$;
