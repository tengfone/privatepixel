import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocalBackgroundRemovalRuntime } from "../features/background-removal/localBackgroundRemoval";
import { loadLocalObjectSelectionRuntime } from "../features/object-selection/localObjectSelection";
import type { ImageJobRequest } from "../image/types";
import { processObjectSelect, processRemoveBackground } from "./image.worker";

vi.mock("../features/background-removal/localBackgroundRemoval", () => ({
  loadLocalBackgroundRemovalRuntime: vi.fn(),
}));

vi.mock("../features/object-selection/localObjectSelection", () => ({
  loadLocalObjectSelectionRuntime: vi.fn(),
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
        width: 2,
        height: 1,
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
        message: "Preparing image pixels for local background removal",
      }),
    );
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 26,
        message: "Starting background-removal runtime",
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
        message: "Encoding transparent PNG locally",
      }),
    );
  });

  it("uses the mocked object selector to produce a PNG and progress messages", async () => {
    const cutOut = vi.fn(async () => {
      return new ImageData(
        new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 0]),
        2,
        1,
      );
    });
    vi.mocked(loadLocalObjectSelectionRuntime).mockResolvedValue({
      createMask: vi.fn(),
      createOverlay: vi.fn(),
      cutOut: async (source, options) => {
        expect(source.width).toBe(2);
        expect(options.point).toEqual({ x: 0.25, y: 0.75 });
        options.onProgress?.(54, "Mocked object selector");
        return cutOut();
      },
    });

    const request: ImageJobRequest = {
      jobId: "job-2",
      assetId: "asset-2",
      source: {
        name: "mug.png",
        mimeType: "image/png",
        size: 2,
        width: 2,
        height: 1,
        buffer: new ArrayBuffer(2),
      },
      operation: {
        type: "object-select",
        options: {
          outputMimeType: "image/png",
          action: "cutout",
          point: { x: 0.25, y: 0.75 },
        },
      },
    };

    const result = await processObjectSelect(request, {
      width: 2,
      height: 1,
    } as ImageBitmap);

    expect(result.mimeType).toBe("image/png");
    expect(result.blob.type).toBe("image/png");
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(cutOut).toHaveBeenCalledTimes(1);
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 24,
        message: "Preparing image for local object selection",
      }),
    );
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 54,
        message: "Mocked object selector",
      }),
    );
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: 92,
        message: "Encoding selected object",
      }),
    );
  });
});
