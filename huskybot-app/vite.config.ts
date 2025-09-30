import { defineConfig } from 'vite'
import path from "path"
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api/menu": {
        target: process.env.VITE_PROXY_TARGET || "https://us-central1-huskybot-dabab.cloudfunctions.net",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/menu/, "/menu"),
      },
      "/api/hours": {
        target: process.env.VITE_PROXY_TARGET || "https://us-central1-huskybot-dabab.cloudfunctions.net",
        changeOrigin: true,
        rewrite: (p) => {
          const m = p.match(/^\/api\/hours\/([^\/?#]+)/);
          if (m && m[1]) {
            return `/hours?diningHall=${encodeURIComponent(m[1])}`;
          }
          return p.replace(/^\/api\/hours/, "/hours");
        },
      },
    },
  },
})
