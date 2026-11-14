import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageAsset, UnsupportedImageTypeError } from "./assets";
import {
  createOutputFilename,
  getDefaultOutputMime,
  getOutputSizeDelta,
  isSupportedInputMime,
} from "./options";
import { heicTo } from "heic-to";
import {
  HEIC_DECODER_LOAD_MESSAGE,
  HEIC_IMPORT_NOTE,
  IMAGE_FILE_ACCEPT,
  UNSUPPORTED_IMPORT_MESSAGE,
  HeicDecodeError,
  HeicDecoderLoadError,
  describeImportResults,
  decodeHeicFile,
  isAcceptedImportFile,
  isHeicFile,
  prepareImportFiles,
} from "./heic";

vi.mock("heic-to", () => ({
  heicTo: vi.fn(),
}));

function pngBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
}

function heicFile(name: string, bytes = 3): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/heic" });
}

/** A browser without a native HEIC decoder: bitmaps work for PNG only. */
function stubBitmapsWithoutNativeHeic(): void {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => {
      if (blob.type !== "image/png") {
        throw new DOMException("The source image could not be decoded.");
      }
      return { width: 32, height: 16, close: vi.fn() };
    }),
  );
}

describe("HEIC import gate", () => {
  it("recognizes HEIC and HEIF mime types, including sequences", () => {
    expect(isHeicFile({ name: "photo.jpg", type: "image/heic" })).toBe(true);
    expect(isHeicFile({ name: "photo.jpg", type: "image/heif" })).toBe(true);
    expect(isHeicFile({ name: "photo.jpg", type: "IMAGE/HEIC" })).toBe(true);
    expect(isHeicFile({ name: "burst", type: "image/heic-sequence" })).toBe(true);
    expect(isHeicFile({ name: "burst", type: "image/heif-sequence" })).toBe(true);
    expect(IMAGE_FILE_ACCEPT).toContain("image/heic-sequence");
    expect(IMAGE_FILE_ACCEPT).toContain("image/heif-sequence");
  });

  it("recognizes .heic and .heif names when the browser leaves the mime blank", () => {
    expect(isHeicFile({ name: "Vacation.HEIC", type: "" })).toBe(true);
    expect(isHeicFile({ name: "trip.heif", type: "" })).toBe(true);
    expect(isHeicFile({ name: "photo.heic", type: "application/octet-stream" })).toBe(
      true,
    );
    expect(isHeicFile({ name: "notes.txt", type: "" })).toBe(false);
    expect(isHeicFile({ name: "notes.txt", type: "application/octet-stream" })).toBe(
      false,
    );
  });

  it("does not treat a named HEIC file with another mime as HEIC", () => {
    expect(isHeicFile({ name: "photo.heic", type: "image/jpeg" })).toBe(false);
    expect(isHeicFile({ name: "photo.png", type: "image/png" })).toBe(false);
  });

  it("keeps HEIC out of the native mime set and accepts it as an import", () => {
    expect(isSupportedInputMime("image/heic")).toBe(false);
    expect(isSupportedInputMime("image/heif")).toBe(false);
    expect(isAcceptedImportFile({ name: "a.heic", type: "" })).toBe(true);
    expect(isAcceptedImportFile({ name: "a.png", type: "image/png" })).toBe(true);
    expect(isAcceptedImportFile({ name: "a.txt", type: "text/plain" })).toBe(false);
    expect(IMAGE_FILE_ACCEPT).toContain("image/heic");
    expect(IMAGE_FILE_ACCEPT).toContain("image/heif");
    expect(IMAGE_FILE_ACCEPT).toContain(".heic");
    expect(IMAGE_FILE_ACCEPT).toContain(".heif");
  });

  it("rejects a raw HEIC file instead of pretending the browser can decode it", async () => {
    await expect(
      createImageAsset(new File(["heic"], "raw.heic", { type: "image/heic" })),
    ).rejects.toBeInstanceOf(UnsupportedImageTypeError);
  });
});

