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
ok=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d bgcafe >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else
    ok=0
  fi
  sleep 1
done
[ "$ok" -ge 3 ] || { echo "ฐานข้อมูลไม่พร้อม"; exit 1; }

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

echo "--- apply patch ทีละเฟส ตามลำดับที่ผู้ใช้จริงจะรัน ---"
run supabase/patch-phase2.sql
run supabase/patch-booking.sql
run supabase/patch-owner.sql
run supabase/patch-menu-images.sql
run supabase/patch-staff.sql
run supabase/patch-roles.sql
run supabase/patch-push.sql
run supabase/patch-settle.sql
run supabase/patch-kitchen-hours.sql
run supabase/patch-guest-register.sql

# รอบที่เปิดค้างอยู่ตอนอัปเกรด ต้องได้ QR ของตัวเองทันที ไม่งั้นโต๊ะที่นั่งอยู่
# ตอนกด deploy จะพิมพ์ใบ QR ให้ลูกค้าไม่ได้จนกว่าจะปิดบิล
echo "--- มีรอบเปิดค้างก่อนลง patch-visit-qr ---"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d bgcafe -q <<'SQL'
insert into visits (id, code) values ('18000000-0000-4000-8000-000000000001', 'V-PRE');
insert into occupancies (visit_id, table_id, from_at)
select '18000000-0000-4000-8000-000000000001', id, now()
  from cafe_tables t
 where not exists (select 1 from occupancies o where o.table_id = t.id and o.to_at is null)
 order by code limit 1;
SQL
run supabase/patch-visit-qr.sql
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d bgcafe -q <<'SQL'
do $$
begin
  if exists (select 1 from visits where qr_token is null) then
    raise exception 'FAIL  มีรอบที่ไม่ได้ QR หลังอัปเกรด';
  end if;
  if (select count(distinct qr_token) from visits) <> (select count(*) from visits) then
    raise exception 'FAIL  QR ของรอบเดิมซ้ำกัน';
  end if;
  if visit_for_token((select qr_token from visits where code = 'V-PRE'))
     is distinct from '18000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'FAIL  รอบที่เปิดค้างก่อนอัปเกรดใช้ QR ของตัวเองไม่ได้';
  end if;
  raise notice 'PASS  รอบที่เปิดค้างก่อนอัปเกรดได้ QR คนละใบและใช้ได้ทันที';
end;
$$;
-- เก็บกวาด ไม่ให้โต๊ะค้างไปกวนเทสต์ชุดหลัง
delete from occupancies where visit_id = '18000000-0000-4000-8000-000000000001';
delete from visits where id = '18000000-0000-4000-8000-000000000001';
SQL

# ผู้ใช้วาง SQL ทีละไฟล์ในหน้าเว็บ ถ้าล้มกลางไฟล์จะค้างครึ่ง ๆ แล้วต้องรันใหม่
# patch ที่ยังต้องใช้จึงต้องรันซ้ำได้โดยไม่พัง — พิสูจน์ด้วยการรันซ้ำจริง
# รันซ้ำเฉพาะตัวล่าสุดได้ ส่วนตัวเก่ากว่าจะโดนการ์ดบล็อก (ทดสอบด้านล่าง)
run supabase/patch-claim-pass.sql
run supabase/patch-shop-profile.sql
run supabase/patch-single-table.sql

echo "--- รัน patch ล่าสุดซ้ำอีกรอบ ต้องไม่พัง ---"
run supabase/patch-single-table.sql

# patch หลายไฟล์ประกาศฟังก์ชันชื่อเดียวกัน ถ้ารันไฟล์เก่าทีหลังไฟล์ใหม่
# ของเก่าจะทับของใหม่เงียบ ๆ แล้วฟีเจอร์หายโดยไม่มีอะไรบอก — เคยเกิดจริง
echo "--- รัน patch ย้อนลำดับ ต้องถูกปฏิเสธ ---"
if docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d bgcafe -q      < supabase/patch-staff.sql 2>/dev/null; then
  echo "FAIL  รัน patch เก่าทับของใหม่ได้ ทั้งที่ไม่ควร"
  exit 1
fi
echo "PASS  รัน patch-staff หลัง patch-roles ถูกปฏิเสธ"

echo "--- เทสต์ชุดเดียวกับการติดตั้งใหม่ ---"
for f in supabase/tests/[0-9]*_*.sql; do
  [ "$f" = "supabase/tests/00_harness.sql" ] && continue
  run "$f"
done

echo
echo "เส้นทางอัปเกรดผ่านทั้งหมด"
