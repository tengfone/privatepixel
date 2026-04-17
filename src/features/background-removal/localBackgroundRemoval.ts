import type {
  DeviceType,
  RawImage as RawImageType,
  Tensor,
} from "@huggingface/transformers";
import type {
  FaceDetector as FaceDetectorType,
  FaceDetectorResult,
} from "@mediapipe/tasks-vision";
import type { RemoveBackgroundMode } from "../../image/types";

export type BackgroundRemovalModel = "modnet" | "rmbg";

export interface AlphaMask {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  channels: 1 | 4;
  model?: BackgroundRemovalModel;
}

export interface LocalBackgroundRemovalProgress {
  (progress: number, message: string): void;
}

export interface LocalBackgroundRemovalRequest {
  mode: RemoveBackgroundMode;
  onProgress?: LocalBackgroundRemovalProgress;
  throwIfCanceled?: () => void;
}

export interface LocalBackgroundRemovalRuntime {
  removeBackground(
    source: ImageData,
    options: LocalBackgroundRemovalRequest,
  ): Promise<ImageData>;
}

interface LoadedBackgroundModel {
  model: {
    sessions?: {
      model?: {
        inputNames: string[];
        outputNames: string[];
      };
    };
    (inputs: Record<string, unknown>): Promise<Record<string, Tensor>>;
  };
  processor: (image: RawImageType) => Promise<Record<string, unknown>>;
  RawImage: RawImageConstructor;
  device: DeviceType;
}

type RawImageConstructor = {
  new (
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
  ): RawImageType;
  fromTensor(tensor: Tensor, channelFormat?: string): RawImageType;
};

interface BackgroundRemovalRuntimeDependencies {
  detectFace: (
    source: ImageData,
    onProgress?: LocalBackgroundRemovalProgress,
  ) => Promise<boolean>;
  runModel: (
    source: ImageData,
    model: BackgroundRemovalModel,
    onProgress?: LocalBackgroundRemovalProgress,
  ) => Promise<AlphaMask>;
}

const MODEL_IDS: Record<BackgroundRemovalModel, string> = {
  modnet: "Xenova/modnet",
  rmbg: "briaai/RMBG-1.4",
};

const MODEL_LABELS: Record<BackgroundRemovalModel, string> = {
  modnet: "MODNet",
  rmbg: "RMBG-1.4",
};

const MODEL_DESCRIPTIONS: Record<BackgroundRemovalModel, string> = {
  modnet: "MODNet portrait model",
  rmbg: "RMBG-1.4 general model",
};

const MODEL_LOAD_PROGRESS: Record<BackgroundRemovalModel, number> = {
  modnet: 42,
  rmbg: 44,
};

function modelLoadProgress(
  modelKey: BackgroundRemovalModel,
  device: DeviceType,
): number {
  if (modelKey === "rmbg" && device === "wasm") {
    return 46;
  }

  return MODEL_LOAD_PROGRESS[modelKey];
}

interface MediaPipeModuleWorkerGlobal {
  import?: (url: string) => Promise<unknown>;
  ModuleFactory?: unknown;
}

let transformersPromise: Promise<typeof import("@huggingface/transformers")> | null =
  null;
let faceDetectorPromise: Promise<FaceDetectorType> | null = null;
const modelPromises = new Map<string, Promise<LoadedBackgroundModel>>();

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

async function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  transformersPromise ??= import("@huggingface/transformers").then((module) => {
    module.env.allowRemoteModels = false;
    module.env.allowLocalModels = true;
    module.env.localModelPath = assetUrl("models/");
    module.env.logLevel = module.LogLevel.ERROR;
    module.env.useBrowserCache = true;
    module.env.useWasmCache = true;

    const onnxEnv = module.env.backends.onnx as {
      wasm?: {
        wasmPaths?: { mjs: string; wasm: string };
        numThreads?: number;
        proxy?: boolean;
      };
    };
    onnxEnv.wasm ??= {};
    onnxEnv.wasm.wasmPaths = {
      mjs: assetUrl("vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"),
      wasm: assetUrl("vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"),
    };
    onnxEnv.wasm.numThreads = 1;
    onnxEnv.wasm.proxy = false;

    return module;
  });

  return transformersPromise;
}

