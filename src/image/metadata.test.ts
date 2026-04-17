import { describe, expect, it } from "vitest";
import { createDefaultMetadataOptions } from "./options";
import {
  getEffectiveMetadataOptions,
  getMetadataFormatSupport,
  inspectMetadataSource,
  processMetadataSource,
} from "./metadata";

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAJElEQVR4AVzFgQkAAAgCwc/9d7YoIujgVV5gV+IREXQMzd0mAAAA//+U28WrAAAABklEQVQDANlSDAFZtBg5AAAAAElFTkSuQmCC";

async function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text();
  }

  return new TextDecoder().decode(await readBlobArrayBuffer(blob));
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function makeWebpChunk(type: string, payload: Uint8Array): Uint8Array {
  const paddedLength = payload.byteLength + (payload.byteLength % 2);
  const chunk = new Uint8Array(8 + paddedLength);
  chunk.set(asciiBytes(type), 0);
  chunk[4] = payload.byteLength & 0xff;
  chunk[5] = (payload.byteLength >> 8) & 0xff;
  chunk[6] = (payload.byteLength >> 16) & 0xff;
  chunk[7] = (payload.byteLength >> 24) & 0xff;
  chunk.set(payload, 8);
  return chunk;
}

function makeWebp(chunks: Uint8Array[]): ArrayBuffer {
  const chunkLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(12 + chunkLength);
  const riffLength = bytes.byteLength - 8;
  bytes.set(asciiBytes("RIFF"), 0);
  bytes[4] = riffLength & 0xff;
  bytes[5] = (riffLength >> 8) & 0xff;
  bytes[6] = (riffLength >> 16) & 0xff;
  bytes[7] = (riffLength >> 24) & 0xff;
  bytes.set(asciiBytes("WEBP"), 8);

  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes.buffer;
}

function findWebpChunkPayload(bytes: Uint8Array, type: string): Uint8Array | undefined {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const chunkLength = length >>> 0;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (chunkType === type) {
      return bytes.subarray(offset + 8, offset + 8 + chunkLength);
    }
    offset += 8 + paddedLength;
  }

  return undefined;
}

