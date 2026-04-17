import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseBestAlphaMask,
  composeImageWithAlphaMask,
  createLocalBackgroundRemovalRuntime,
  getFallbackModel,
  selectPrimaryModel,
  type AlphaMask,
  type BackgroundRemovalModel,
} from "./localBackgroundRemoval";

function mask(data: number[]): AlphaMask {
  return {
    data: new Uint8ClampedArray(data),
    width: data.length,
    height: 1,
    channels: 1,
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

describe("local background removal routing", () => {
  it("routes explicit portrait and general modes to their models", () => {
    expect(selectPrimaryModel("portrait", false)).toBe("modnet");
    expect(selectPrimaryModel("portrait", true)).toBe("modnet");
    expect(selectPrimaryModel("general", false)).toBe("rmbg");
    expect(selectPrimaryModel("general", true)).toBe("rmbg");
  });

  it("routes auto mode by face detection result", () => {
    expect(selectPrimaryModel("auto", true)).toBe("modnet");
    expect(selectPrimaryModel("auto", false)).toBe("rmbg");
  });

  it("uses the opposite model as the fallback", () => {
    expect(getFallbackModel("modnet")).toBe("rmbg");
    expect(getFallbackModel("rmbg")).toBe("modnet");
  });

  it("runs the primary model before the fallback for best mode", async () => {
    const calls: BackgroundRemovalModel[] = [];
    const source = new ImageData(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
      2,
      1,
    );
    const runtime = createLocalBackgroundRemovalRuntime({
      detectFace: vi.fn(async () => true),
      runModel: vi.fn(async (_source, model) => {
        calls.push(model);
        return model === "modnet" ? mask([255, 255]) : mask([0, 255]);
      }),
    });

    const result = await runtime.removeBackground(source, { mode: "best" });

    expect(calls).toEqual(["modnet", "rmbg"]);
    expect(Array.from(result.data)).toEqual([255, 0, 0, 0, 0, 255, 0, 255]);
  });

  it("emits readable routing progress for auto mode", async () => {
    const messages: string[] = [];
    const source = new ImageData(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    const runtime = createLocalBackgroundRemovalRuntime({
      detectFace: vi.fn(async () => false),
      runModel: vi.fn(async () => mask([255])),
    });

    await runtime.removeBackground(source, {
      mode: "auto",
      onProgress: (_progress, message) => messages.push(message),
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        "Choosing local background-removal route",
        "Auto mode: checking faces locally",
        "No face detected; starting with the general object model",
        "Selected RMBG-1.4 general model",
        "Applying alpha mask to source image",
      ]),
    );
  });

  it("keeps best mode progress monotonic while trying the fallback", async () => {
    const progressValues: number[] = [];
    const source = new ImageData(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    const runtime = createLocalBackgroundRemovalRuntime({
      detectFace: vi.fn(async () => true),
      runModel: vi.fn(async (_source, _model, onProgress) => {
        onProgress?.(40, "Loading mocked model");
        onProgress?.(78, "Refining mocked mask");
        return mask([255]);
      }),
    });

    await runtime.removeBackground(source, {
      mode: "best",
      onProgress: (progress) => progressValues.push(progress),
    });

    expect(progressValues).toEqual([...progressValues].sort((a, b) => a - b));
  });
});

describe("local background removal mask helpers", () => {
  it("composes source pixels with a synthetic alpha mask", () => {
    const source = new ImageData(
      new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]),
      2,
      1,
    );

    expect(
      Array.from(composeImageWithAlphaMask(source, mask([255, 128])).data),
    ).toEqual([10, 20, 30, 255, 40, 50, 60, 64]);
  });

  it("prefers a non-pathological fallback mask", () => {
    expect(chooseBestAlphaMask(mask([255, 255, 255]), mask([0, 128, 255]))).toEqual(
      mask([0, 128, 255]),
    );
  });
});
