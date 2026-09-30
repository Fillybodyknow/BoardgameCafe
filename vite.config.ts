/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base ตรงกับชื่อ repo: https://fillybodyknow.github.io/BoardgameCafe/
// ถ้าย้ายไป custom domain ให้เปลี่ยนเป็น '/'
export default defineConfig({
  base: '/BoardgameCafe/',
  plugins: [react(), tailwindcss()],
  test: {
    // บังคับโหมดข้อมูลจำลองเสมอ ไม่งั้น .env.local ในเครื่องนักพัฒนา
    // จะทำให้เทสต์ไปเจอหน้าล็อกอินแทนหน้าจอที่ต้องการตรวจ
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
  },
})
