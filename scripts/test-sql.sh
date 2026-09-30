#!/usr/bin/env bash
# รัน migration + ชุดทดสอบ SQL บน Postgres จริงใน Docker
#
#   bash scripts/test-sql.sh
#
# ต้องเปิด Docker Desktop ก่อน ตัวสคริปต์ลบ container ทิ้งให้เองเมื่อจบ
set -euo pipefail

CONTAINER=bgcafe-sqltest
PGPASSWORD=postgres
IMAGE=postgres:16-alpine

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "== เปิด Postgres ชั่วคราว =="
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -e POSTGRES_DB=bgcafe \
  "$IMAGE" >/dev/null

echo -n "รอฐานข้อมูลพร้อม"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d bgcafe >/dev/null 2>&1; then
    echo " ok"
    break
  fi
  echo -n "."
  sleep 1
done

run() {
  echo
  echo "== $1 =="
  # ON_ERROR_STOP=1 ให้ทั้งสคริปต์ล้มทันทีที่มีเทสต์ไม่ผ่าน
  docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U postgres -d bgcafe -q < "$1"
}

run supabase/tests/00_harness.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run supabase/seed.sql
run supabase/tests/05_test_grants.sql
run supabase/tests/10_pricing_test.sql
run supabase/tests/20_operations_test.sql
run supabase/tests/30_guest_test.sql

echo
echo "เทสต์ SQL ผ่านทั้งหมด"