describe("HEIC decode", () => {
  beforeEach(() => {
    vi.mocked(heicTo).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes to a lossless PNG and keeps the original name and size", async () => {
    stubBitmapsWithoutNativeHeic();
    vi.mocked(heicTo).mockResolvedValue(pngBlob());
    const source = new File([new Uint8Array(1234)], "trip.HEIC", { type: "" });

    const prepared = await decodeHeicFile(source);
    const asset = await createImageAsset(prepared.file, prepared.original);

    expect(heicTo).toHaveBeenCalledTimes(1);
    expect(heicTo).toHaveBeenCalledWith({ blob: source, type: "image/png" });
    expect(prepared.file.name).toBe("trip.png");
    expect(prepared.file.type).toBe("image/png");
    expect(prepared.original).toEqual({
      name: "trip.HEIC",
      mimeType: "image/heic",
      size: 1234,
    });

    expect(asset.file.type).toBe("image/png");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.name).toBe("trip.HEIC");
    expect(asset.size).toBe(1234);
    expect(asset.width).toBe(32);
    expect(asset.height).toBe(16);
    expect(createOutputFilename(asset.name, "compress", "image/jpeg")).toBe(
      "trip-compress.jpg",
    );
    // Size change is measured against the HEIC the user picked, not the PNG copy.
    expect(getOutputSizeDelta(asset.size, 617)).toBe("-50%");
    expect(getDefaultOutputMime(asset)).toBe("image/jpeg");
  });

  it("uses the browser's own HEIC decoder when it has one", async () => {
    const drawImage = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 8, height: 6, close: vi.fn() })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage };
        }
        convertToBlob() {
          return Promise.resolve(pngBlob());
        }
      },
    );

    const prepared = await decodeHeicFile(heicFile("safari.heic"));

    expect(heicTo).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(prepared.file.name).toBe("safari.png");
    expect(prepared.file.type).toBe("image/png");
  });

  it("decodes HEIC files one at a time and reports progress", async () => {
    stubBitmapsWithoutNativeHeic();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(heicTo).mockImplementation((async ({ blob }: { blob: Blob }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if ((blob as File).name === "broken.heic") {
        throw new Error("libheif error");
      }
      return pngBlob();
    }) as unknown as typeof heicTo);
    const progress: string[] = [];
    const plain = new File([new Uint8Array([1])], "plain.png", { type: "image/png" });

    const results = await prepareImportFiles(
      [heicFile("a.heic"), plain, heicFile("broken.heic"), heicFile("c.heic")],
      ({ index, total, fileName }) => progress.push(`${index}/${total} ${fileName}`),
    );

    expect(maxInFlight).toBe(1);
    expect(progress).toEqual(["1/3 a.heic", "2/3 broken.heic", "3/3 c.heic"]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[1]).toEqual({ status: "fulfilled", value: { file: plain } });
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(
      HeicDecodeError,
    );
    expect((results[3] as PromiseFulfilledResult<{ file: File }>).value.file.name).toBe(
      "c.png",
    );
  });

  it("serialises decodes even when imports overlap", async () => {
    stubBitmapsWithoutNativeHeic();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(heicTo).mockImplementation((async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return pngBlob();
    }) as unknown as typeof heicTo);

    await Promise.all([
      decodeHeicFile(heicFile("one.heic")),
      decodeHeicFile(heicFile("two.heic")),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("explains a failed decode without blaming the browser", async () => {
    stubBitmapsWithoutNativeHeic();
    vi.mocked(heicTo).mockRejectedValue(new Error("wasm failed"));

    const error = await decodeHeicFile(heicFile("trip.heic")).catch((reason) => reason);

    expect(error).toBeInstanceOf(HeicDecodeError);
    expect(error.message).toBe(
      "trip.heic couldn't be decoded. The file may be damaged or use an unsupported HEIC variant.",
    );
    expect(error.message).not.toMatch(/browser/i);
  });
});

describe("describeImportResults", () => {
  it("adds the HEIC caveat when HEIC files were imported", () => {
    expect(describeImportResults({ imported: 2, failures: [] })).toBe(
      "Imported 2 images locally.",
    );
    expect(describeImportResults({ imported: 1, heicImported: 1, failures: [] })).toBe(
      `Imported 1 image locally. ${HEIC_IMPORT_NOTE}`,
    );
    expect(HEIC_IMPORT_NOTE).toMatch(/EXIF\/GPS/);
    expect(HEIC_IMPORT_NOTE).toMatch(/colour profile/);
    expect(HEIC_IMPORT_NOTE).toMatch(/HDR/);
  });

  it("names a single failed HEIC file", () => {
    expect(
      describeImportResults({ imported: 0, failures: [new HeicDecodeError("a.heic")] }),
    ).toBe(new HeicDecodeError("a.heic").message);
  });

  it("summarises mixed results", () => {
    expect(
      describeImportResults({
        imported: 1,
        heicImported: 1,
        failures: [new HeicDecodeError("b.heic")],
      }),
    ).toBe(
      `Imported 1 image; 1 HEIC/HEIF file couldn't be decoded. The file may be damaged or use an unsupported HEIC variant. ${HEIC_IMPORT_NOTE}`,
    );
    expect(
      describeImportResults({ imported: 1, failures: [new Error("png broke")] }),
    ).toBe("Imported 1 image; 1 could not be decoded.");
  });

  it("reports a decoder that failed to load", () => {
    expect(
      describeImportResults({
        imported: 0,
        failures: [new HeicDecoderLoadError(), new HeicDecoderLoadError()],
      }),
    ).toBe(HEIC_DECODER_LOAD_MESSAGE);
    expect(
      describeImportResults({ imported: 2, failures: [new HeicDecoderLoadError()] }),
    ).toBe(`Imported 2 images; ${HEIC_DECODER_LOAD_MESSAGE}`);
  });

  it("keeps the unsupported-file hint friendly", () => {
    expect(UNSUPPORTED_IMPORT_MESSAGE).toContain("HEIC");
    expect(UNSUPPORTED_IMPORT_MESSAGE).not.toMatch(/not supported/i);
  });
});
