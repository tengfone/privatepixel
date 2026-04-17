import type {
  InteractiveSegmenter as InteractiveSegmenterType,
  InteractiveSegmenterResult,
  MPMask,
} from "@mediapipe/tasks-vision";
import type { ObjectSelectPoint } from "../../image/types";

export interface ObjectSelectionMask {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface LocalObjectSelectionProgress {
  (progress: number, message: string): void;
}

export interface LocalObjectSelectionRequest {
  point: ObjectSelectPoint;
  onProgress?: LocalObjectSelectionProgress;
  throwIfCanceled?: () => void;
}

export interface LocalObjectSelectionRuntime {
  createMask(
    source: ImageData,
    options: LocalObjectSelectionRequest,
  ): Promise<ObjectSelectionMask>;
  createOverlay(
    source: ImageData,
    options: LocalObjectSelectionRequest,
  ): Promise<ImageData>;
  cutOut(source: ImageData, options: LocalObjectSelectionRequest): Promise<ImageData>;
}

interface MediaPipeModuleWorkerGlobal {
  import?: (url: string) => Promise<unknown>;
  ModuleFactory?: unknown;
}

interface ObjectSelectionRuntimeDependencies {
  segmentObject: (
    source: ImageData,
    point: ObjectSelectPoint,
    onProgress?: LocalObjectSelectionProgress,
  ) => Promise<ObjectSelectionMask>;
}

let segmenterPromise: Promise<InteractiveSegmenterType> | null = null;

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function installMediaPipeModuleImportPolyfill(): void {
  const scope = globalThis as unknown as MediaPipeModuleWorkerGlobal;
  const allowedRoot = new URL(
    assetUrl("vendor/mediapipe/tasks-vision/wasm/"),
    globalThis.location.href,
  );
  scope.import ??= async (url: string) => {
    const scriptUrl = new URL(url, globalThis.location.href);
    if (
      scriptUrl.origin !== allowedRoot.origin ||
      !scriptUrl.pathname.startsWith(allowedRoot.pathname)
    ) {
      throw new Error("Blocked unexpected MediaPipe loader import.");
    }

    const response = await fetch(scriptUrl, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Could not load MediaPipe module: ${response.status}`);
    }

    const source = `${await response.text()}\n;globalThis.ModuleFactory = ModuleFactory;`;
    (0, eval)(source);
    return scope.ModuleFactory;
  };
}

function imageDataToCanvas(source: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d", {
    alpha: true,
    colorSpace: "srgb",
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error("Could not create a local object-selection canvas.");
  }

  context.putImageData(source, 0, 0);
  return canvas;
}

async function loadInteractiveSegmenter(
  onProgress?: LocalObjectSelectionProgress,
): Promise<InteractiveSegmenterType> {
  const cached = segmenterPromise;
  if (cached) {
    onProgress?.(36, "Using cached local object selector");
    return cached;
  }

  segmenterPromise = import("@mediapipe/tasks-vision").then(
    async ({ FilesetResolver, InteractiveSegmenter }) => {
      installMediaPipeModuleImportPolyfill();
      onProgress?.(34, "Loading local object selector");
      const vision = await FilesetResolver.forVisionTasks(
        assetUrl("vendor/mediapipe/tasks-vision/wasm"),
      );

      return InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl(
            "models/mediapipe/interactive_segmenter/ptm_512_hdt_ptm_woid.tflite",
          ),
        },
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    },
  );

  segmenterPromise.catch(() => {
    segmenterPromise = null;
  });
  return segmenterPromise;
}

function floatMaskToAlphaMask(mask: MPMask): ObjectSelectionMask {
  const data = mask.getAsFloat32Array();
  const alpha = new Uint8ClampedArray(data.length);

  for (let index = 0; index < data.length; index += 1) {
    alpha[index] = Math.round(clampUnit(data[index]) * 255);
  }

  return {
    data: alpha,
    width: mask.width,
    height: mask.height,
  };
}

function categoryMaskToAlphaMask(mask: MPMask): ObjectSelectionMask {
  const data = mask.getAsUint8Array();
  const alpha = new Uint8ClampedArray(data.length);

  for (let index = 0; index < data.length; index += 1) {
    alpha[index] = data[index] > 0 ? 255 : 0;
  }

  return {
    data: alpha,
    width: mask.width,
    height: mask.height,
  };
}

function resultToMask(result: InteractiveSegmenterResult): ObjectSelectionMask {
  const confidenceMask = result.confidenceMasks?.[0];
  if (confidenceMask) {
    return floatMaskToAlphaMask(confidenceMask);
  }

  if (result.categoryMask) {
    return categoryMaskToAlphaMask(result.categoryMask);
  }

  throw new Error("No object mask was returned for that click.");
}

async function segmentObjectWithMediaPipe(
  source: ImageData,
  point: ObjectSelectPoint,
  onProgress?: LocalObjectSelectionProgress,
): Promise<ObjectSelectionMask> {
  onProgress?.(28, "Reading click position");
  const segmenter = await loadInteractiveSegmenter(onProgress);
  onProgress?.(54, "Finding object boundary");
  const result = segmenter.segment(imageDataToCanvas(source), {
    keypoint: {
      x: clampUnit(point.x),
      y: clampUnit(point.y),
    },
  });

  try {
    onProgress?.(74, "Preparing selection mask");
    return normalizeMaskSize(resultToMask(result), source.width, source.height);
  } finally {
    result.close();
  }
}

export function normalizeMaskSize(
  mask: ObjectSelectionMask,
  width: number,
  height: number,
): ObjectSelectionMask {
  if (mask.width === width && mask.height === height) {
    return mask;
  }

  const sourceCanvas = new OffscreenCanvas(mask.width, mask.height);
  const sourceContext = sourceCanvas.getContext("2d");
  const targetCanvas = new OffscreenCanvas(width, height);
  const targetContext = targetCanvas.getContext("2d", { willReadFrequently: true });

  if (!sourceContext || !targetContext) {
    throw new Error("Could not resize the object-selection mask.");
  }

  const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let index = 0; index < mask.data.length; index += 1) {
    const alpha = mask.data[index];
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = alpha;
    rgba[rgbaIndex + 1] = alpha;
    rgba[rgbaIndex + 2] = alpha;
    rgba[rgbaIndex + 3] = 255;
  }

  sourceContext.putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(sourceCanvas, 0, 0, width, height);
  const resized = targetContext.getImageData(0, 0, width, height);
  const alpha = new Uint8ClampedArray(width * height);

  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = resized.data[index * 4];
  }

  return {
    data: alpha,
    width,
    height,
  };
}

export function createSelectionOverlay(
  source: ImageData,
  mask: ObjectSelectionMask,
): ImageData {
  const normalized = normalizeMaskSize(mask, source.width, source.height);
  const result = new Uint8ClampedArray(source.data.length);

  for (let pixelIndex = 0; pixelIndex < normalized.data.length; pixelIndex += 1) {
    const alpha = normalized.data[pixelIndex];
    if (alpha <= 8) {
      continue;
    }

    const resultIndex = pixelIndex * 4;
    result[resultIndex] = 18;
    result[resultIndex + 1] = 168;
    result[resultIndex + 2] = 116;
    result[resultIndex + 3] = Math.min(170, Math.max(56, Math.round(alpha * 0.62)));
  }

  return new ImageData(result, source.width, source.height);
}

export function cutOutObject(source: ImageData, mask: ObjectSelectionMask): ImageData {
  const normalized = normalizeMaskSize(mask, source.width, source.height);
  const result = new Uint8ClampedArray(source.data.length);

  for (let pixelIndex = 0; pixelIndex < normalized.data.length; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    const maskAlpha = normalized.data[pixelIndex];
    result[sourceIndex] = source.data[sourceIndex];
    result[sourceIndex + 1] = source.data[sourceIndex + 1];
    result[sourceIndex + 2] = source.data[sourceIndex + 2];
    result[sourceIndex + 3] = Math.round(
      (source.data[sourceIndex + 3] * maskAlpha) / 255,
    );
  }

  return new ImageData(result, source.width, source.height);
}

export function createLocalObjectSelectionRuntime({
  segmentObject,
}: ObjectSelectionRuntimeDependencies): LocalObjectSelectionRuntime {
  async function createMask(
    source: ImageData,
    { point, onProgress, throwIfCanceled }: LocalObjectSelectionRequest,
  ): Promise<ObjectSelectionMask> {
    throwIfCanceled?.();
    const mask = await segmentObject(source, point, onProgress);
    throwIfCanceled?.();
    return mask;
  }

  return {
    async createOverlay(source, options) {
      const mask = await createMask(source, options);
      options.throwIfCanceled?.();
      options.onProgress?.(86, "Highlighting selected object");
      return createSelectionOverlay(source, mask);
    },
    async cutOut(source, options) {
      const mask = await createMask(source, options);
      options.throwIfCanceled?.();
      options.onProgress?.(86, "Cutting out selected object");
      return cutOutObject(source, mask);
    },
    createMask,
  };
}

export async function loadLocalObjectSelectionRuntime(): Promise<LocalObjectSelectionRuntime> {
  return createLocalObjectSelectionRuntime({
    segmentObject: segmentObjectWithMediaPipe,
  });
}
