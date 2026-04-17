import {
  calculateCompressedDimensions,
  calculateResizeDimensions,
  calculateRotatedDimensions,
  clampQuality,
  createOutputFilename,
  normalizeRotationDegrees,
  normalizeCropOptions,
} from "../image/options";
import createPica from "pica";
import { loadLocalBackgroundRemovalRuntime } from "../features/background-removal/localBackgroundRemoval";
import { loadLocalObjectSelectionRuntime } from "../features/object-selection/localObjectSelection";
import { processMetadataSource } from "../image/metadata";
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

function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = getContext(canvas);
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

function imageDataToCanvas(image: ImageData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = getContext(canvas);
  context.putImageData(image, 0, 0);
  return canvas;
}

function isUnrotated(rotation: number): boolean {
  return Math.abs(normalizeRotationDegrees(rotation)) < 0.001;
}

function drawRotatedCrop(
  context: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  crop: { x: number; y: number; width: number; height: number; rotation: number },
): void {
  const rotation = normalizeRotationDegrees(crop.rotation);
  const rotatedDimensions = calculateRotatedDimensions(
    bitmap.width,
    bitmap.height,
    rotation,
  );
  const radians = (rotation * Math.PI) / 180;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(
    rotatedDimensions.width / 2 - crop.x,
    rotatedDimensions.height / 2 - crop.y,
  );
  context.rotate(radians);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
}

async function encodeCanvas(
  canvas: OffscreenCanvas,
  mimeType: OutputMimeType,
  quality: number,
): Promise<Blob> {
  if (mimeType === "image/svg+xml") {
    return encodeCanvasAsSvg(canvas);
  }

  const blob = await canvas.convertToBlob({
    type: mimeType,
    quality: clampQuality(quality),
  });

  if (!blob.size) {
    throw new Error("Browser image encoder returned an empty file.");
  }

  if (blob.type && blob.type !== mimeType) {
    throw new Error(`${mimeType} export is not supported by this browser.`);
  }

  return blob;
}

