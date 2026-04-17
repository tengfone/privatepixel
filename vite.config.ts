import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const base =
  process.env.PRIVATEPIXEL_BASE ??
  (process.env.GITHUB_PAGES === "true" ? "/privatepixel/" : "/");

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    assetsDir: "assets",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
