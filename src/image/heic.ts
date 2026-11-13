import { isSupportedInputMime } from "./options";

export const HEIC_DECODE_MESSAGE = "HEIC/HEIF could not be decoded in this browser.";

export const UNSUPPORTED_IMPORT_MESSAGE =
  "Add PNG, JPEG, WebP, GIF, BMP, AVIF, or HEIC images.";

export const IMAGE_FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  ".heic",
  ".heif",
].join(",");

const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);
const UNKNOWN_MIME_TYPES = new Set(["", "application/octet-stream"]);
const JPEG_QUALITY = 0.92;

export class HeicDecodeError extends Error {
  constructor(message = HEIC_DECODE_MESSAGE) {
    super(message);
    this.name = "HeicDecodeError";
  }
}

export function isHeicFile(file: { name: string; type: string }): boolean {
  const mimeType = file.type.trim().toLowerCase();
  if (HEIC_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (!UNKNOWN_MIME_TYPES.has(mimeType)) {
    return false;
  }

  return hasHeicExtension(file.name);
}

export function isAcceptedImportFile(file: { name: string; type: string }): boolean {
  return isSupportedInputMime(file.type) || isHeicFile(file);
}

export async function prepareImportFile(file: File): Promise<File> {
  if (!isHeicFile(file)) {
    return file;
  }

  return decodeHeicFile(file);
}

export async function decodeHeicFile(file: File): Promise<File> {
  try {
    const converted = await decodeHeicBlob(file);
    const blob = firstDecodedBlob(converted);
    if (!blob) {
      throw new HeicDecodeError();
    }

    return new File([blob], jpegNameForHeic(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch (error) {
    if (error instanceof HeicDecodeError) {
      throw error;
    }

    throw new HeicDecodeError();
  }
}

export function describeImportResults(input: {
  imported: number;
  failures: unknown[];
}): string {
  const heicFailures = input.failures.filter(
    (failure) => failure instanceof HeicDecodeError,
  ).length;
  const otherFailures = input.failures.length - heicFailures;

  if (input.imported === 0 && heicFailures > 0 && otherFailures === 0) {
    return HEIC_DECODE_MESSAGE;
  }

  if (input.failures.length === 0) {
    return `Imported ${plural(input.imported, "image", "images")} locally.`;
  }

  if (heicFailures > 0 && otherFailures === 0) {
    return `Imported ${plural(input.imported, "image", "images")}; ${plural(
      heicFailures,
      "HEIC/HEIF file",
      "HEIC/HEIF files",
    )} could not be decoded.`;
  }

  return `Imported ${plural(input.imported, "image", "images")}; ${input.failures.length} could not be decoded.`;
}

async function decodeHeicBlob(file: File): Promise<unknown> {
  // heic-to embeds a multi-megabyte libheif WASM build. Load it only when a
  // HEIC/HEIF file is imported so the static page does not download it otherwise.
  const { heicTo } = await import("heic-to");
  return heicTo({
    blob: file,
    type: "image/jpeg",
    quality: JPEG_QUALITY,
  });
}

function hasHeicExtension(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(".heic") || normalized.endsWith(".heif");
}

function jpegNameForHeic(filename: string): string {
  const stripped = filename.trim().replace(/\.(heic|heif)$/i, "");
  const stem = stripped.trim();
  return `${stem || "image"}.jpg`;
}

function firstDecodedBlob(converted: unknown): Blob | null {
  if (converted instanceof Blob) {
    return converted.size > 0 ? converted : null;
  }

  if (!Array.isArray(converted)) {
    return null;
  }

  const blob = converted.find((entry): entry is Blob => entry instanceof Blob);
  return blob && blob.size > 0 ? blob : null;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
