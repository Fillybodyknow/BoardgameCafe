#!/usr/bin/env bash
# ทดสอบ "เส้นทางอัปเกรด" ไม่ใช่การติดตั้งใหม่
# จำลองฐานข้อมูลที่รัน migration 100-400 ไปแล้ว แล้ว apply patch-phase2.sql ทับ
# แล้วรันเทสต์ชุดเดียวกับการติดตั้งใหม่ ผลลัพธ์ต้องเหมือนกันทุกประการ
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=bgcafe-upgrade
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "== Postgres ชั่วคราว =="
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bgcafe \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -d bgcafe >/dev/null 2>&1 && break
  sleep 1
done

run() {
  echo "== $1 =="
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d bgcafe -q < "$1"
}

echo "--- สถานะเดิม: migration 100-400 + seed ---"
run supabase/tests/00_harness.sql
for f in supabase/migrations/202609300001*.sql \
         supabase/migrations/202609300002*.sql \
         supabase/migrations/202609300003*.sql \
         supabase/migrations/202609300004*.sql; do run "$f"; done
run supabase/seed.sql

echo "--- apply patch ---"
run supabase/patch-phase2.sql

echo "--- เทสต์ชุดเดียวกับการติดตั้งใหม่ ---"
run supabase/tests/05_test_grants.sql
run supabase/tests/10_pricing_test.sql
run supabase/tests/20_operations_test.sql
run supabase/tests/30_guest_test.sql

echo
echo "เส้นทางอัปเกรดผ่านทั้งหมด"
