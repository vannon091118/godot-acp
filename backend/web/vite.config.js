import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-Proxy: /api -> Backend (default :8787), damit `npm run dev` live gegen
// das echte Backend arbeitet. Build-Ergebnis wird vom Backend statisch
// ausgeliefert (server.mjs, WEB_DIST).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.ACP_BACKEND_URL || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
