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
# Postgres เปิดพอร์ตชั่วคราวระหว่าง init แล้วรีสตาร์ต — ต้องเจอ ready ติดกันหลายครั้ง
# ไม่งั้นจะยิง SQL ใส่ตอนมันกำลังจะปิดตัว
ok=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d bgcafe >/dev/null 2>&1; then
    ok=$((ok + 1))
    [ "$ok" -ge 3 ] && { echo " ok"; break; }
  else
    ok=0
  fi
  echo -n "."
  sleep 1
done
[ "$ok" -ge 3 ] || { echo " ฐานข้อมูลไม่พร้อม"; exit 1; }

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
# ไล่ทุกไฟล์เอง — ก่อนหน้านี้เคยไล่ตามรายชื่อ แล้วเทสต์ใหม่ที่ลืมใส่ก็ไม่ถูกรันโดยไม่มีใครรู้
for f in supabase/tests/[0-9]*_*.sql; do
  [ "$f" = "supabase/tests/00_harness.sql" ] && continue
  run "$f"
done

echo
echo "เทสต์ SQL ผ่านทั้งหมด"
