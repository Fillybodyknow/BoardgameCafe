/**
 * ชื่อชั่วคราวที่หน้าจอพนักงานใส่ให้ตอนเปิดโต๊ะโดยไม่ได้พิมพ์ชื่อ
 *
 * แยกไว้ที่เดียวเพราะหน้าลงชื่อของลูกค้าต้องรู้ว่าชื่อไหนเป็นของชั่วคราว
 * จะได้ชวนให้ใส่ชื่อจริงตอนแตะเลือก แทนที่จะปล่อยให้บิลขึ้นว่า "ผู้เล่น 2" ไปจนจบ
 */
export function placeholderName(n: number): string {
  return `ผู้เล่น ${n}`
}

export function isPlaceholderName(name: string): boolean {
  return /^ผู้เล่น \d+$/.test(name.trim())
}
