-- ข้อมูลตั้งต้นของร้าน — แก้ให้ตรงร้านจริงแล้วรันซ้ำได้ (idempotent)

insert into rate_plans (id, name, price_per_hour, round_to_minutes, minimum_minutes, day_pass_cap, sort_order) values
  ('11111111-0000-4000-8000-000000000001', 'ทั่วไป',              60, 30, 60, 199, 1),
  ('11111111-0000-4000-8000-000000000002', 'สมาชิก',              48, 30, 60, 159, 2),
  ('11111111-0000-4000-8000-000000000003', 'นักเรียน/นักศึกษา',    40, 30, 60, 129, 3),
  ('11111111-0000-4000-8000-000000000004', 'แวะทักทาย (ไม่คิดเงิน)', 0, 30,  0,   0, 4)
on conflict (id) do nothing;

insert into cafe_tables (code, zone, seat_min, seat_max, allow_share, sort_order) values
  ('A1',  'โซนเงียบ',   2,  4, false, 1),
  ('A2',  'โซนเงียบ',   2,  4, false, 2),
  ('A3',  'โซนเงียบ',   2,  4, false, 3),
  ('B1',  'โซนกลาง',    4,  6, false, 4),
  ('B2',  'โซนกลาง',    4,  6, false, 5),
  ('B3',  'โซนกลาง',    4,  6, false, 6),
  ('C1',  'โต๊ะยาว',    6, 10, true,  7),
  ('BAR', 'เคาน์เตอร์', 1,  6, true,  8)
on conflict (code) do nothing;

insert into menu_items (sku, name, category, price, available, sort_order) values
  ('D01', 'อเมริกาโน่เย็น',        'drink',   65, true,  1),
  ('D02', 'ลาเต้ร้อน',             'drink',   70, true,  2),
  ('D03', 'ชาเขียวมัทฉะ',          'drink',   75, true,  3),
  ('D04', 'โซดามะนาว',             'drink',   55, true,  4),
  ('S01', 'เฟรนช์ฟรายส์',          'snack',   89, true,  5),
  ('S02', 'ป๊อปคอร์นคาราเมล',      'snack',   59, true,  6),
  ('S03', 'นักเก็ตไก่',             'snack',   95, false, 7),
  ('F01', 'สปาเก็ตตี้คาโบนาร่า',    'food',   149, true,  8),
  ('F02', 'ข้าวผัดกะเพราหมูกรอบ',  'food',   129, true,  9),
  ('K01', 'บราวนี่อุ่นไอศกรีม',     'dessert', 99, true, 10)
on conflict (sku) do nothing;

insert into game_titles (name, min_players, max_players, play_minutes, weight, copies) values
  ('Wingspan',           1, 5,  70, 3, 2),
  ('Codenames',          4, 8,  20, 1, 3),
  ('Terraforming Mars',  1, 5, 120, 5, 1),
  ('Splendor',           2, 4,  30, 2, 2),
  ('Everdell',           1, 4,  80, 4, 1),
  ('The Crew',           3, 5,  20, 2, 2)
on conflict do nothing;
