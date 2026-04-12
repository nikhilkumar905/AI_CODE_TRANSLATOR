import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6002,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:6001',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