describe("metadata helpers", () => {
  it("reports format-specific metadata support", () => {
    expect(getMetadataFormatSupport("image/jpeg")).toMatchObject({
      canClean: true,
      canEditText: true,
      canStripPrivateData: true,
    });
    expect(getMetadataFormatSupport("image/webp")).toMatchObject({
      canClean: true,
      canEditText: false,
    });
    expect(getMetadataFormatSupport("image/avif")).toMatchObject({
      canClean: false,
      canEditText: false,
    });
  });

  it("downgrades unsupported edit mode to clean mode", () => {
    expect(
      getEffectiveMetadataOptions("image/webp", {
        ...createDefaultMetadataOptions(),
        mode: "edit",
      }).mode,
    ).toBe("clean");
  });

  it("adds PNG text metadata without re-encoding pixels", async () => {
    const buffer = Uint8Array.from(Buffer.from(SAMPLE_PNG_BASE64, "base64")).buffer;
    const result = await processMetadataSource(
      {
        name: "sample.png",
        mimeType: "image/png",
        size: buffer.byteLength,
        width: 4,
        height: 4,
        buffer,
      },
      {
        ...createDefaultMetadataOptions(),
        mode: "edit",
        customTextFields: [{ key: "Project", value: "Metadata editor" }],
        fields: {
          title: "Private sample",
          description: "",
          creator: "PrivatePixel",
          copyright: "",
          keywords: "local,private",
        },
      },
    );

    const bytes = new Uint8Array(await readBlobArrayBuffer(result.blob));
    const text = String.fromCharCode(...bytes);

    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(4);
    expect(text).toContain("Title");
    expect(text).toContain("Private sample");
    expect(text).toContain("PrivatePixel");
    expect(text).toContain("Project");
    expect(text).toContain("Metadata editor");

    const inspection = inspectMetadataSource({
      name: "sample.png",
      mimeType: "image/png",
      size: bytes.byteLength,
      width: 4,
      height: 4,
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    expect(inspection.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Title",
          value: "Private sample",
          editable: true,
        }),
        expect.objectContaining({
          label: "Project",
          value: "Metadata editor",
          editable: true,
        }),
      ]),
    );
  });

  it("inspects existing SVG metadata as editable fields", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Existing icon</title><desc>Existing description</desc><metadata id="source">Catalog 7</metadata><!-- keep me --><rect width="10" height="10"/></svg>`;
    const buffer = new TextEncoder().encode(svg).buffer;
    const inspection = inspectMetadataSource({
      name: "icon.svg",
      mimeType: "image/svg+xml",
      size: buffer.byteLength,
      width: 10,
      height: 10,
      buffer,
    });

    expect(inspection.formatLabel).toBe("SVG");
    expect(inspection.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Title",
          value: "Existing icon",
          editable: true,
        }),
        expect.objectContaining({
          label: "Description",
          value: "Existing description",
          editable: true,
        }),
        expect.objectContaining({
          label: "Metadata node: source",
          value: "Catalog 7",
          editable: true,
        }),
        expect.objectContaining({
          label: "Comment 1",
          value: "keep me",
          editable: true,
        }),
      ]),
    );
  });

  it("edits and sanitizes SVG metadata", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><!-- editor --><rect width="10" height="10" onclick="alert(1)"/></svg>`;
    const buffer = new TextEncoder().encode(svg).buffer;
    const result = await processMetadataSource(
      {
        name: "icon.svg",
        mimeType: "image/svg+xml",
        size: buffer.byteLength,
        width: 10,
        height: 10,
        buffer,
      },
      {
        ...createDefaultMetadataOptions(),
        mode: "edit",
        fields: {
          title: "Safe icon",
          description: "A sanitized SVG",
          creator: "PrivatePixel",
          copyright: "",
          keywords: "",
        },
      },
    );

    const text = await readBlobText(result.blob);

    expect(result.mimeType).toBe("image/svg+xml");
    expect(text).toContain("<title>Safe icon</title>");
    expect(text).toContain("<desc>A sanitized SVG</desc>");
    expect(text).toContain("PrivatePixel");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("onclick");
    expect(text).not.toContain("editor");
  });

  it("edits SVG metadata without DOMParser or XMLSerializer", async () => {
    const domParserDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "DOMParser",
    );
    const xmlSerializerDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "XMLSerializer",
    );
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, "XMLSerializer", {
      configurable: true,
      value: undefined,
    });

    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Old</title><rect width="10" height="10" onclick="alert(1)"/></svg>`;
      const buffer = new TextEncoder().encode(svg).buffer;
      const result = await processMetadataSource(
        {
          name: "icon.svg",
          mimeType: "image/svg+xml",
          size: buffer.byteLength,
          width: 10,
          height: 10,
          buffer,
        },
        {
          ...createDefaultMetadataOptions(),
          mode: "edit",
          fields: {
            title: "Worker safe",
            description: "",
            creator: "",
            copyright: "",
            keywords: "",
          },
        },
      );

      const text = await readBlobText(result.blob);
      expect(text).toContain("<title>Worker safe</title>");
      expect(text).not.toContain("<title>Old</title>");
      expect(text).not.toContain("onclick");
    } finally {
      if (domParserDescriptor) {
        Object.defineProperty(globalThis, "DOMParser", domParserDescriptor);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).DOMParser;
      }

      if (xmlSerializerDescriptor) {
        Object.defineProperty(globalThis, "XMLSerializer", xmlSerializerDescriptor);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).XMLSerializer;
      }
    }
  });

  it("preserves WebP ICC profiles while cleaning private metadata", async () => {
    const vp8xPayload = new Uint8Array(10);
    vp8xPayload[0] = 0x20 | 0x08 | 0x04;
    const buffer = makeWebp([
      makeWebpChunk("VP8X", vp8xPayload),
      makeWebpChunk("ICCP", asciiBytes("profile")),
      makeWebpChunk("EXIF", asciiBytes("exif")),
      makeWebpChunk("XMP ", asciiBytes("xmp")),
    ]);

    const result = await processMetadataSource(
      {
        name: "sample.webp",
        mimeType: "image/webp",
        size: buffer.byteLength,
        width: 10,
        height: 10,
        buffer,
      },
      createDefaultMetadataOptions(),
    );

    const bytes = new Uint8Array(await readBlobArrayBuffer(result.blob));
    const text = String.fromCharCode(...bytes);
    const vp8x = findWebpChunkPayload(bytes, "VP8X");

    expect(text).toContain("ICCP");
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("XMP ");
    expect(vp8x?.[0]).toBe(0x20);
  });

  it("keeps WebP metadata when clean toggles are disabled", async () => {
    const vp8xPayload = new Uint8Array(10);
    vp8xPayload[0] = 0x20 | 0x08 | 0x04;
    const buffer = makeWebp([
      makeWebpChunk("VP8X", vp8xPayload),
      makeWebpChunk("ICCP", asciiBytes("profile")),
      makeWebpChunk("EXIF", asciiBytes("exif")),
      makeWebpChunk("XMP ", asciiBytes("xmp")),
    ]);

    const result = await processMetadataSource(
      {
        name: "sample.webp",
        mimeType: "image/webp",
        size: buffer.byteLength,
        width: 10,
        height: 10,
        buffer,
      },
      {
        ...createDefaultMetadataOptions(),
        removePrivateData: false,
        preserveColorProfile: true,
      },
    );

    const bytes = new Uint8Array(await readBlobArrayBuffer(result.blob));
    const text = String.fromCharCode(...bytes);
    const vp8x = findWebpChunkPayload(bytes, "VP8X");

    expect(text).toContain("ICCP");
    expect(text).toContain("EXIF");
    expect(text).toContain("XMP ");
    expect(vp8x?.[0]).toBe(0x20 | 0x08 | 0x04);
  });
});
