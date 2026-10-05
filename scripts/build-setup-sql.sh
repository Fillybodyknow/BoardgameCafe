#!/usr/bin/env bash
# รวม migration ทั้งหมด + seed เป็นไฟล์เดียวสำหรับวางใน Supabase SQL Editor
set -euo pipefail
cd "$(dirname "$0")/.."
{
  cat <<'HDR'
-- ============================================================================
-- Boardgame Cafe — ติดตั้งครั้งเดียวจบ
--
-- วิธีใช้: Supabase Dashboard → SQL Editor → New query → วางไฟล์นี้ทั้งหมด → Run
--
-- ไฟล์นี้ถูกสร้างจาก supabase/migrations/*.sql + seed.sql
-- อย่าแก้ที่นี่ ให้แก้ที่ไฟล์ต้นทางแล้วสร้างใหม่ด้วย scripts/build-setup-sql.sh
-- ปลอดภัยที่จะรันซ้ำเฉพาะส่วน seed — ส่วน schema รันได้ครั้งเดียว
-- ============================================================================

HDR
  for f in supabase/migrations/*.sql supabase/seed.sql; do
    echo ""; echo "-- ####################################################################"
    echo "-- # $f"
    echo "-- ####################################################################"; echo ""
    cat "$f"
  done
  echo
  echo "-- ติดตั้งใหม่ = ถือว่าผ่านทุก patch แล้ว กันคนเผลอรัน patch เก่าทับทีหลัง"
  cat <<'LEDGER'
create table if not exists schema_patches (
  name       text primary key,
  seq        bigint not null,
  applied_at timestamptz not null default now()
);
LEDGER
  for f in supabase/migrations/*.sql; do
    seq=$(basename "$f" | cut -d_ -f1)
    echo "insert into schema_patches (name, seq) values ('migration-$seq', $seq)"
    echo "  on conflict (name) do nothing;"
  done
} > supabase/setup-all.sql
echo "เขียน supabase/setup-all.sql แล้ว ($(wc -l < supabase/setup-all.sql) บรรทัด)"

# patch รายเฟส สำหรับฐานข้อมูลที่ติดตั้งไปแล้ว
# ตารางบันทึกว่า patch ไหนถูก apply ไปแล้ว
#
# จำเป็นเพราะ patch หลายไฟล์ประกาศฟังก์ชันชื่อเดียวกัน (create or replace)
# ถ้ารันไฟล์เก่าทีหลังไฟล์ใหม่ ฟังก์ชันเวอร์ชันเก่าจะทับเวอร์ชันใหม่เงียบ ๆ
# แล้วฟีเจอร์ที่เพิ่งเพิ่มจะหายไปโดยไม่มีอะไรบอก — เกิดขึ้นจริงมาแล้ว
ledger() {
  cat <<'LEDGER'
create table if not exists schema_patches (
  name       text primary key,
  seq        bigint not null,
  applied_at timestamptz not null default now()
);
LEDGER
}

make_patch() {
  local out="$1" title="$2"; shift 2
  # ลำดับของ patch = เลขเวลาของ migration ตัวท้ายสุดในไฟล์
  local seq
  seq=$(basename "${!#}" | cut -d_ -f1)
  local name
  name=$(basename "$out" .sql)

  {
    echo "-- ============================================================================"
    echo "-- Boardgame Cafe — $title"
    echo "--"
    echo "-- สำหรับฐานข้อมูลที่ติดตั้งเวอร์ชันก่อนหน้าไปแล้ว"
    echo "-- ถ้าเป็นการติดตั้งใหม่ ใช้ setup-all.sql แทน (รวมไฟล์นี้ไว้แล้ว)"
    echo "--"
    echo "-- รันซ้ำได้ แต่รันย้อนลำดับไม่ได้ — ถ้ามี patch ที่ใหม่กว่าติดตั้งไปแล้ว"
    echo "-- ไฟล์นี้จะหยุดทันทีพร้อมบอกเหตุผล แทนที่จะทับของใหม่ด้วยของเก่าเงียบ ๆ"
    echo "-- ============================================================================"
    echo
    ledger
    cat <<GUARD

do \$\$
declare v_newer text;
begin
  select string_agg(name, ', ' order by seq) into v_newer
    from schema_patches where seq > $seq;

  if v_newer is not null then
    raise exception
      'ฐานข้อมูลนี้ติดตั้ง % ซึ่งใหม่กว่า $name ไปแล้ว การรันไฟล์นี้จะทับของใหม่ด้วยของเก่า — ไม่ต้องรัน', v_newer
      using errcode = '55000';
  end if;
end;
\$\$;
GUARD
    for f in "$@"; do echo; echo "-- ###### $f"; echo; cat "$f"; done
    echo
    echo "-- จดว่า patch นี้ติดตั้งแล้ว"
    echo "insert into schema_patches (name, seq) values ('$name', $seq)"
    echo "  on conflict (name) do update set applied_at = now();"
  } > "$out"
  echo "เขียน $out แล้ว ($(wc -l < "$out") บรรทัด)"
}

make_patch supabase/patch-phase2.sql "patch Phase 2 (ลูกค้าสั่งผ่าน QR + อุดสิทธิ์ EXECUTE)"   supabase/migrations/20260930000500_guest_ordering.sql   supabase/migrations/20260930000600_harden_execute.sql

make_patch supabase/patch-booking.sql "patch จองโต๊ะออนไลน์ + เลิกใช้สถานะกำลังเก็บ"   supabase/migrations/20260930000700_reservations.sql   supabase/migrations/20260930000800_drop_cleaning_status.sql

make_patch supabase/patch-owner.sql "patch หน้าตั้งค่าเจ้าของร้าน"   supabase/migrations/20260930000900_owner_settings.sql

make_patch supabase/patch-menu-images.sql "patch รูปประกอบเมนู"   supabase/migrations/20260930001000_menu_images.sql

make_patch supabase/patch-staff.sql "patch จัดการบัญชีพนักงาน + ล็อกอินด้วย username"   supabase/migrations/20260930001100_staff_management.sql

make_patch supabase/patch-roles.sql "patch ระดับพนักงานแบบแยกสิทธิ์"   supabase/migrations/20260930001200_role_capabilities.sql

make_patch supabase/patch-push.sql "patch แจ้งเตือนออเดอร์เข้าครัว"   supabase/migrations/20260930001300_push_notifications.sql   supabase/migrations/20260930001400_push_payload.sql

make_patch supabase/patch-settle.sql "patch จ่ายตอนกลับก่อน" \
  supabase/migrations/20260930001500_settle_pass.sql
