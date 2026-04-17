import {
  calculateCompressedDimensions,
  calculateResizeDimensions,
  clampQuality,
  createOutputFilename,
  normalizeCropOptions,
} from "../image/options";
import createPica from "pica";
import type {
  ImageJobFailure,
  ImageJobProgress,
  ImageJobRequest,
  ImageJobSuccess,
  ImageWorkerInbound,
  ImageWorkerOutbound,
  OutputMimeType,
} from "../image/types";
import { loadPrivatePixelCore } from "../wasm/privatepixelCore";
import { JobCanceledError, JobCancellationRegistry } from "./jobState";

const cancellationRegistry = new JobCancellationRegistry();
const highQualityResizer = createPica({
  features: ["js", "wasm"],
  tile: 1024,
});

function post(message: ImageWorkerOutbound): void {
  self.postMessage(message);
}

function postProgress(
  request: ImageJobRequest,
  progress: number,
  message: string,
): void {
  const event: ImageJobProgress = {
    type: "progress",
    jobId: request.jobId,
    assetId: request.assetId,
    progress,
    message,
  };
  post(event);
}

async function createBitmap(source: ImageJobRequest["source"]): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([source.buffer], { type: source.mimeType }));
}

function getContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", {
    alpha: true,
    colorSpace: "srgb",
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error("Could not create an offscreen canvas context.");
  }

  return context;
}

async function resizeBitmapToCanvas(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<OffscreenCanvas> {
  const sourceCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const sourceContext = getContext(sourceCanvas);
  sourceContext.drawImage(bitmap, 0, 0);
  const sourceImage = sourceContext.getImageData(0, 0, bitmap.width, bitmap.height);
  const sourceBuffer = new Uint8Array(
    sourceImage.data.buffer,
    sourceImage.data.byteOffset,
    sourceImage.data.byteLength,
  );

  try {
    const resized = await highQualityResizer.resizeBuffer({
      src: sourceBuffer,
      width: bitmap.width,
      height: bitmap.height,
      toWidth: width,
      toHeight: height,
      filter: "mks2013",
      unsharpAmount: 120,
      unsharpRadius: 0.6,
      unsharpThreshold: 1,
    });
    return rgbaToCanvas(resized, width, height);
  } catch {
    const wasm = await loadPrivatePixelCore();
    if (wasm) {
      const resized = wasm.resize_rgba(
        sourceBuffer,
        bitmap.width,
        bitmap.height,
        width,
        height,
      );
      return rgbaToCanvas(resized, width, height);
    }
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = getContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function rgbaToCanvas(
  buffer: Uint8Array,
  width: number,
  height: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = getContext(canvas);
  context.putImageData(
    new ImageData(new Uint8ClampedArray(buffer), width, height),
    0,
    0,
  );
  return canvas;
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  mimeType: OutputMimeType,
  quality: number,
): Promise<Blob> {
  const blob = await canvas.convertToBlob({
    type: mimeType,
    quality: clampQuality(quality),
  });

  if (!blob.size) {
    throw new Error("Browser image encoder returned an empty file.");
  }

  return blob;
}

async function processResize(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "resize") {
    throw new Error("Invalid resize operation.");
  }

  const options = request.operation.options;
  const dimensions = calculateResizeDimensions({
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    targetWidth: options.width,
    targetHeight: options.height,
    fitMode: options.fitMode,
    lockAspectRatio: options.lockAspectRatio,
  });

  postProgress(request, 45, "Resizing with high-quality local filters");
  const canvas = await resizeBitmapToCanvas(
    bitmap,
    dimensions.width,
    dimensions.height,
  );

  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, options.mimeType, options.quality),
    width: dimensions.width,
    height: dimensions.height,
    mimeType: options.mimeType,
  };
}

