import type { Snapshot } from '../port'

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

export function businessDateOf(d: Date): string {
  // ร้านปิดตี 1 — ยอดก่อน 05:00 นับเป็นวันทำการก่อนหน้า
  const shifted = new Date(d.getTime() - 5 * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

// รหัสเรตราคาใช้ UUID ชุดเดียวกับ supabase/seed.sql โดยตั้งใจ
// ถ้าข้อมูลจำลองใช้รหัสคนละรูปแบบกับของจริง บั๊กอย่างการ hardcode รหัส
// จะผ่านโหมดเดโมไปได้แล้วไปพังตอนต่อฐานข้อมูลจริง
export function seed(): Snapshot {
  return {
    ratePlans: [
      { id: '11111111-0000-4000-8000-000000000001', name: 'ทั่วไป', pricePerHour: 60, roundToMinutes: 30, minimumMinutes: 60, dayPassCap: 199 },
      { id: '11111111-0000-4000-8000-000000000002', name: 'สมาชิก', pricePerHour: 48, roundToMinutes: 30, minimumMinutes: 60, dayPassCap: 159 },
      { id: '11111111-0000-4000-8000-000000000003', name: 'นักเรียน/นักศึกษา', pricePerHour: 40, roundToMinutes: 30, minimumMinutes: 60, dayPassCap: 129 },
      { id: '11111111-0000-4000-8000-000000000004', name: 'แวะทักทาย (ไม่คิดเงิน)', pricePerHour: 0, roundToMinutes: 30, minimumMinutes: 0, dayPassCap: 0 },
    ],

    tables: [
      // v-1 ย้ายออกจาก A1 ไป B1 แล้ว โต๊ะนี้จึงว่าง (สถานะโต๊ะต้องตรงกับ occupancy เสมอ)
      { id: 't-a1', code: 'A1', zone: 'โซนเงียบ', seatMin: 2, seatMax: 4, allowShare: false, status: 'free' , qrToken: 'qr-a1' },
      { id: 't-a2', code: 'A2', zone: 'โซนเงียบ', seatMin: 2, seatMax: 4, allowShare: false, status: 'occupied' , qrToken: 'qr-a2' },
      { id: 't-a3', code: 'A3', zone: 'โซนเงียบ', seatMin: 2, seatMax: 4, allowShare: false, status: 'free' , qrToken: 'qr-a3' },
      { id: 't-b1', code: 'B1', zone: 'โซนกลาง', seatMin: 4, seatMax: 6, allowShare: false, status: 'occupied' , qrToken: 'qr-b1' },
      { id: 't-b2', code: 'B2', zone: 'โซนกลาง', seatMin: 4, seatMax: 6, allowShare: false, status: 'free' , qrToken: 'qr-b2' },
      { id: 't-b3', code: 'B3', zone: 'โซนกลาง', seatMin: 4, seatMax: 6, allowShare: false, status: 'free' , qrToken: 'qr-b3' },
      { id: 't-c1', code: 'C1', zone: 'โต๊ะยาว', seatMin: 6, seatMax: 10, allowShare: true, status: 'free' , qrToken: 'qr-c1' },
      { id: 't-bar', code: 'BAR', zone: 'เคาน์เตอร์', seatMin: 1, seatMax: 6, allowShare: true, status: 'occupied' , qrToken: 'qr-bar' },
    ],

    visits: [
      { id: 'v-1', code: 'V-014', source: 'walkin', status: 'open', openedAt: ago(135), closedAt: null, businessDate: businessDateOf(new Date()) },
      { id: 'v-2', code: 'V-015', source: 'reservation', status: 'open', openedAt: ago(52), closedAt: null, businessDate: businessDateOf(new Date()) },
      { id: 'v-3', code: 'V-016', source: 'walkin', status: 'open', openedAt: ago(18), closedAt: null, businessDate: businessDateOf(new Date()) },
    ],

    // v-1 ย้ายโต๊ะกลางคัน A1 → B1 (เกมใหญ่ ต้องการโต๊ะกว้างกว่า)
    occupancies: [
      { id: 'o-1', visitId: 'v-1', tableId: 't-a1', fromAt: ago(135), toAt: ago(70) },
      { id: 'o-2', visitId: 'v-1', tableId: 't-b1', fromAt: ago(70), toAt: null },
      { id: 'o-3', visitId: 'v-2', tableId: 't-a2', fromAt: ago(52), toAt: null },
      { id: 'o-4', visitId: 'v-3', tableId: 't-bar', fromAt: ago(18), toAt: null },
    ],

    passes: [
      // กลุ่มที่เข้าไม่พร้อมกัน + มีคนกลับไปแล้ว + มีคนออกไปข้างนอก
      { id: 'p-1', visitId: 'v-1', displayName: 'ต้น', ratePlanId: '11111111-0000-4000-8000-000000000002', status: 'active', checkedInAt: ago(135), checkedOutAt: null, pausedMinutes: 0, pausedAt: null },
      { id: 'p-2', visitId: 'v-1', displayName: 'เมย์', ratePlanId: '11111111-0000-4000-8000-000000000001', status: 'active', checkedInAt: ago(135), checkedOutAt: null, pausedMinutes: 12, pausedAt: null },
      { id: 'p-3', visitId: 'v-1', displayName: 'บอส', ratePlanId: '11111111-0000-4000-8000-000000000001', status: 'checked_out', checkedInAt: ago(135), checkedOutAt: ago(25), pausedMinutes: 0, pausedAt: null },
      { id: 'p-4', visitId: 'v-1', displayName: 'ปาล์ม (มาสาย)', ratePlanId: '11111111-0000-4000-8000-000000000003', status: 'paused', checkedInAt: ago(64), checkedOutAt: null, pausedMinutes: 0, pausedAt: ago(9) },

      { id: 'p-5', visitId: 'v-2', displayName: 'ฟ้า', ratePlanId: '11111111-0000-4000-8000-000000000001', status: 'active', checkedInAt: ago(52), checkedOutAt: null, pausedMinutes: 0, pausedAt: null },
      { id: 'p-6', visitId: 'v-2', displayName: 'กัน', ratePlanId: '11111111-0000-4000-8000-000000000001', status: 'active', checkedInAt: ago(52), checkedOutAt: null, pausedMinutes: 0, pausedAt: null },

      { id: 'p-7', visitId: 'v-3', displayName: 'นัท (มาคนเดียว)', ratePlanId: '11111111-0000-4000-8000-000000000002', status: 'active', checkedInAt: ago(18), checkedOutAt: null, pausedMinutes: 0, pausedAt: null },
    ],

    menu: [
      { id: 'm-1', sku: 'D01', name: 'อเมริกาโน่เย็น', category: 'drink', price: 65, available: true },
      { id: 'm-2', sku: 'D02', name: 'ลาเต้ร้อน', category: 'drink', price: 70, available: true },
      { id: 'm-3', sku: 'D03', name: 'ชาเขียวมัทฉะ', category: 'drink', price: 75, available: true },
      { id: 'm-4', sku: 'D04', name: 'โซดามะนาว', category: 'drink', price: 55, available: true },
      { id: 'm-5', sku: 'S01', name: 'เฟรนช์ฟรายส์', category: 'snack', price: 89, available: true },
      { id: 'm-6', sku: 'S02', name: 'ป๊อปคอร์นคาราเมล', category: 'snack', price: 59, available: true },
      { id: 'm-7', sku: 'S03', name: 'นักเก็ตไก่', category: 'snack', price: 95, available: false },
      { id: 'm-8', sku: 'F01', name: 'สปาเก็ตตี้คาโบนาร่า', category: 'food', price: 149, available: true },
      { id: 'm-9', sku: 'F02', name: 'ข้าวผัดกะเพราหมูกรอบ', category: 'food', price: 129, available: true },
      { id: 'm-10', sku: 'K01', name: 'บราวนี่อุ่นไอศกรีม', category: 'dessert', price: 99, available: true },
    ],

    orders: [
      {
        id: 'ord-1', visitId: 'v-1', orderedByPassId: 'p-1', placedBy: 'guest',
        splitMode: 'owner', tableIdSnapshot: 't-a1', status: 'served', placedAt: ago(120),
        lines: [{ id: 'ol-1', menuItemId: 'm-1', nameSnapshot: 'อเมริกาโน่เย็น', unitPriceSnapshot: 65, qty: 1 }],
      },
      {
        id: 'ord-2', visitId: 'v-1', orderedByPassId: null, placedBy: 'staff',
        splitMode: 'shared', tableIdSnapshot: 't-b1', status: 'preparing', placedAt: ago(14),
        lines: [
          { id: 'ol-2', menuItemId: 'm-5', nameSnapshot: 'เฟรนช์ฟรายส์', unitPriceSnapshot: 89, qty: 1, note: 'ไม่ใส่ซอส' },
          { id: 'ol-3', menuItemId: 'm-6', nameSnapshot: 'ป๊อปคอร์นคาราเมล', unitPriceSnapshot: 59, qty: 2 },
        ],
      },
      {
        id: 'ord-3', visitId: 'v-2', orderedByPassId: 'p-5', placedBy: 'guest',
        splitMode: 'owner', tableIdSnapshot: 't-a2', status: 'placed', placedAt: ago(4),
        lines: [{ id: 'ol-4', menuItemId: 'm-8', nameSnapshot: 'สปาเก็ตตี้คาโบนาร่า', unitPriceSnapshot: 149, qty: 1 }],
      },
    ],

    games: [
      { id: 'g-1', name: 'Wingspan', minPlayers: 1, maxPlayers: 5, playMinutes: 70, weight: 3, copies: 2, onLoan: 1 },
      { id: 'g-2', name: 'Codenames', minPlayers: 4, maxPlayers: 8, playMinutes: 20, weight: 1, copies: 3, onLoan: 0 },
      { id: 'g-3', name: 'Terraforming Mars', minPlayers: 1, maxPlayers: 5, playMinutes: 120, weight: 5, copies: 1, onLoan: 1 },
      { id: 'g-4', name: 'Splendor', minPlayers: 2, maxPlayers: 4, playMinutes: 30, weight: 2, copies: 2, onLoan: 0 },
      { id: 'g-5', name: 'Everdell', minPlayers: 1, maxPlayers: 4, playMinutes: 80, weight: 4, copies: 1, onLoan: 0 },
      { id: 'g-6', name: 'The Crew', minPlayers: 3, maxPlayers: 5, playMinutes: 20, weight: 2, copies: 2, onLoan: 0 },
    ],

    reservations: [
      { id: 'r-1', code: 'K7M2XQ', source: 'online', customerName: 'คุณแนน', phone: '081-234-5678', partySize: 6, startAt: new Date(now + 45 * 60_000).toISOString(), durationMinutes: 180, zonePreference: 'โต๊ะยาว', status: 'confirmed', tableIds: ['t-c1'], visitId: null },
      { id: 'r-2', code: 'B4WPRT', source: 'online', customerName: 'คุณโอ๊ต', phone: '089-876-5432', partySize: 4, startAt: new Date(now + 150 * 60_000).toISOString(), durationMinutes: 120, zonePreference: null, status: 'pending', tableIds: ['t-b2'], visitId: null },
    ],
  }
}
