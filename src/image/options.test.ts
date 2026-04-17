import { describe, expect, it } from "vitest";
import {
  RESIZE_PRESETS,
  applyResizePreset,
  calculateCompressedDimensions,
  calculateResizeDimensions,
  calculateRotatedDimensions,
  clampQuality,
  createCenteredCrop,
  createDefaultRemoveBackgroundOptions,
  createDefaultResizeOptions,
  createObjectSelectOptions,
  createOutputFilename,
  getDefaultOutputMime,
  mimeToExtension,
  normalizeCropOptions,
  normalizeRotationDegrees,
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

  it("returns exact target dimensions for cover fit", () => {
    expect(
      calculateResizeDimensions({
        sourceWidth: 4000,
        sourceHeight: 2000,
        targetWidth: 1000,
        targetHeight: 1000,
        fitMode: "cover",
        lockAspectRatio: true,
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
    expect(mimeToExtension("image/avif")).toBe("avif");
    expect(mimeToExtension("image/svg+xml")).toBe("svg");
  });

  it("clamps invalid quality values", () => {
    expect(clampQuality(2)).toBe(1);
    expect(clampQuality(-1)).toBe(0.05);
    expect(clampQuality(Number.NaN)).toBe(0.82);
  });

  it("normalizes rotation degrees to a stable editing range", () => {
    expect(normalizeRotationDegrees(450)).toBe(90);
    expect(normalizeRotationDegrees(-270)).toBe(90);
    expect(normalizeRotationDegrees(Number.NaN)).toBe(0);
  });

  it("calculates rotated crop source dimensions", () => {
    expect(calculateRotatedDimensions(400, 300, 0)).toEqual({
      width: 400,
      height: 300,
    });
    expect(calculateRotatedDimensions(400, 300, 90)).toEqual({
      width: 300,
      height: 400,
    });
  });

  it("normalizes crop bounds", () => {
    expect(
      normalizeCropOptions(
        {
          x: -20,
          y: 10,
          width: 1000,
          height: 1000,
          rotation: 450,
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
      rotation: 90,
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

  it("uses the original supported MIME type for resize output defaults", () => {
    expect(
      createDefaultResizeOptions({
        id: "asset-1",
        file: new File([], "photo.jpg", { type: "image/jpeg" }),
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 0,
        width: 1600,
        height: 900,
        previewUrl: "blob:photo",
      }),
    ).toMatchObject({
      width: 1600,
      height: 900,
      cropAnchorX: 0.5,
      cropAnchorY: 0.5,
      mimeType: "image/jpeg",
      quality: 0.92,
    });
    expect(getDefaultOutputMime({ mimeType: "image/gif" } as never)).toBe("image/png");
  });

  it("applies common resize presets without changing output format", () => {
    const preset = RESIZE_PRESETS.find((candidate) => candidate.id === "slack-avatar");

    expect(preset).toBeDefined();
    expect(
      applyResizePreset(
        {
          width: 400,
          height: 300,
          fitMode: "contain",
          lockAspectRatio: false,
          cropAnchorX: 0.25,
          cropAnchorY: 0.75,
          mimeType: "image/avif",
          quality: 0.6,
        },
        preset!,
      ),
    ).toEqual({
      width: 1024,
      height: 1024,
      fitMode: "cover",
      lockAspectRatio: true,
      cropAnchorX: 0.25,
      cropAnchorY: 0.75,
      mimeType: "image/avif",
      quality: 0.6,
    });
  });

  it("includes current high-use social resize presets", () => {
    expect(
      RESIZE_PRESETS.map((preset) => [preset.id, preset.width, preset.height]),
    ).toEqual(
      expect.arrayContaining([
        ["youtube-thumbnail", 3840, 2160],
        ["instagram-feed-portrait", 1080, 1350],
        ["vertical-story", 1080, 1920],
        ["linkedin-post", 1200, 627],
        ["x-header", 1500, 500],
        ["pinterest-pin", 1000, 1500],
      ]),
    );
  });

  it("defaults background removal to auto PNG output", () => {
    expect(createDefaultRemoveBackgroundOptions()).toEqual({
      outputMimeType: "image/png",
      mode: "auto",
    });
  });

  it("serializes background removal mode options for worker requests", () => {
    const options = {
      ...createDefaultRemoveBackgroundOptions(),
      mode: "general" as const,
    };

    expect(JSON.parse(JSON.stringify(options))).toEqual({
      outputMimeType: "image/png",
      mode: "general",
    });
  });

  it("serializes object selection click options for worker requests", () => {
    expect(
      JSON.parse(
        JSON.stringify(createObjectSelectOptions({ x: 1.2, y: -0.1 }, "mask")),
      ),
    ).toEqual({
      outputMimeType: "image/png",
      action: "mask",
      point: {
        x: 1,
        y: 0,
      },
    });
  });
});
