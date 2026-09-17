import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web/client",
  base: "/static/",
  plugins: [react()],
  build: {
    outDir: "../static",
    emptyOutDir: true,
  },
});
