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
  await expect(page.getByText("Live output")).toBeVisible();
  await expect(page.getByText(/Exact size from a local browser encode/)).toBeVisible();

  const presetGrid = page.locator(".preset-grid");
  const presetGridMetrics = await presetGrid.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(presetGridMetrics.clientHeight).toBeLessThanOrEqual(160);
  expect(presetGridMetrics.scrollHeight).toBeGreaterThan(
    presetGridMetrics.clientHeight,
  );

  await page.getByRole("spinbutton", { name: "Width" }).fill("8");
  await expect(page.getByRole("spinbutton", { name: "Height" })).toHaveValue("8");
  await page.getByRole("button", { name: "Locked" }).click();
  await page.getByRole("spinbutton", { name: "Width" }).fill("9");
  await expect(page.getByRole("spinbutton", { name: "Height" })).toHaveValue("8");

  await page.getByRole("button", { name: /Slack profile/ }).click();
  await expect(page.getByRole("spinbutton", { name: "Width" })).toHaveValue("1024");
  await expect(page.getByRole("spinbutton", { name: "Height" })).toHaveValue("1024");
  await expect(page.locator(".resize-frame span")).toHaveText("1024 x 1024");

  await page.getByRole("button", { name: "Run Resize" }).click();

  await expect(page.getByTestId("result-row")).toBeVisible();
  await expect(page.getByText(/Ready to download/)).toBeVisible();

  await page.getByRole("button", { name: /Compress/ }).click();
  await expect(page.locator(".preview-stage img").first()).toBeVisible();
  const compressStageHeight = await page
    .locator(".editor-stage")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(compressStageHeight).toBeLessThanOrEqual(800);
});
