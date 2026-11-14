import { isSupportedInputMime } from "./options";
import type { ImportedOriginal } from "./types";

export const HEIC_DECODE_HINT =
  "couldn't be decoded. The file may be damaged or use an unsupported HEIC variant.";

export const HEIC_DECODER_LOAD_MESSAGE =
  "The HEIC decoder couldn't be loaded. Check your connection and try again.";

/** What a HEIC/HEIF import leaves behind; shown when such a file is imported. */
export const HEIC_IMPORT_NOTE =
  "HEIC is decoded to a lossless working copy. Its EXIF/GPS metadata, colour profile, and HDR are not carried over.";

export const UNSUPPORTED_IMPORT_MESSAGE =
  "Add PNG, JPEG, WebP, GIF, BMP, AVIF, or HEIC images.";

const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const UNKNOWN_MIME_TYPES = new Set(["", "application/octet-stream"]);

export const IMAGE_FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
  ...HEIC_MIME_TYPES,
  ".heic",
  ".heif",
].join(",");

export class HeicDecodeError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(`${fileName || "This HEIC file"} ${HEIC_DECODE_HINT}`);
    this.name = "HeicDecodeError";
    this.fileName = fileName;
  }
}

export class HeicDecoderLoadError extends Error {
  constructor() {
    super(HEIC_DECODER_LOAD_MESSAGE);
    this.name = "HeicDecoderLoadError";
  }
}

export interface PreparedImport {
  /** A file every tool can read: the original, or a lossless PNG of a HEIC. */
  file: File;
  /** The file the user picked, when `file` is a decoded working copy. */
  original?: ImportedOriginal;
}

export interface HeicDecodeProgress {
  /** 1-based position of the HEIC file being decoded. */
  index: number;
  total: number;
  fileName: string;
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

/**
 * Turns picked files into files the pipeline can read. HEIC/HEIF files are
 * decoded one at a time: each decode holds a full-resolution RGBA copy in
 * memory, so decoding a batch of 48 MP photos in parallel can exhaust a tab.
 * Other files pass straight through.
 */
export async function prepareImportFiles(
  files: File[],
  onHeicProgress?: (progress: HeicDecodeProgress) => void,
): Promise<PromiseSettledResult<PreparedImport>[]> {
  const total = files.filter((file) => isHeicFile(file)).length;
  const results: PromiseSettledResult<PreparedImport>[] = [];
  let index = 0;

  for (const file of files) {
    if (!isHeicFile(file)) {
      results.push({ status: "fulfilled", value: { file } });
      continue;
    }

    index += 1;
    onHeicProgress?.({ index, total, fileName: file.name });
    try {
      results.push({ status: "fulfilled", value: await decodeHeicFile(file) });
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
  }

  return results;
}

let decodeQueue: Promise<unknown> = Promise.resolve();

/**
 * Decodes the primary image of a HEIC/HEIF file to a lossless PNG so later
 * tools encode from full-quality pixels instead of a second lossy JPEG.
 * Decodes are serialised across calls, even when imports overlap.
 */
export function decodeHeicFile(file: File): Promise<PreparedImport> {
  const run = decodeQueue.then(() => decodeHeicFileNow(file));
  decodeQueue = run.catch(() => undefined);
  return run;
}

async function decodeHeicFileNow(file: File): Promise<PreparedImport> {
  const png = (await decodeNatively(file)) ?? (await decodeWithLibheif(file));
  if (!png || png.size === 0) {
    throw new HeicDecodeError(file.name);
  }

  return {
    file: new File([png], pngNameForHeic(file.name), {
      type: "image/png",
      lastModified: file.lastModified,
    }),
    original: {
      name: file.name.trim() || "image.heic",
      mimeType: file.type.trim().toLowerCase() || "image/heic",
      size: file.size,
    },
  };
}

/**
 * Browsers with a system HEIC decoder (Safari) can read the file directly,
 * which avoids downloading the multi-megabyte WASM decoder.
 */
async function decodeNatively(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") {
    return null;
  }

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return await bitmapToPng(bitmap);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function bitmapToPng(bitmap: ImageBitmap): Promise<Blob | null> {
  if (!bitmap.width || !bitmap.height) {
    return null;
  }

  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function decodeWithLibheif(file: File): Promise<Blob> {
  // heic-to embeds a multi-megabyte libheif WASM build. Load it only when a
  // HEIC/HEIF file needs it so the static page does not download it otherwise.
  let heicTo: (typeof import("heic-to"))["heicTo"];
  try {
    ({ heicTo } = await import("heic-to"));
  } catch {
    throw new HeicDecoderLoadError();
  }

  try {
    // heic-to decodes the primary image only and returns a single Blob.
    return await heicTo({ blob: file, type: "image/png" });
  } catch {
    throw new HeicDecodeError(file.name);
  }
}

export function describeImportResults(input: {
  imported: number;
  heicImported?: number;
  failures: unknown[];
}): string {
  const { imported, failures } = input;
  const heicNote = input.heicImported ? ` ${HEIC_IMPORT_NOTE}` : "";
  const loadFailures = failures.filter(
    (failure) => failure instanceof HeicDecoderLoadError,
  );
  const decodeFailures = failures.filter(
    (failure) => failure instanceof HeicDecodeError,
  );

  if (failures.length === 0) {
    return `Imported ${plural(imported, "image", "images")} locally.${heicNote}`;
  }

  if (imported === 0 && loadFailures.length === failures.length) {
    return HEIC_DECODER_LOAD_MESSAGE;
  }

  if (imported === 0 && failures.length === 1 && decodeFailures.length === 1) {
    return (decodeFailures[0] as HeicDecodeError).message;
  }

  const prefix = `Imported ${plural(imported, "image", "images")};`;
  if (
    loadFailures.length &&
    loadFailures.length + decodeFailures.length === failures.length
  ) {
    return `${prefix} ${HEIC_DECODER_LOAD_MESSAGE}${heicNote}`;
  }

  if (decodeFailures.length === failures.length) {
    const hint =
      decodeFailures.length === 1
        ? HEIC_DECODE_HINT
        : HEIC_DECODE_HINT.replace("The file may", "The files may");
    return `${prefix} ${plural(
      decodeFailures.length,
      "HEIC/HEIF file",
      "HEIC/HEIF files",
    )} ${hint}${heicNote}`;
  }

  return `${prefix} ${failures.length} could not be decoded.${heicNote}`;
}

function hasHeicExtension(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(".heic") || normalized.endsWith(".heif");
}

function pngNameForHeic(filename: string): string {
  const stem = filename
    .trim()
    .replace(/\.(heic|heif)$/i, "")
    .trim();
  return `${stem || "image"}.png`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
