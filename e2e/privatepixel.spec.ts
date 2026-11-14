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
  await expect(page.locator(".preview-canvas").first()).toBeVisible();
  await expect(page.locator(".preview-stage figure")).toHaveCount(1);
  const compressStageHeight = await page
    .locator(".editor-stage")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(compressStageHeight).toBeLessThanOrEqual(800);

  const zoomOutButton = page.locator(".preview-zoom-tools button").first();
  await zoomOutButton.click();
  await zoomOutButton.click();
  const imageFit = await page
    .locator(".preview-stage img")
    .first()
    .evaluate((image) => {
      const imageBox = image.getBoundingClientRect();
      const figureBox = image.closest("figure")?.getBoundingClientRect();
      return {
        fits:
          Boolean(figureBox) &&
          imageBox.left >= figureBox!.left - 1 &&
          imageBox.right <= figureBox!.right + 1 &&
          imageBox.top >= figureBox!.top - 1 &&
          imageBox.bottom <= figureBox!.bottom + 1,
      };
    });
  expect(imageFit.fits).toBe(true);

  const previewCanvas = page.locator(".preview-canvas").first();
  const beforePan = await previewCanvas.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  const figureBox = await page.locator(".preview-stage figure").first().boundingBox();
  expect(figureBox).not.toBeNull();
  await page.mouse.move(figureBox!.x + figureBox!.width / 2, figureBox!.y + 120);
  await page.mouse.down();
  await page.mouse.move(figureBox!.x + figureBox!.width / 2 + 48, figureBox!.y + 148);
  await page.mouse.up();
  const afterPan = await previewCanvas.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  expect(afterPan).not.toBe(beforePan);

  await page.getByRole("button", { name: /Metadata/ }).click();
  await expect(page.getByText("Format-aware metadata")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Existing metadata" })).toBeVisible();
  await expect(page.getByText("File name")).toBeVisible();
  await expect(page.getByText("No editable PNG metadata chunks found.")).toBeVisible();
  await page.getByLabel("Metadata mode").selectOption("edit");
  await page.getByRole("textbox", { name: "Title" }).fill("Local test image");
  await page.getByRole("button", { name: "Run Metadata" }).click();
  await expect(page.getByText(/Ready to download/)).toBeVisible();
});

test("decodes a HEIC photo locally and compares original and result", async ({
  page,
}) => {
  await page.goto("/privatepixel/");
  await page
    .getByTestId("file-input")
    .setInputFiles(new URL("./fixtures/sample.heic", import.meta.url).pathname);

  await expect(page.getByTestId("asset-item")).toHaveCount(1);
  await expect(page.getByTestId("asset-item")).toContainText("sample.heic");
  await expect(page.getByTestId("asset-item")).toContainText("64 x 48");
  await expect(page.getByTestId("heic-note")).toContainText(
    "EXIF/GPS metadata, colour profile, and HDR are not carried over",
  );

  await page.getByRole("button", { name: /Compress/ }).click();
  await page.getByRole("button", { name: "Run Compress" }).click();
  await expect(page.getByTestId("result-row")).toBeVisible();

  const slider = page.getByRole("slider", { name: "Before and after" });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuenow", "50");

  // Labels: Before on the left, After on the right, neither under the toolbar.
  const beforeLabel = await page.getByTestId("label-before").boundingBox();
  const afterLabel = await page.getByTestId("label-after").boundingBox();
  const toolbar = await page.locator(".preview-zoom-tools").boundingBox();
  expect(beforeLabel && afterLabel && toolbar).toBeTruthy();
  expect(beforeLabel!.x + beforeLabel!.width).toBeLessThan(afterLabel!.x);
  for (const label of [beforeLabel!, afterLabel!]) {
    const overlaps =
      label.x < toolbar!.x + toolbar!.width &&
      label.x + label.width > toolbar!.x &&
      label.y < toolbar!.y + toolbar!.height &&
      label.y + label.height > toolbar!.y;
    expect(overlaps).toBe(false);
  }

  const clips = () =>
    page.evaluate(() => ({
      before: getComputedStyle(document.querySelector("[data-testid=compare-before]")!)
        .clipPath,
      after: getComputedStyle(document.querySelector("[data-testid=compare-after]")!)
        .clipPath,
    }));
  const insets = (clip: string) =>
    (clip.match(/-?[\d.]+/g) ?? []).map((value) => Number(value));

  // The original keeps the part left of the divider, the result the part right of it.
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  // [right inset of the original, left inset of the result]; polled because
  // the divider animates.
  const sides = async () => {
    const current = await clips();
    return [insets(current.before)[1], insets(current.after)[3]];
  };
  await expect.poll(sides).toEqual([100, 0]);

  await page.keyboard.press("PageUp");
  await expect(slider).toHaveAttribute("aria-valuenow", "10");
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuenow", "100");
  await expect.poll(sides).toEqual([0, 100]);

  // A tap on the stage moves the divider there.
  const frame = await page.getByTestId("compare-frame").boundingBox();
  expect(frame).not.toBeNull();
  await page.mouse.click(frame!.x + frame!.width * 0.25, frame!.y + frame!.height / 2);
  const tapped = Number(await slider.getAttribute("aria-valuenow"));
  expect(tapped).toBeGreaterThanOrEqual(22);
  expect(tapped).toBeLessThanOrEqual(28);

  // Both sides sit on a checkerboard so transparent pixels stay visible.
  const backgrounds = await page.evaluate(() =>
    [
      document.querySelector("[data-testid=compare-before]")!,
      document.querySelector("[data-testid=compare-after] img")!,
    ].map((element) => getComputedStyle(element).backgroundImage),
  );
  for (const background of backgrounds) {
    expect(background).toContain("conic-gradient");
  }
});
