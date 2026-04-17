import type {
  CompressOptions,
  CropOptions,
  ImageAsset,
  ImageTool,
  MetadataOptions,
  ObjectSelectAction,
  ObjectSelectOptions,
  ObjectSelectPoint,
  OutputMimeType,
  RemoveBackgroundOptions,
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
  "image/svg+xml",
]);

export const OUTPUT_MIME_TYPES = Object.keys(MIME_EXTENSIONS) as OutputMimeType[];

export function isSupportedInputMime(mimeType: string): boolean {
  return SUPPORTED_INPUT_MIME_TYPES.has(mimeType);
}

export function getMimeLabel(mimeType: OutputMimeType): string {
  return MIME_LABELS[mimeType];
}

export function getDefaultOutputMime(asset?: ImageAsset): OutputMimeType {
  return asset && OUTPUT_MIME_TYPES.includes(asset.mimeType as OutputMimeType)
    ? (asset.mimeType as OutputMimeType)
    : "image/png";
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

export interface ResizePreset {
  id: string;
  label: string;
  detail: string;
  width: number;
  height: number;
  fitMode: ResizeFitMode;
  lockAspectRatio: boolean;
}

export const RESIZE_PRESETS: ResizePreset[] = [
  {
    id: "slack-avatar",
    label: "Slack profile",
    detail: "Avatar max",
    width: 1024,
    height: 1024,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "youtube-thumbnail",
    label: "YouTube thumbnail",
    detail: "Video cover 16:9",
    width: 3840,
    height: 2160,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "instagram-feed-portrait",
    label: "Instagram portrait",
    detail: "Feed 4:5",
    width: 1080,
    height: 1350,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "vertical-story",
    label: "Story / TikTok",
    detail: "Vertical 9:16",
    width: 1080,
    height: 1920,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "instagram-square",
    label: "Instagram square",
    detail: "Feed 1:1",
    width: 1080,
    height: 1080,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "instagram-landscape",
    label: "Instagram wide",
    detail: "Feed landscape",
    width: 1080,
    height: 566,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "youtube-banner",
    label: "YouTube banner",
    detail: "Channel art",
    width: 2560,
    height: 1440,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "linkedin-post",
    label: "LinkedIn post",
    detail: "Link preview",
    width: 1200,
    height: 627,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "x-post",
    label: "X post",
    detail: "Timeline 16:9",
    width: 1600,
    height: 900,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "x-header",
    label: "X header",
    detail: "Banner 3:1",
    width: 1500,
    height: 500,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "facebook-link",
    label: "Facebook link",
    detail: "Feed preview",
    width: 1200,
    height: 630,
    fitMode: "cover",
    lockAspectRatio: true,
  },
  {
    id: "pinterest-pin",
    label: "Pinterest pin",
    detail: "Standard 2:3",
    width: 1000,
    height: 1500,
    fitMode: "cover",
    lockAspectRatio: true,
  },
];

export function applyResizePreset(
  options: ResizeOptions,
  preset: ResizePreset,
): ResizeOptions {
  return {
    ...options,
    width: preset.width,
    height: preset.height,
    fitMode: preset.fitMode,
    lockAspectRatio: preset.lockAspectRatio,
  };
}

export function normalizeRotationDegrees(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = value % 360;
  if (Object.is(normalized, -0)) {
    return 0;
  }

  if (normalized > 180) {
    return normalized - 360;
  }

  if (normalized < -180) {
    return normalized + 360;
  }

  return normalized;
}

export function calculateRotatedDimensions(
  width: number,
  height: number,
  rotation: number,
): PixelDimensions {
  const radians = (normalizeRotationDegrees(rotation) * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const stableSin = sin < 1e-10 ? 0 : sin;
  const stableCos = cos < 1e-10 ? 0 : cos;

  return {
    width: Math.max(
      1,
      Math.ceil(Math.abs(width) * stableCos + Math.abs(height) * stableSin),
    ),
    height: Math.max(
      1,
      Math.ceil(Math.abs(width) * stableSin + Math.abs(height) * stableCos),
    ),
  };
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

  if (!lockAspectRatio || fitMode === "stretch" || fitMode === "cover") {
    return { width: requestedWidth, height: requestedHeight };
  }

  const widthRatio = requestedWidth / safeSourceWidth;
  const heightRatio = requestedHeight / safeSourceHeight;
  const ratio = Math.min(widthRatio, heightRatio);

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
    rotation: normalizeRotationDegrees(crop.rotation),
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
      rotation: 0,
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
    mimeType: getDefaultOutputMime(asset),
    quality: 0.92,
  };
}

export function createDefaultCompressOptions(): CompressOptions {
  return {
    mimeType: "image/webp",
    quality: 0.72,
    maxDimension: 2400,
  };
}

export function createDefaultRemoveBackgroundOptions(): RemoveBackgroundOptions {
  return {
    outputMimeType: "image/png",
    mode: "auto",
  };
}

export function createDefaultMetadataOptions(): MetadataOptions {
  return {
    mode: "clean",
    fields: {
      title: "",
      description: "",
      creator: "",
      copyright: "",
      keywords: "",
    },
    customTextFields: [],
    removePrivateData: true,
    removeComments: true,
    preserveColorProfile: true,
    sanitizeSvg: true,
  };
}

export function createObjectSelectOptions(
  point: ObjectSelectPoint,
  action: ObjectSelectAction = "cutout",
): ObjectSelectOptions {
  return {
    outputMimeType: "image/png",
    action,
    point: {
      x: Math.min(1, Math.max(0, point.x)),
      y: Math.min(1, Math.max(0, point.y)),
    },
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
