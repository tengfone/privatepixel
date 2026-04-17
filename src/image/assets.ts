import { isSupportedInputMime, sanitizeBaseName } from "./options";
import type { ImageAsset } from "./types";

export class UnsupportedImageTypeError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported image type: ${mimeType || "unknown"}`);
    this.name = "UnsupportedImageTypeError";
  }
}

export async function createImageAsset(file: File): Promise<ImageAsset> {
  if (!isSupportedInputMime(file.type)) {
    throw new UnsupportedImageTypeError(file.type);
  }

  const dimensions = await readImageDimensions(file);
  const previewUrl = URL.createObjectURL(file);

  const asset: ImageAsset = {
    id: crypto.randomUUID(),
    file,
    name: file.name || `${sanitizeBaseName(file.type)}.${file.type.split("/")[1]}`,
    mimeType: file.type,
    size: file.size,
    width: dimensions.width,
    height: dimensions.height,
    previewUrl,
  };

  return asset;
}

async function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await readImageElementDimensions(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function readImageElementDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => reject(new Error("Image metadata could not be decoded."));
    image.src = url;
  });
}

export function revokeImageAsset(asset: Pick<ImageAsset, "previewUrl">): void {
  URL.revokeObjectURL(asset.previewUrl);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const precision = value >= 10 || index === 0 ? 0 : 1;

  return `${value.toFixed(precision)} ${units[index]}`;
}

export function formatDimensions(width: number, height: number): string {
  return `${Math.round(width)} x ${Math.round(height)}`;
}