function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
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

    // MediaPipe's fallback calls self.import() from module workers after
    // importScripts() fails. Its classic loader must run as a classic script,
    // not as ESM, because the generated file relies on script-scope globals.
    const source = `${await response.text()}\n;globalThis.ModuleFactory = ModuleFactory;`;
    (0, eval)(source);
    return scope.ModuleFactory;
  };
}

async function loadBackgroundModelOnDevice(
  modelKey: BackgroundRemovalModel,
  device: DeviceType,
  onProgress?: LocalBackgroundRemovalProgress,
): Promise<LoadedBackgroundModel> {
  const cacheKey = `${modelKey}:${device}`;
  const cached = modelPromises.get(cacheKey);
  if (cached) {
    onProgress?.(
      modelLoadProgress(modelKey, device),
      `Using cached local ${MODEL_DESCRIPTIONS[modelKey]}`,
    );
    return cached;
  }

  const promise = (async () => {
    const transformers = await loadTransformers();
    onProgress?.(
      modelLoadProgress(modelKey, device),
      `Loading ${MODEL_DESCRIPTIONS[modelKey]} locally`,
    );
    const [model, processor] = await Promise.all([
      transformers.AutoModel.from_pretrained(MODEL_IDS[modelKey], {
        dtype: "q8",
        device,
        local_files_only: true,
      }) as Promise<LoadedBackgroundModel["model"]>,
      transformers.AutoProcessor.from_pretrained(MODEL_IDS[modelKey], {
        local_files_only: true,
      }) as Promise<LoadedBackgroundModel["processor"]>,
    ]);

    return {
      model,
      processor,
      RawImage: transformers.RawImage,
      device,
    };
  })();

  modelPromises.set(cacheKey, promise);
  promise.catch(() => modelPromises.delete(cacheKey));
  return promise;
}

async function loadBackgroundModel(
  modelKey: BackgroundRemovalModel,
  onProgress?: LocalBackgroundRemovalProgress,
): Promise<LoadedBackgroundModel> {
  if (modelKey === "rmbg") {
    if (hasWebGpu()) {
      try {
        onProgress?.(40, "Checking WebGPU for RMBG-1.4");
        return await loadBackgroundModelOnDevice(modelKey, "webgpu", onProgress);
      } catch {
        onProgress?.(45, "WebGPU did not start; falling back to slower local WASM");
      }
    } else {
      onProgress?.(40, "Using local WASM for RMBG-1.4; first run can take a bit");
    }
  }

  if (modelKey === "modnet") {
    onProgress?.(40, "Using local WASM for MODNet portrait matting");
  }

  return loadBackgroundModelOnDevice(modelKey, "wasm", onProgress);
}

async function loadFaceDetector(): Promise<FaceDetectorType> {
  faceDetectorPromise ??= import("@mediapipe/tasks-vision").then(
    async ({ FaceDetector, FilesetResolver }) => {
      installMediaPipeModuleImportPolyfill();
      const vision = await FilesetResolver.forVisionTasks(
        assetUrl("vendor/mediapipe/tasks-vision/wasm"),
      );
      return FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl(
            "models/mediapipe/face_detector/blaze_face_short_range.tflite",
          ),
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.45,
      });
    },
  );

  return faceDetectorPromise;
}

