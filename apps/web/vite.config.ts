import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const webPort = Number(process.env.BEDROCK_PANEL_WEB_PORT || '5173')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
  },
})
