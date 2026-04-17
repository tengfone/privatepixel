import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocalBackgroundRemovalRuntime } from "../features/background-removal/localBackgroundRemoval";
import type { ImageJobRequest } from "../image/types";
import { processRemoveBackground } from "./image.worker";

vi.mock("../features/background-removal/localBackgroundRemoval", () => ({
  loadLocalBackgroundRemovalRuntime: vi.fn(),
}));

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace: PredefinedColorSpace = "srgb";

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  private image?: ImageData;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(): Partial<OffscreenCanvasRenderingContext2D> {
    return {
      drawImage: vi.fn(),
      getImageData: () =>
        new ImageData(
          new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]),
          this.width,
          this.height,
        ),
      putImageData: (image: ImageData) => {
        this.image = image;
      },
    };
  }

  async convertToBlob({ type }: { type: string }): Promise<Blob> {
    return new Blob([this.image?.data ?? new Uint8ClampedArray([1])], { type });
  }
}

describe("image worker background removal", () => {
  beforeEach(() => {
    vi.stubGlobal("ImageData", TestImageData);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("postMessage", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the mocked local runtime to produce a PNG and progress messages", async () => {
    const removeBackground = vi.fn(async () => {
      return new ImageData(
        new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 0]),
        2,
        1,
      );
    });
    vi.mocked(loadLocalBackgroundRemovalRuntime).mockResolvedValue({
      removeBackground: async (source, options) => {
        expect(options.mode).toBe("general");
        options.onProgress?.(55, "Mocked background model");
        return removeBackground();
      },
    });

    const request: ImageJobRequest = {
      jobId: "job-1",
      assetId: "asset-1",
      source: {
        name: "shoe.png",
        mimeType: "image/png",
        size: 2,
        buffer: new ArrayBuffer(2),
      },
      operation: {
        type: "remove-background",
        options: {
          outputMimeType: "image/png",
          mode: "general",
        },
      },
    };

    const result = await processRemoveBackground(request, {
      width: 2,
      height: 1,
    } as ImageBitmap);

    expect(result.mimeType).toBe("image/png");
    expect(result.blob.type).toBe("image/png");
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(removeBackground).toHaveBeenCalledTimes(1);
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 24,
        message: "Preparing transparent cutout",
      }),
    );
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 55,
        message: "Mocked background model",
      }),
    );
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 92,
        message: "Encoding transparent PNG",
      }),
    );
  });
});
