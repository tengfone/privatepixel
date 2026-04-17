import { expect, test } from "@playwright/test";
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAJElEQVR4AVzFgQkAAAgCwc/9d7YoIujgVV5gV+IREXQMzd0mAAAA//+U28WrAAAABklEQVQDANlSDAFZtBg5AAAAAElFTkSuQmCC";

test("imports an image and produces a resize result", async ({ page }) => {
  await page.goto("/privatepixel/");
  await page.getByTestId("file-input").setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: Buffer.from(SAMPLE_PNG_BASE64, "base64"),
  });

  await expect(page.getByTestId("asset-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Run Resize" }).click();

  await expect(page.getByTestId("result-row")).toBeVisible();
  await expect(page.getByText(/Ready to download/)).toBeVisible();
});
