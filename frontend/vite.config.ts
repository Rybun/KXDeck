import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // manifest: para que el backend resuelva el nombre (con hash) del
    // bundle de widgets en tiempo de arranque (ver backend/kx_home.py).
    // Unica entrada del build: no hay SPA propia, todo vive inyectado en
    // el panel nativo de KX-Bridge (ver kx_home.py/entry.tsx).
    manifest: true,
    rollupOptions: {
      input: {
        widgets: "src/widgets/entry.tsx",
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5050', ws: true },
      '/downloads': 'http://localhost:5050',
      '/thumbnail': 'http://localhost:5050',
      '/webcam': 'http://localhost:5050',
      '/snapshot': 'http://localhost:5050',
    },
  },
})
