import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  root: "dev",
  envDir: resolve(__dirname),
  plugins: [vue()],
  resolve: {
    alias: {
      events: resolve(__dirname, "node_modules/events/events.js"),
    },
  },
  server: {
    port: 12345,
    fs: {
      allow: [__dirname],
    },
  },
  build: {
    outDir: resolve(__dirname, "demo"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["events"],
  },
});
