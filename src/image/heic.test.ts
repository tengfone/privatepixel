import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageAsset, UnsupportedImageTypeError } from "./assets";
import { isSupportedInputMime } from "./options";
import { heicTo } from "heic-to";
import {
  HEIC_DECODE_MESSAGE,
  IMAGE_FILE_ACCEPT,
  UNSUPPORTED_IMPORT_MESSAGE,
  HeicDecodeError,
  describeImportResults,
  decodeHeicFile,
  isAcceptedImportFile,
  isHeicFile,
  prepareImportFile,
} from "./heic";

vi.mock("heic-to", () => ({
  heicTo: vi.fn(),
}));

describe("HEIC import gate", () => {
  it("recognizes HEIC and HEIF mime types", () => {
    expect(isHeicFile({ name: "photo.jpg", type: "image/heic" })).toBe(true);
    expect(isHeicFile({ name: "photo.jpg", type: "image/heif" })).toBe(true);
    expect(isHeicFile({ name: "photo.jpg", type: "IMAGE/HEIC" })).toBe(true);
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

describe("HEIC decode import branch", () => {
  beforeEach(() => {
    vi.mocked(heicTo).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes once to a JPEG file the rest of the pipeline can read", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "trip.HEIC", { type: "" });
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
      type: "image/jpeg",
    });
    const seenBitmaps: Blob[] = [];
    vi.mocked(heicTo).mockResolvedValue(jpeg);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (file: Blob) => {
        seenBitmaps.push(file);
        return { width: 32, height: 16, close: vi.fn() };
      }),
    );

    const prepared = await prepareImportFile(source);
    const asset = await createImageAsset(prepared);
    const decodedFile = seenBitmaps[0];

    expect(decodedFile).toBeInstanceOf(File);
    expect((decodedFile as File).name).toBe("trip.jpg");
    expect((decodedFile as File).type).toBe("image/jpeg");
    expect(heicTo).toHaveBeenCalledTimes(1);
    expect(heicTo).toHaveBeenCalledWith({
      blob: source,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(asset.name).toBe("trip.jpg");
    expect(asset.mimeType).toBe("image/jpeg");
    expect(asset.width).toBe(32);
    expect(asset.height).toBe(16);
    expect(asset.file.type).toBe("image/jpeg");
  });

  it("leaves an ordinary image untouched", async () => {
    const source = new File([new Uint8Array([1])], "plain.png", { type: "image/png" });

    await expect(prepareImportFile(source)).resolves.toBe(source);
    expect(heicTo).not.toHaveBeenCalled();
  });

  it("uses a specific decode error when the local decoder fails", async () => {
    vi.mocked(heicTo).mockRejectedValue(new Error("wasm failed"));
    const source = new File([new Uint8Array([1])], "trip.heic", { type: "image/heic" });

    await expect(decodeHeicFile(source)).rejects.toThrow(HEIC_DECODE_MESSAGE);
  });

  it("describes HEIC decode failures without an unsupported-type message", () => {
    expect(
      describeImportResults({
        imported: 0,
        failures: [new HeicDecodeError()],
      }),
    ).toBe(HEIC_DECODE_MESSAGE);
    expect(
      describeImportResults({
        imported: 1,
        failures: [new HeicDecodeError()],
      }),
    ).toBe("Imported 1 image; 1 HEIC/HEIF file could not be decoded.");
    expect(
      describeImportResults({
        imported: 2,
        failures: [],
      }),
    ).toBe("Imported 2 images locally.");
    expect(UNSUPPORTED_IMPORT_MESSAGE).toContain("HEIC");
    expect(UNSUPPORTED_IMPORT_MESSAGE).not.toMatch(/not supported/i);
  });
});