async function processCompress(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "compress") {
    throw new Error("Invalid compress operation.");
  }

  const options = request.operation.options;
  const dimensions = calculateCompressedDimensions(
    bitmap.width,
    bitmap.height,
    options.maxDimension,
  );

  postProgress(request, 55, "Compressing with high-quality downscale");
  const canvas =
    dimensions.width === bitmap.width && dimensions.height === bitmap.height
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : await resizeBitmapToCanvas(bitmap, dimensions.width, dimensions.height);

  if (dimensions.width === bitmap.width && dimensions.height === bitmap.height) {
    const context = getContext(canvas);
    context.drawImage(bitmap, 0, 0);
  }

  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, options.mimeType, options.quality),
    width: dimensions.width,
    height: dimensions.height,
    mimeType: options.mimeType,
  };
}

async function processConvert(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "convert") {
    throw new Error("Invalid convert operation.");
  }

  const options = request.operation.options;
  postProgress(request, 55, "Converting locally");

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = getContext(canvas);
  context.drawImage(bitmap, 0, 0);

  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, options.mimeType, options.quality),
    width: bitmap.width,
    height: bitmap.height,
    mimeType: options.mimeType,
  };
}

async function processCrop(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "crop") {
    throw new Error("Invalid crop operation.");
  }

  const options = normalizeCropOptions(
    request.operation.options,
    bitmap.width,
    bitmap.height,
  );

  postProgress(request, 55, "Cropping locally");

  const canvas = new OffscreenCanvas(options.width, options.height);
  const context = getContext(canvas);
  context.drawImage(
    bitmap,
    options.x,
    options.y,
    options.width,
    options.height,
    0,
    0,
    options.width,
    options.height,
  );

  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, options.mimeType, options.quality),
    width: options.width,
    height: options.height,
    mimeType: options.mimeType,
  };
}

async function processRemoveBackground(): Promise<never> {
  await import("../features/background-removal/localBackgroundRemoval");
  throw new Error(
    "Local background removal model assets are not bundled yet. The runtime is intentionally lazy-loaded.",
  );
}

async function processRequest(request: ImageJobRequest): Promise<void> {
  const startedAt = performance.now();
  let bitmap: ImageBitmap | undefined;

  try {
    cancellationRegistry.clear(request.jobId);
    postProgress(request, 5, "Reading image");
    cancellationRegistry.throwIfCanceled(request.jobId);

    bitmap = await createBitmap(request.source);
    cancellationRegistry.throwIfCanceled(request.jobId);

    postProgress(request, 20, "Decoded locally");

    const processed =
      request.operation.type === "resize"
        ? await processResize(request, bitmap)
        : request.operation.type === "compress"
          ? await processCompress(request, bitmap)
          : request.operation.type === "convert"
            ? await processConvert(request, bitmap)
            : request.operation.type === "crop"
              ? await processCrop(request, bitmap)
              : await processRemoveBackground();

    cancellationRegistry.throwIfCanceled(request.jobId);

    const success: ImageJobSuccess = {
      type: "success",
      jobId: request.jobId,
      assetId: request.assetId,
      status: "success",
      blob: processed.blob,
      mimeType: processed.mimeType,
      size: processed.blob.size,
      width: processed.width,
      height: processed.height,
      filename: createOutputFilename(
        request.source.name,
        request.operation.type,
        processed.mimeType,
      ),
      durationMs: Math.round(performance.now() - startedAt),
    };

    postProgress(request, 100, "Done");
    post(success);
  } catch (error) {
    if (error instanceof JobCanceledError) {
      return;
    }

    const failure: ImageJobFailure = {
      type: "failure",
      jobId: request.jobId,
      assetId: request.assetId,
      status: "failure",
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "Image processing failed.",
    };
    post(failure);
  } finally {
    bitmap?.close();
    cancellationRegistry.clear(request.jobId);
  }
}

self.addEventListener("message", (event: MessageEvent<ImageWorkerInbound>) => {
  const message = event.data;

  if (message.type === "cancel") {
    cancellationRegistry.cancel(message.jobId);
    return;
  }

  void processRequest(message.request);
});
