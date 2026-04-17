import { describe, expect, it } from "vitest";
import {
  calculateCompressedDimensions,
  calculateResizeDimensions,
  clampQuality,
  createCenteredCrop,
  createOutputFilename,
  mimeToExtension,
  normalizeCropOptions,
} from "./options";

describe("image option helpers", () => {
  it("locks aspect ratio with contain fit", () => {
    expect(
      calculateResizeDimensions({
        sourceWidth: 4000,
        sourceHeight: 2000,
        targetWidth: 1000,
        targetHeight: 1000,
        fitMode: "contain",
        lockAspectRatio: true,
      }),
    ).toEqual({ width: 1000, height: 500 });
  });

  it("stretches when aspect ratio is unlocked", () => {
    expect(
      calculateResizeDimensions({
        sourceWidth: 4000,
        sourceHeight: 2000,
        targetWidth: 1000,
        targetHeight: 1000,
        fitMode: "contain",
        lockAspectRatio: false,
      }),
    ).toEqual({ width: 1000, height: 1000 });
  });

  it("limits compression dimensions without upscaling", () => {
    expect(calculateCompressedDimensions(4000, 2000, 1000)).toEqual({
      width: 1000,
      height: 500,
    });
    expect(calculateCompressedDimensions(600, 400, 1000)).toEqual({
      width: 600,
      height: 400,
    });
  });

  it("creates predictable output filenames", () => {
    expect(createOutputFilename("My Large Photo.JPG", "resize", "image/webp")).toBe(
      "my-large-photo-resize.webp",
    );
  });

  it("maps MIME types to extensions", () => {
    expect(mimeToExtension("image/png")).toBe("png");
    expect(mimeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeToExtension("image/webp")).toBe("webp");
  });

  it("clamps invalid quality values", () => {
    expect(clampQuality(2)).toBe(1);
    expect(clampQuality(-1)).toBe(0.05);
    expect(clampQuality(Number.NaN)).toBe(0.82);
  });

  it("normalizes crop bounds", () => {
    expect(
      normalizeCropOptions(
        {
          x: -20,
          y: 10,
          width: 1000,
          height: 1000,
          mimeType: "image/png",
          quality: 1.5,
        },
        400,
        300,
      ),
    ).toEqual({
      x: 0,
      y: 10,
      width: 400,
      height: 290,
      mimeType: "image/png",
      quality: 1,
    });
  });

  it("creates centered aspect crops", () => {
    expect(createCenteredCrop(1600, 900, 1, "image/png", 0.9)).toMatchObject({
      x: 350,
      y: 0,
      width: 900,
      height: 900,
    });
  });
});
