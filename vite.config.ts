import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base ตรงกับชื่อ repo: https://fillybodyknow.github.io/BoardgameCafe/
// ถ้าย้ายไป custom domain ให้เปลี่ยนเป็น '/'
export default defineConfig({
  base: '/BoardgameCafe/',
  plugins: [react(), tailwindcss()],
})
