import type {
  CompressOptions,
  CropOptions,
  ImageAsset,
  ImageTool,
  OutputMimeType,
  ResizeFitMode,
  ResizeOptions,
} from "./types";

const MIME_EXTENSIONS: Record<OutputMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const MIME_LABELS: Record<OutputMimeType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/svg+xml": "SVG wrapper",
};

export const SUPPORTED_INPUT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

export const OUTPUT_MIME_TYPES = Object.keys(MIME_EXTENSIONS) as OutputMimeType[];

export function isSupportedInputMime(mimeType: string): boolean {
  return SUPPORTED_INPUT_MIME_TYPES.has(mimeType);
}

export function getMimeLabel(mimeType: OutputMimeType): string {
  return MIME_LABELS[mimeType];
}

export function mimeToExtension(mimeType: OutputMimeType): string {
  return MIME_EXTENSIONS[mimeType];
}

export function clampQuality(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.82;
  }

  return Math.min(1, Math.max(0.05, value));
}

export function sanitizeBaseName(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "privatepixel-image";
}

export function createOutputFilename(
  filename: string,
  tool: ImageTool,
  mimeType: OutputMimeType,
): string {
  return `${sanitizeBaseName(filename)}-${tool}.${mimeToExtension(mimeType)}`;
}

export interface ResizeDimensionsInput {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  fitMode: ResizeFitMode;
  lockAspectRatio: boolean;
}

export interface PixelDimensions {
  width: number;
  height: number;
}

export function calculateResizeDimensions({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  fitMode,
  lockAspectRatio,
}: ResizeDimensionsInput): PixelDimensions {
  const safeSourceWidth = Math.max(1, Math.round(sourceWidth));
  const safeSourceHeight = Math.max(1, Math.round(sourceHeight));
  const requestedWidth = Math.max(1, Math.round(targetWidth || safeSourceWidth));
  const requestedHeight = Math.max(1, Math.round(targetHeight || safeSourceHeight));

  if (!lockAspectRatio || fitMode === "stretch") {
    return { width: requestedWidth, height: requestedHeight };
  }

  const widthRatio = requestedWidth / safeSourceWidth;
  const heightRatio = requestedHeight / safeSourceHeight;
  const ratio =
    fitMode === "cover"
      ? Math.max(widthRatio, heightRatio)
      : Math.min(widthRatio, heightRatio);

  return {
    width: Math.max(1, Math.round(safeSourceWidth * ratio)),
    height: Math.max(1, Math.round(safeSourceHeight * ratio)),
  };
}

export function calculateCompressedDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
): PixelDimensions {
  const safeWidth = Math.max(1, Math.round(sourceWidth));
  const safeHeight = Math.max(1, Math.round(sourceHeight));
  const safeMax = Math.max(
    1,
    Math.round(maxDimension || Math.max(safeWidth, safeHeight)),
  );
  const largestSide = Math.max(safeWidth, safeHeight);

  if (largestSide <= safeMax) {
    return { width: safeWidth, height: safeHeight };
  }

  const ratio = safeMax / largestSide;
  return {
    width: Math.max(1, Math.round(safeWidth * ratio)),
    height: Math.max(1, Math.round(safeHeight * ratio)),
  };
}

export function normalizeCropOptions(
  crop: CropOptions,
  sourceWidth: number,
  sourceHeight: number,
): CropOptions {
  const x = Math.max(0, Math.min(sourceWidth - 1, Math.round(crop.x)));
  const y = Math.max(0, Math.min(sourceHeight - 1, Math.round(crop.y)));
  const width = Math.max(1, Math.min(sourceWidth - x, Math.round(crop.width)));
  const height = Math.max(1, Math.min(sourceHeight - y, Math.round(crop.height)));

  return {
    ...crop,
    x,
    y,
    width,
    height,
    quality: clampQuality(crop.quality),
  };
}

export function createCenteredCrop(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number,
  mimeType: OutputMimeType,
  quality: number,
): CropOptions {
  const sourceRatio = sourceWidth / sourceHeight;
  let width = sourceWidth;
  let height = sourceHeight;

  if (sourceRatio > aspectRatio) {
    width = Math.round(sourceHeight * aspectRatio);
  } else {
    height = Math.round(sourceWidth / aspectRatio);
  }

  return normalizeCropOptions(
    {
      x: Math.round((sourceWidth - width) / 2),
      y: Math.round((sourceHeight - height) / 2),
      width,
      height,
      mimeType,
      quality,
    },
    sourceWidth,
    sourceHeight,
  );
}

export function createDefaultResizeOptions(asset?: ImageAsset): ResizeOptions {
  return {
    width: asset?.width ?? 1200,
    height: asset?.height ?? 800,
    lockAspectRatio: true,
    fitMode: "contain",
    mimeType: "image/webp",
    quality: 0.82,
  };
}

export function createDefaultCompressOptions(): CompressOptions {
  return {
    mimeType: "image/webp",
    quality: 0.72,
    maxDimension: 2400,
  };
}

export function getOutputSizeDelta(originalSize: number, outputSize: number): string {
  if (!originalSize || !outputSize) {
    return "0%";
  }

  const delta = ((outputSize - originalSize) / originalSize) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${Math.round(delta)}%`;
}