async function encodeCanvasAsSvg(canvas: OffscreenCanvas): Promise<Blob> {
  const png = await canvas.convertToBlob({ type: "image/png" });
  const base64 = arrayBufferToBase64(await png.arrayBuffer());
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`,
    `<image width="${canvas.width}" height="${canvas.height}" href="data:image/png;base64,${base64}" />`,
    "</svg>",
  ].join("");

  return new Blob([svg], { type: "image/svg+xml" });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
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

  let canvas: OffscreenCanvas;

  if (options.lockAspectRatio && options.fitMode === "cover") {
    const coverRatio = Math.max(
      dimensions.width / bitmap.width,
      dimensions.height / bitmap.height,
    );
    const coverWidth = Math.max(1, Math.round(bitmap.width * coverRatio));
    const coverHeight = Math.max(1, Math.round(bitmap.height * coverRatio));
    const coverCanvas = await resizeBitmapToCanvas(bitmap, coverWidth, coverHeight);
    canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
    const context = getContext(canvas);
    context.drawImage(
      coverCanvas,
      Math.round((dimensions.width - coverWidth) / 2),
      Math.round((dimensions.height - coverHeight) / 2),
    );
  } else {
    canvas = await resizeBitmapToCanvas(bitmap, dimensions.width, dimensions.height);
  }

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

  const cropSourceDimensions = calculateRotatedDimensions(
    bitmap.width,
    bitmap.height,
    request.operation.options.rotation,
  );
  const options = normalizeCropOptions(
    request.operation.options,
    cropSourceDimensions.width,
    cropSourceDimensions.height,
  );

  postProgress(request, 55, "Cropping locally");

  const canvas = new OffscreenCanvas(options.width, options.height);
  const context = getContext(canvas);
  if (isUnrotated(options.rotation)) {
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
  } else {
    drawRotatedCrop(context, bitmap, options);
  }

  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, options.mimeType, options.quality),
    width: options.width,
    height: options.height,
    mimeType: options.mimeType,
  };
}

export async function processRemoveBackground(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "remove-background") {
    throw new Error("Invalid background removal operation.");
  }

  postProgress(request, 24, "Preparing image pixels for local background removal");
  const source = bitmapToImageData(bitmap);
  cancellationRegistry.throwIfCanceled(request.jobId);

  postProgress(request, 26, "Starting background-removal runtime");
  const runtime = await loadLocalBackgroundRemovalRuntime();
  cancellationRegistry.throwIfCanceled(request.jobId);

  const image = await runtime.removeBackground(source, {
    mode: request.operation.options.mode,
    onProgress: (progress, message) => postProgress(request, progress, message),
    throwIfCanceled: () => cancellationRegistry.throwIfCanceled(request.jobId),
  });
  cancellationRegistry.throwIfCanceled(request.jobId);

  postProgress(request, 92, "Encoding transparent PNG locally");
  const canvas = imageDataToCanvas(image);
  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, request.operation.options.outputMimeType, 1),
    width: image.width,
    height: image.height,
    mimeType: request.operation.options.outputMimeType,
  };
}

export async function processObjectSelect(
  request: ImageJobRequest,
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number; mimeType: OutputMimeType }> {
  if (request.operation.type !== "object-select") {
    throw new Error("Invalid object selection operation.");
  }

  postProgress(request, 24, "Preparing image for local object selection");
  const source = bitmapToImageData(bitmap);
  cancellationRegistry.throwIfCanceled(request.jobId);

  postProgress(request, 26, "Starting object selector");
  const runtime = await loadLocalObjectSelectionRuntime();
  cancellationRegistry.throwIfCanceled(request.jobId);

  const image =
    request.operation.options.action === "mask"
      ? await runtime.createOverlay(source, {
          point: request.operation.options.point,
          onProgress: (progress, message) => postProgress(request, progress, message),
          throwIfCanceled: () => cancellationRegistry.throwIfCanceled(request.jobId),
        })
      : await runtime.cutOut(source, {
          point: request.operation.options.point,
          onProgress: (progress, message) => postProgress(request, progress, message),
          throwIfCanceled: () => cancellationRegistry.throwIfCanceled(request.jobId),
        });
  cancellationRegistry.throwIfCanceled(request.jobId);

  postProgress(
    request,
    92,
    request.operation.options.action === "mask"
      ? "Encoding selection highlight"
      : "Encoding selected object",
  );
  const canvas = imageDataToCanvas(image);
  cancellationRegistry.throwIfCanceled(request.jobId);

  return {
    blob: await encodeCanvas(canvas, request.operation.options.outputMimeType, 1),
    width: image.width,
    height: image.height,
    mimeType: request.operation.options.outputMimeType,
  };
}

async function processRequest(request: ImageJobRequest): Promise<void> {
  const startedAt = performance.now();
  let bitmap: ImageBitmap | undefined;

  try {
    cancellationRegistry.clear(request.jobId);
    postProgress(request, 5, "Reading image");
    cancellationRegistry.throwIfCanceled(request.jobId);

    const processed =
      request.operation.type === "metadata"
        ? await (async (options) => {
            postProgress(
              request,
              40,
              "Rewriting metadata locally without re-encoding pixels",
            );
            const result = await processMetadataSource(request.source, options);
            cancellationRegistry.throwIfCanceled(request.jobId);
            return result;
          })(request.operation.options)
        : await (async () => {
            bitmap = await createBitmap(request.source);
            cancellationRegistry.throwIfCanceled(request.jobId);

            postProgress(request, 20, "Decoded locally");

            return request.operation.type === "resize"
              ? processResize(request, bitmap)
              : request.operation.type === "compress"
                ? processCompress(request, bitmap)
                : request.operation.type === "convert"
                  ? processConvert(request, bitmap)
                  : request.operation.type === "crop"
                    ? processCrop(request, bitmap)
                    : request.operation.type === "object-select"
                      ? processObjectSelect(request, bitmap)
                      : processRemoveBackground(request, bitmap);
          })();

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
