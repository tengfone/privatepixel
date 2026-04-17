import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173/privatepixel/",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "PRIVATEPIXEL_BASE=/privatepixel/ npm run build && PRIVATEPIXEL_BASE=/privatepixel/ npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/privatepixel/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