function imageDataToCanvas(source: ImageData, maxDimension = 384): OffscreenCanvas {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
  const fullCanvas = new OffscreenCanvas(source.width, source.height);
  const fullContext = fullCanvas.getContext("2d");
  const context = canvas.getContext("2d");

  if (!fullContext || !context) {
    throw new Error("Could not create a local face-routing canvas.");
  }

  fullContext.putImageData(source, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "medium";
  context.drawImage(fullCanvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function detectFace(
  source: ImageData,
  onProgress?: LocalBackgroundRemovalProgress,
): Promise<boolean> {
  onProgress?.(31, "Loading local face detector");
  const detector = await loadFaceDetector();
  onProgress?.(33, "Scanning downscaled image for faces");
  const result: FaceDetectorResult = detector.detect(imageDataToCanvas(source));
  return result.detections.length > 0;
}

export function selectPrimaryModel(
  mode: RemoveBackgroundMode,
  hasFace: boolean,
): BackgroundRemovalModel {
  if (mode === "portrait") {
    return "modnet";
  }

  if (mode === "general") {
    return "rmbg";
  }

  return hasFace ? "modnet" : "rmbg";
}

export function getFallbackModel(
  model: BackgroundRemovalModel,
): BackgroundRemovalModel {
  return model === "modnet" ? "rmbg" : "modnet";
}

function tensorNeedsSigmoid(tensor: Tensor): boolean {
  const data = Array.from(tensor.data as Iterable<number | bigint>, Number);
  return data.some((value) => value < -0.00001 || value > 1.00001);
}

async function runBackgroundModel(
  source: ImageData,
  modelKey: BackgroundRemovalModel,
  onProgress?: LocalBackgroundRemovalProgress,
): Promise<AlphaMask> {
  const loaded = await loadBackgroundModel(modelKey, onProgress);
  onProgress?.(50, `Preprocessing image for ${MODEL_DESCRIPTIONS[modelKey]}`);
  const image = new loaded.RawImage(
    new Uint8ClampedArray(source.data),
    source.width,
    source.height,
    4,
  ).rgb();
  const inputs = await loaded.processor(image);
  const session = loaded.model.sessions?.model;

  if (
    session?.inputNames.length === 1 &&
    !session.inputNames.includes("pixel_values")
  ) {
    inputs[session.inputNames[0]] = inputs.pixel_values;
  }

  onProgress?.(
    62,
    `Running ${MODEL_LABELS[modelKey]} with ${
      loaded.device === "webgpu" ? "WebGPU" : "WASM"
    }`,
  );
  const output = await loaded.model(inputs);
  const outputName = session?.outputNames[0] ?? Object.keys(output)[0];
  let tensor = output[outputName];

  if (!tensor) {
    throw new Error(`${MODEL_LABELS[modelKey]} did not return a mask tensor.`);
  }

  if (tensor.dims[0] === 1) {
    tensor = (tensor as unknown as { [index: number]: Tensor })[0] ?? tensor;
  }

  const normalized = tensorNeedsSigmoid(tensor) ? tensor.sigmoid() : tensor;
  onProgress?.(78, `Refining ${MODEL_LABELS[modelKey]} alpha mask`);
  const mask = await loaded.RawImage.fromTensor(normalized.mul(255).to("uint8")).resize(
    source.width,
    source.height,
  );

  return {
    data: mask.data,
    width: mask.width,
    height: mask.height,
    channels: mask.channels === 4 ? 4 : 1,
    model: modelKey,
  };
}

function getMaskAlpha(mask: AlphaMask, pixelIndex: number): number {
  if (mask.channels === 4) {
    return mask.data[pixelIndex * 4 + 3];
  }

  return mask.data[pixelIndex];
}

export function composeImageWithAlphaMask(
  source: ImageData,
  mask: AlphaMask,
): ImageData {
  if (source.width !== mask.width || source.height !== mask.height) {
    throw new Error("Background mask dimensions must match the source image.");
  }

  const result = new Uint8ClampedArray(source.data.length);
  const pixelCount = source.width * source.height;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    const maskAlpha = getMaskAlpha(mask, pixelIndex);
    result[sourceIndex] = source.data[sourceIndex];
    result[sourceIndex + 1] = source.data[sourceIndex + 1];
    result[sourceIndex + 2] = source.data[sourceIndex + 2];
    result[sourceIndex + 3] = Math.round(
      (source.data[sourceIndex + 3] * maskAlpha) / 255,
    );
  }

  return new ImageData(result, source.width, source.height);
}

export function isAlphaMaskPathological(mask: AlphaMask): boolean {
  const pixelCount = mask.width * mask.height;
  let alphaSum = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    alphaSum += getMaskAlpha(mask, pixelIndex);
  }

  const coverage = alphaSum / (pixelCount * 255);
  return coverage < 0.005 || coverage > 0.995;
}

export function scoreAlphaMask(mask: AlphaMask): number {
  const pixelCount = mask.width * mask.height;
  let alphaSum = 0;
  let edgePixels = 0;
  let solidPixels = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const alpha = getMaskAlpha(mask, pixelIndex);
    alphaSum += alpha;
    if (alpha > 8 && alpha < 247) {
      edgePixels += 1;
    } else {
      solidPixels += 1;
    }
  }

  const coverage = alphaSum / (pixelCount * 255);
  if (coverage < 0.005 || coverage > 0.995) {
    return 0;
  }

  const balancedCoverage = 1 - Math.abs(coverage - 0.45);
  const edgeRatio = edgePixels / pixelCount;
  const solidRatio = solidPixels / pixelCount;
  return balancedCoverage + edgeRatio * 0.35 + solidRatio * 0.08;
}

