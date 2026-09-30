-- migration 600 ตัด EXECUTE จาก PUBLIC ทั้ง schema ซึ่งรวม assert_eq ของชุดทดสอบด้วย
-- คืนให้เฉพาะตัวช่วยทดสอบ ไม่แตะสิทธิ์ของแอปจริง
grant execute on function assert_eq(text, anyelement, anyelement) to public;
