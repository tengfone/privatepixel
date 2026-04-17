import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalObjectSelectionRuntime,
  cutOutObject,
  type ObjectSelectionMask,
} from "./localObjectSelection";

function mask(data: number[]): ObjectSelectionMask {
  return {
    data: new Uint8ClampedArray(data),
    width: data.length,
    height: 1,
  };
}

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

beforeEach(() => {
  vi.stubGlobal("ImageData", TestImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local object selection", () => {
  it("cuts out source pixels with a synthetic object mask", () => {
    const source = new ImageData(
      new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]),
      2,
      1,
    );

    expect(Array.from(cutOutObject(source, mask([255, 128])).data)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 64,
    ]);
  });

  it("runs segmentation before creating a cutout", async () => {
    const calls: string[] = [];
    const source = new ImageData(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1);
    const runtime = createLocalObjectSelectionRuntime({
      segmentObject: vi.fn(async (_source, point, onProgress) => {
        calls.push(`${point.x},${point.y}`);
        onProgress?.(54, "Finding object boundary");
        return mask([255]);
      }),
    });
    const messages: string[] = [];

    const result = await runtime.cutOut(source, {
      point: { x: 0.25, y: 0.75 },
      onProgress: (_progress, message) => messages.push(message),
    });

    expect(calls).toEqual(["0.25,0.75"]);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Finding object boundary",
        "Cutting out selected object",
      ]),
    );
    expect(Array.from(result.data)).toEqual([10, 20, 30, 255]);
  });
});
