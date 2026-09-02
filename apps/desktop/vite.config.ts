import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: ["es2021", "chrome105", "safari13"], sourcemap: true },
});