export function chooseBestAlphaMask(first: AlphaMask, second: AlphaMask): AlphaMask {
  const firstPathological = isAlphaMaskPathological(first);
  const secondPathological = isAlphaMaskPathological(second);

  if (firstPathological && !secondPathological) {
    return second;
  }

  if (!firstPathological && secondPathological) {
    return first;
  }

  return scoreAlphaMask(second) > scoreAlphaMask(first) + 0.05 ? second : first;
}

function modelProgressWindow(
  onProgress: LocalBackgroundRemovalProgress | undefined,
  start: number,
  end: number,
): LocalBackgroundRemovalProgress | undefined {
  if (!onProgress) {
    return undefined;
  }

  return (progress, message) => {
    const normalized = Math.max(0, Math.min(1, (progress - 40) / 38));
    onProgress(Math.round(start + normalized * (end - start)), message);
  };
}

export function createLocalBackgroundRemovalRuntime({
  detectFace,
  runModel,
}: BackgroundRemovalRuntimeDependencies): LocalBackgroundRemovalRuntime {
  return {
    async removeBackground(source, { mode, onProgress, throwIfCanceled }) {
      onProgress?.(28, "Choosing local background-removal route");
      throwIfCanceled?.();
      const shouldDetectFace = mode === "auto" || mode === "best";
      if (shouldDetectFace) {
        onProgress?.(
          30,
          mode === "best"
            ? "Best result mode: checking faces for the first pass"
            : "Auto mode: checking faces locally",
        );
      } else if (mode === "portrait") {
        onProgress?.(34, "Advanced mode: portrait model selected");
      } else {
        onProgress?.(34, "Advanced mode: general object model selected");
      }

      const hasFace = shouldDetectFace ? await detectFace(source, onProgress) : false;
      const primaryModel = selectPrimaryModel(mode, hasFace);
      throwIfCanceled?.();
      if (shouldDetectFace) {
        onProgress?.(
          34,
          hasFace
            ? "Face detected; starting with the portrait model"
            : "No face detected; starting with the general object model",
        );
      }
      onProgress?.(36, `Selected ${MODEL_DESCRIPTIONS[primaryModel]}`);

      if (mode === "best") {
        onProgress?.(38, "Best result mode: running primary model first");
      }

      const primaryMask = await runModel(
        source,
        primaryModel,
        mode === "best" ? modelProgressWindow(onProgress, 40, 62) : onProgress,
      );
      throwIfCanceled?.();
      if (mode !== "best") {
        onProgress?.(84, "Applying alpha mask to source image");
        throwIfCanceled?.();
        return composeImageWithAlphaMask(source, primaryMask);
      }

      const fallbackModel = getFallbackModel(primaryModel);
      onProgress?.(
        68,
        `Primary mask done; running ${MODEL_DESCRIPTIONS[fallbackModel]} fallback`,
      );
      throwIfCanceled?.();
      const fallbackMask = await runModel(
        source,
        fallbackModel,
        modelProgressWindow(onProgress, 70, 84),
      );
      throwIfCanceled?.();
      onProgress?.(86, "Comparing masks for cleaner edges");
      onProgress?.(88, "Applying selected alpha mask to source image");
      return composeImageWithAlphaMask(
        source,
        chooseBestAlphaMask(primaryMask, fallbackMask),
      );
    },
  };
}

export async function loadLocalBackgroundRemovalRuntime(): Promise<LocalBackgroundRemovalRuntime> {
  return createLocalBackgroundRemovalRuntime({
    detectFace,
    runModel: runBackgroundModel,
  });
}
