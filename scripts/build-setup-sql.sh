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
} > supabase/setup-all.sql
echo "เขียน supabase/setup-all.sql แล้ว ($(wc -l < supabase/setup-all.sql) บรรทัด)"

# patch รายเฟส สำหรับฐานข้อมูลที่ติดตั้งไปแล้ว
make_patch() {
  local out="$1" title="$2"; shift 2
  {
    echo "-- ============================================================================"
    echo "-- Boardgame Cafe — $title"
    echo "--"
    echo "-- สำหรับฐานข้อมูลที่ติดตั้งเวอร์ชันก่อนหน้าไปแล้ว"
    echo "-- ถ้าเป็นการติดตั้งใหม่ ใช้ setup-all.sql แทน (รวมไฟล์นี้ไว้แล้ว)"
    echo "-- ============================================================================"
    for f in "$@"; do echo; echo "-- ###### $f"; echo; cat "$f"; done
  } > "$out"
  echo "เขียน $out แล้ว ($(wc -l < "$out") บรรทัด)"
}

make_patch supabase/patch-phase2.sql "patch Phase 2 (ลูกค้าสั่งผ่าน QR + อุดสิทธิ์ EXECUTE)"   supabase/migrations/20260930000500_guest_ordering.sql   supabase/migrations/20260930000600_harden_execute.sql

make_patch supabase/patch-booking.sql "patch จองโต๊ะออนไลน์ + เลิกใช้สถานะกำลังเก็บ"   supabase/migrations/20260930000700_reservations.sql   supabase/migrations/20260930000800_drop_cleaning_status.sql

make_patch supabase/patch-owner.sql "patch หน้าตั้งค่าเจ้าของร้าน"   supabase/migrations/20260930000900_owner_settings.sql

make_patch supabase/patch-menu-images.sql "patch รูปประกอบเมนู"   supabase/migrations/20260930001000_menu_images.sql
