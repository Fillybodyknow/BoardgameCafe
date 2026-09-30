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
