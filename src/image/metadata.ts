import type {
  MetadataCustomTextField,
  ImageJobSource,
  MetadataOptions,
  MetadataTextFields,
  OutputMimeType,
} from "./types";

export interface MetadataFormatSupport {
  mimeType: string;
  label: string;
  canInspect: boolean;
  canClean: boolean;
  canEditText: boolean;
  canStripPrivateData: boolean;
  canStripComments: boolean;
  canPreserveColorProfile: boolean;
  canSanitizeSvg: boolean;
  outputMimeType?: OutputMimeType;
  summary: string;
}

export type MetadataEditableTarget =
  | { type: "field"; field: keyof MetadataTextFields }
  | { type: "custom"; key: string };

export interface MetadataInspectionEntry {
  id: string;
  label: string;
  value: string;
  group: string;
  editable: boolean;
  target?: MetadataEditableTarget;
}

export interface MetadataInspectionResult {
  formatLabel: string;
  entries: MetadataInspectionEntry[];
}

interface MetadataProcessResult {
  blob: Blob;
  mimeType: OutputMimeType;
  width: number;
  height: number;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const LATIN1_DECODER = new TextDecoder("latin1");
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP ", "ICCP"]);

export function getMetadataFormatSupport(mimeType: string): MetadataFormatSupport {
  if (mimeType === "image/jpeg") {
    return {
      mimeType,
      label: "JPEG",
      canInspect: true,
      canClean: true,
      canEditText: true,
      canStripPrivateData: true,
      canStripComments: true,
      canPreserveColorProfile: true,
      canSanitizeSvg: false,
      outputMimeType: "image/jpeg",
      summary: "EXIF, GPS, XMP, IPTC, comments, ICC profile, and basic text edits.",
    };
  }

  if (mimeType === "image/png") {
    return {
      mimeType,
      label: "PNG",
      canInspect: true,
      canClean: true,
      canEditText: true,
      canStripPrivateData: true,
      canStripComments: true,
      canPreserveColorProfile: true,
      canSanitizeSvg: false,
      outputMimeType: "image/png",
      summary: "Text chunks, EXIF chunk, DPI chunk, comments, and color chunks.",
    };
  }

  if (mimeType === "image/webp") {
    return {
      mimeType,
      label: "WebP",
      canInspect: true,
      canClean: true,
      canEditText: false,
      canStripPrivateData: true,
      canStripComments: false,
      canPreserveColorProfile: true,
      canSanitizeSvg: false,
      outputMimeType: "image/webp",
      summary: "EXIF, XMP, and ICC chunks can be stripped or preserved.",
    };
  }

  if (mimeType === "image/svg+xml") {
    return {
      mimeType,
      label: "SVG",
      canInspect: true,
      canClean: true,
      canEditText: true,
      canStripPrivateData: true,
      canStripComments: true,
      canPreserveColorProfile: false,
      canSanitizeSvg: true,
      outputMimeType: "image/svg+xml",
      summary: "Title, description, metadata nodes, comments, scripts, and references.",
    };
  }

  if (mimeType === "image/avif") {
    return {
      mimeType,
      label: "AVIF",
      canInspect: true,
      canClean: false,
      canEditText: false,
      canStripPrivateData: false,
      canStripComments: false,
      canPreserveColorProfile: false,
      canSanitizeSvg: false,
      summary: "Inspect-only for now; AVIF metadata writing is container-specific.",
    };
  }

  if (mimeType === "image/gif") {
    return {
      mimeType,
      label: "GIF",
      canInspect: true,
      canClean: false,
      canEditText: false,
      canStripPrivateData: false,
      canStripComments: false,
      canPreserveColorProfile: false,
      canSanitizeSvg: false,
      summary: "Inspect-only for now; GIF comments are not edited in this build.",
    };
  }

  return {
    mimeType,
    label: mimeType || "Unknown",
    canInspect: true,
    canClean: false,
    canEditText: false,
    canStripPrivateData: false,
    canStripComments: false,
    canPreserveColorProfile: false,
    canSanitizeSvg: false,
    summary: "Basic file inspection only.",
  };
}

export function canProcessMetadata(
  mimeType: string,
  options: MetadataOptions,
): boolean {
  const support = getMetadataFormatSupport(mimeType);
  return options.mode === "edit" ? support.canEditText : support.canClean;
}

export function getEffectiveMetadataOptions(
  mimeType: string,
  options: MetadataOptions,
): MetadataOptions {
  const support = getMetadataFormatSupport(mimeType);

  return {
    ...options,
    mode: options.mode === "edit" && !support.canEditText ? "clean" : options.mode,
    removeComments: support.canStripComments ? options.removeComments : false,
    removePrivateData: support.canStripPrivateData ? options.removePrivateData : false,
    preserveColorProfile: support.canPreserveColorProfile
      ? options.preserveColorProfile
      : true,
    sanitizeSvg: support.canSanitizeSvg ? options.sanitizeSvg : false,
  };
}

export function inspectMetadataSource(
  source: ImageJobSource,
): MetadataInspectionResult {
  const support = getMetadataFormatSupport(source.mimeType);
  const bytes = new Uint8Array(source.buffer);
  const entries: MetadataInspectionEntry[] = [
    metadataEntry("file-name", "File name", source.name, "File", false),
    metadataEntry(
      "mime-type",
      "MIME type",
      source.mimeType || "unknown",
      "File",
      false,
    ),
    metadataEntry(
      "dimensions",
      "Dimensions",
      `${source.width} x ${source.height}`,
      "File",
      false,
    ),
    metadataEntry(
      "file-size",
      "File size",
      formatMetadataBytes(source.size),
      "File",
      false,
    ),
  ];

  try {
    if (source.mimeType === "image/png") {
      entries.push(...inspectPngMetadata(bytes));
    } else if (source.mimeType === "image/jpeg") {
      entries.push(...inspectJpegMetadata(bytes));
    } else if (source.mimeType === "image/webp") {
      entries.push(...inspectWebpMetadata(bytes));
    } else if (source.mimeType === "image/svg+xml") {
      entries.push(...inspectSvgMetadata(bytes));
    } else {
      entries.push(
        metadataEntry("metadata-support", "Metadata", support.summary, "Format", false),
      );
    }
  } catch (error) {
    entries.push(
      metadataEntry(
        "metadata-read-error",
        "Read warning",
        error instanceof Error ? error.message : "Could not inspect metadata.",
        "Format",
        false,
      ),
    );
  }

  return {
    formatLabel: support.label,
    entries,
  };
}

export async function processMetadataSource(
  source: ImageJobSource,
  options: MetadataOptions,
): Promise<MetadataProcessResult> {
  const support = getMetadataFormatSupport(source.mimeType);
  const effectiveOptions = getEffectiveMetadataOptions(source.mimeType, options);

  if (
    !canProcessMetadata(source.mimeType, effectiveOptions) ||
    !support.outputMimeType
  ) {
    throw new Error(`${support.label} metadata writing is not supported yet.`);
  }

  const bytes = new Uint8Array(source.buffer);
  const result =
    source.mimeType === "image/jpeg"
      ? rewriteJpegMetadata(bytes, effectiveOptions)
      : source.mimeType === "image/png"
        ? rewritePngMetadata(bytes, effectiveOptions)
        : source.mimeType === "image/webp"
          ? rewriteWebpMetadata(bytes, effectiveOptions)
          : source.mimeType === "image/svg+xml"
            ? rewriteSvgMetadata(bytes, effectiveOptions)
            : undefined;

  if (!result) {
    throw new Error(`${support.label} metadata writing is not supported yet.`);
  }

  return {
    blob: new Blob([toArrayBuffer(result)], { type: support.outputMimeType }),
    mimeType: support.outputMimeType,
    width: source.width,
    height: source.height,
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function metadataEntry(
  id: string,
  label: string,
  value: string,
  group: string,
  editable: boolean,
  target?: MetadataEditableTarget,
): MetadataInspectionEntry {
  return {
    id,
    label,
    value,
    group,
    editable,
    target,
  };
}

function formatMetadataBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function summarizeMetadataText(value: string): string {
  return value.replace(/\0/g, "").trim();
}

function textTargetForKey(key: string): MetadataEditableTarget {
  const normalized = key.trim().toLowerCase();
  if (normalized === "title") {
    return { type: "field", field: "title" };
  }
  if (normalized === "description" || normalized === "desc") {
    return { type: "field", field: "description" };
  }
  if (normalized === "author" || normalized === "creator" || normalized === "artist") {
    return { type: "field", field: "creator" };
  }
  if (normalized === "copyright") {
    return { type: "field", field: "copyright" };
  }
  if (normalized === "keywords" || normalized === "subject") {
    return { type: "field", field: "keywords" };
  }

  return { type: "custom", key: key.trim() || "Metadata" };
}

function normalizeCustomTextFields(
  fields: MetadataCustomTextField[] | undefined,
): MetadataCustomTextField[] {
  const seen = new Set<string>();
  const normalized: MetadataCustomTextField[] = [];

  for (const field of fields ?? []) {
    const key = field.key.trim();
    if (!key || seen.has(key.toLowerCase())) {
      continue;
    }
    seen.add(key.toLowerCase());
    normalized.push({ key, value: field.value });
  }

  return normalized;
}

function hasTextFields(fields: MetadataTextFields): boolean {
  return Object.values(fields).some((value) => value.trim().length > 0);
}

function buildPlainTextMetadata(
  fields: MetadataTextFields,
  customTextFields: MetadataCustomTextField[] = [],
): string {
  return [
    ["Title", fields.title],
    ["Description", fields.description],
    ["Creator", fields.creator],
    ["Copyright", fields.copyright],
    ["Keywords", fields.keywords],
    ...normalizeCustomTextFields(customTextFields).map((field) => [
      field.key,
      field.value,
    ]),
  ]
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function latin1Text(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0xff ? code : 63;
  });
}

function writeUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  const crcInput = concatBytes([typeBytes, data]);
  return concatBytes([
    writeUint32(data.byteLength),
    typeBytes,
    data,
    writeUint32(crc32(crcInput)),
  ]);
}

function pngTextChunk(keyword: string, value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return pngChunk(
    "tEXt",
    concatBytes([latin1Text(keyword), new Uint8Array([0]), latin1Text(trimmed)]),
  );
}

function readPngChunkLength(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readLittleEndianUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function inspectPngMetadata(bytes: Uint8Array): MetadataInspectionEntry[] {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("Invalid PNG file.");
  }

  const entries: MetadataInspectionEntry[] = [];
  let offset = PNG_SIGNATURE.byteLength;
  let textIndex = 0;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = readPngChunkLength(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const dataOffset = offset + 8;
    const chunkEnd = offset + 12 + chunkLength;

    if (chunkEnd > bytes.byteLength) {
      throw new Error("Invalid PNG chunk length.");
    }

    const data = bytes.subarray(dataOffset, dataOffset + chunkLength);

    if (type === "tEXt") {
      const separator = data.indexOf(0);
      const key =
        separator >= 0 ? LATIN1_DECODER.decode(data.subarray(0, separator)) : "Text";
      const value =
        separator >= 0 ? LATIN1_DECODER.decode(data.subarray(separator + 1)) : "";
      entries.push(
        metadataEntry(
          `png-text-${textIndex}`,
          key || "Text",
          value,
          "PNG text",
          true,
          textTargetForKey(key),
        ),
      );
      textIndex += 1;
    } else if (type === "iTXt") {
      const parsed = parsePngInternationalText(data);
      entries.push(
        metadataEntry(
          `png-itxt-${textIndex}`,
          parsed.key || "International text",
          parsed.value,
          "PNG text",
          parsed.editable,
          parsed.editable ? textTargetForKey(parsed.key) : undefined,
        ),
      );
      textIndex += 1;
    } else if (type === "zTXt") {
      const separator = data.indexOf(0);
      const key =
        separator >= 0
          ? LATIN1_DECODER.decode(data.subarray(0, separator))
          : "Compressed text";
      entries.push(
        metadataEntry(
          `png-ztxt-${textIndex}`,
          key || "Compressed text",
          `Compressed text chunk (${formatMetadataBytes(chunkLength)})`,
          "PNG text",
          false,
        ),
      );
      textIndex += 1;
    } else if (type === "eXIf") {
      entries.push(
        metadataEntry(
          "png-exif",
          "EXIF",
          formatMetadataBytes(chunkLength),
          "PNG metadata",
          false,
        ),
        ...inspectExifPayload(data, "png-exif"),
      );
    } else if (type === "iCCP") {
      entries.push(
        metadataEntry(
          "png-icc",
          "ICC profile",
          formatMetadataBytes(chunkLength),
          "PNG color",
          false,
        ),
      );
    } else if (type === "gAMA" || type === "sRGB" || type === "cHRM") {
      entries.push(
        metadataEntry(
          `png-${type}`,
          type,
          formatMetadataBytes(chunkLength),
          "PNG color",
          false,
        ),
      );
    } else if (type === "pHYs") {
      entries.push(
        metadataEntry(
          "png-phys",
          "Pixel density",
          formatMetadataBytes(chunkLength),
          "PNG metadata",
          false,
        ),
      );
    }

    if (type === "IEND") {
      break;
    }
    offset = chunkEnd;
  }

  return entries.length
    ? entries
    : [
        metadataEntry(
          "png-no-metadata",
          "Metadata",
          "No editable PNG metadata chunks found.",
          "PNG metadata",
          false,
        ),
      ];
}

function parsePngInternationalText(data: Uint8Array): {
  key: string;
  value: string;
  editable: boolean;
} {
  let offset = 0;
  const readNullTerminated = (decoder: TextDecoder): string => {
    const end = data.indexOf(0, offset);
    const safeEnd = end >= 0 ? end : data.byteLength;
    const value = decoder.decode(data.subarray(offset, safeEnd));
    offset = safeEnd + 1;
    return value;
  };

  const key = readNullTerminated(LATIN1_DECODER);
  const compressionFlag = data[offset] ?? 1;
  offset += 2; // compression flag + compression method
  readNullTerminated(TEXT_DECODER); // language tag
  readNullTerminated(TEXT_DECODER); // translated keyword

  if (compressionFlag !== 0) {
    return {
      key,
      value: `Compressed international text (${formatMetadataBytes(data.byteLength)})`,
      editable: false,
    };
  }

  return {
    key,
    value: TEXT_DECODER.decode(data.subarray(offset)),
    editable: true,
  };
}

function rewritePngMetadata(bytes: Uint8Array, options: MetadataOptions): Uint8Array {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("Invalid PNG file.");
  }

  const chunks: Uint8Array[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.byteLength;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = readPngChunkLength(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    const chunkEnd = offset + 12 + chunkLength;

    if (chunkEnd > bytes.byteLength) {
      throw new Error("Invalid PNG chunk length.");
    }

    if (type === "IEND") {
      for (const chunk of buildPngTextChunks(
        options.fields,
        options.customTextFields,
      )) {
        chunks.push(chunk);
      }
      chunks.push(bytes.subarray(offset, chunkEnd));
      return concatBytes(chunks);
    }

    const isText = PNG_TEXT_CHUNKS.has(type);
    const isPrivate = type === "eXIf";
    const isColor =
      type === "iCCP" || type === "gAMA" || type === "sRGB" || type === "cHRM";
    const shouldRemove =
      (options.mode === "edit" && (isText || isPrivate)) ||
      (options.removeComments && isText) ||
      (options.removePrivateData && isPrivate) ||
      (!options.preserveColorProfile && isColor);

    if (!shouldRemove) {
      chunks.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  throw new Error("PNG file is missing an IEND chunk.");
}

function buildPngTextChunks(
  fields: MetadataTextFields,
  customTextFields: MetadataCustomTextField[] = [],
): Uint8Array[] {
  const chunks = [
    pngTextChunk("Title", fields.title),
    pngTextChunk("Description", fields.description),
    pngTextChunk("Author", fields.creator),
    pngTextChunk("Copyright", fields.copyright),
    pngTextChunk("Keywords", fields.keywords),
    ...normalizeCustomTextFields(customTextFields).map((field) =>
      pngTextChunk(field.key, field.value),
    ),
  ];

  return chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
}

function inspectWebpMetadata(bytes: Uint8Array): MetadataInspectionEntry[] {
  if (
    bytes.byteLength < 12 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    throw new Error("Invalid WebP file.");
  }

  const entries: MetadataInspectionEntry[] = [];
  let offset = 12;
  let chunkIndex = 0;

  while (offset + 8 <= bytes.byteLength) {
    const type = readAscii(bytes, offset, 4);
    const chunkLength = readLittleEndianUint32(bytes, offset + 4);
    const paddedLength = chunkLength + (chunkLength % 2);
    const payloadStart = offset + 8;
    const chunkEnd = payloadStart + paddedLength;

    if (chunkEnd > bytes.byteLength) {
      throw new Error("Invalid WebP chunk length.");
    }

    const payload = bytes.subarray(payloadStart, payloadStart + chunkLength);
    if (type === "EXIF") {
      entries.push(
        metadataEntry(
          `webp-exif-${chunkIndex}`,
          "EXIF block",
          formatMetadataBytes(chunkLength),
          "WebP EXIF",
          false,
        ),
        ...inspectExifPayload(payload, `webp-exif-${chunkIndex}`),
      );
    } else if (type === "XMP ") {
      entries.push(
        metadataEntry(
          `webp-xmp-${chunkIndex}`,
          "XMP packet",
          summarizeMetadataText(TEXT_DECODER.decode(payload)),
          "WebP XMP",
          false,
        ),
      );
    } else if (type === "ICCP") {
      entries.push(
        metadataEntry(
          `webp-icc-${chunkIndex}`,
          "ICC profile",
          formatMetadataBytes(chunkLength),
          "WebP color",
          false,
        ),
      );
    }

    chunkIndex += 1;
    offset = chunkEnd;
  }

  return entries.length
    ? entries
    : [
        metadataEntry(
          "webp-no-metadata",
          "Metadata",
          "No WebP metadata chunks found.",
          "WebP metadata",
          false,
        ),
      ];
}

function inspectSvgMetadata(bytes: Uint8Array): MetadataInspectionEntry[] {
  const text = TEXT_DECODER.decode(bytes);
  const parser = new DOMParser();
  const document = parser.parseFromString(text, "image/svg+xml");
  const parseError = document.querySelector("parsererror");

  if (parseError || document.documentElement.localName.toLowerCase() !== "svg") {
    throw new Error("Invalid SVG file.");
  }

  const root = document.documentElement;
  const entries: MetadataInspectionEntry[] = [];
  const title = getDirectSvgText(root, "title");
  const description = getDirectSvgText(root, "desc");

  if (title) {
    entries.push(
      metadataEntry("svg-title", "Title", title, "SVG text", true, {
        type: "field",
        field: "title",
      }),
    );
  }

  if (description) {
    entries.push(
      metadataEntry("svg-description", "Description", description, "SVG text", true, {
        type: "field",
        field: "description",
      }),
    );
  }

  Array.from(document.querySelectorAll("metadata")).forEach((node, index) => {
    const id = node.getAttribute("id");
    entries.push(
      metadataEntry(
        `svg-metadata-${index}`,
        id ? `Metadata node: ${id}` : `Metadata node ${index + 1}`,
        summarizeMetadataText(node.textContent ?? ""),
        "SVG metadata",
        true,
        { type: "custom", key: id ? `Metadata ${id}` : `Metadata ${index + 1}` },
      ),
    );
  });

  collectSvgComments(document).forEach((comment, index) => {
    entries.push(
      metadataEntry(
        `svg-comment-${index}`,
        `Comment ${index + 1}`,
        comment,
        "SVG comments",
        true,
        { type: "custom", key: `Comment ${index + 1}` },
      ),
    );
  });

  document.querySelectorAll("script, foreignObject").forEach((node, index) => {
    entries.push(
      metadataEntry(
        `svg-active-content-${index}`,
        node.localName,
        "Active SVG content",
        "SVG safety",
        false,
      ),
    );
  });

  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const isEvent = name.startsWith("on");
      const isReference = name === "href" || name === "xlink:href";
      const unsafeReference =
        isReference &&
        (/^https?:\/\//i.test(value) ||
          value.startsWith("//") ||
          /^javascript:/i.test(value));

      if (isEvent || unsafeReference) {
        entries.push(
          metadataEntry(
            `svg-attr-${entries.length}`,
            `${element.localName} ${attribute.name}`,
            value,
            "SVG safety",
            false,
          ),
        );
      }
    }
  });

  return entries.length
    ? entries
    : [
        metadataEntry(
          "svg-no-metadata",
          "Metadata",
          "No SVG metadata nodes, comments, or safety flags found.",
          "SVG metadata",
          false,
        ),
      ];
}

function getDirectSvgText(root: Element, tagName: "title" | "desc"): string {
  const node = Array.from(root.children).find(
    (child) => child.localName.toLowerCase() === tagName,
  );
  return summarizeMetadataText(node?.textContent ?? "");
}

function collectSvgComments(document: XMLDocument): string[] {
  const comments: string[] = [];

  function walk(node: Node): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) {
        comments.push(summarizeMetadataText(child.textContent ?? ""));
      } else {
        walk(child);
      }
    }
  }

  walk(document);
  return comments.filter(Boolean);
}

function inspectJpegMetadata(bytes: Uint8Array): MetadataInspectionEntry[] {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG file.");
  }

  const entries: MetadataInspectionEntry[] = [];
  let offset = 2;
  let commentIndex = 0;
  let segmentIndex = 0;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      break;
    }

    while (bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      throw new Error("Invalid JPEG segment.");
    }

    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const payloadStart = offset + 2;
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw new Error("Invalid JPEG segment length.");
    }

    const payload = bytes.subarray(payloadStart, segmentEnd);

    if (marker === 0xfe) {
      entries.push(
        metadataEntry(
          `jpeg-comment-${commentIndex}`,
          `Comment ${commentIndex + 1}`,
          TEXT_DECODER.decode(payload),
          "JPEG comment",
          true,
          { type: "custom", key: `Comment ${commentIndex + 1}` },
        ),
      );
      commentIndex += 1;
    } else if (marker === 0xe1 && startsWithAscii(payload, "Exif\0\0")) {
      entries.push(
        metadataEntry(
          `jpeg-exif-${segmentIndex}`,
          "EXIF block",
          formatMetadataBytes(payload.byteLength),
          "JPEG EXIF",
          false,
        ),
        ...inspectExifPayload(payload.subarray(6), `jpeg-exif-${segmentIndex}`),
      );
    } else if (
      marker === 0xe1 &&
      startsWithAscii(payload, "http://ns.adobe.com/xap/1.0/")
    ) {
      const xmpPrefixLength = "http://ns.adobe.com/xap/1.0/\0".length;
      entries.push(
        metadataEntry(
          `jpeg-xmp-${segmentIndex}`,
          "XMP packet",
          summarizeMetadataText(TEXT_DECODER.decode(payload.subarray(xmpPrefixLength))),
          "JPEG XMP",
          false,
        ),
      );
    } else if (marker === 0xe2 && startsWithAscii(payload, "ICC_PROFILE")) {
      entries.push(
        metadataEntry(
          `jpeg-icc-${segmentIndex}`,
          "ICC profile",
          formatMetadataBytes(payload.byteLength),
          "JPEG color",
          false,
        ),
      );
    } else if (marker === 0xed) {
      entries.push(
        metadataEntry(
          `jpeg-iptc-${segmentIndex}`,
          "IPTC / Photoshop block",
          formatMetadataBytes(payload.byteLength),
          "JPEG IPTC",
          false,
        ),
      );
    } else if (marker >= 0xe0 && marker <= 0xef) {
      entries.push(
        metadataEntry(
          `jpeg-app-${segmentIndex}`,
          `APP${marker - 0xe0} segment`,
          formatMetadataBytes(payload.byteLength),
          "JPEG metadata",
          false,
        ),
      );
    }

    segmentIndex += 1;
    offset = segmentEnd;
  }

  return entries.length
    ? entries
    : [
        metadataEntry(
          "jpeg-no-metadata",
          "Metadata",
          "No editable JPEG metadata blocks found.",
          "JPEG metadata",
          false,
        ),
      ];
}

const EXIF_TAG_LABELS: Record<number, string> = {
  0x010e: "Image description",
  0x010f: "Camera make",
  0x0110: "Camera model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "Date modified",
  0x013b: "Artist",
  0x8298: "Copyright",
  0x829a: "Exposure time",
  0x829d: "F-number",
  0x8769: "EXIF IFD offset",
  0x8825: "GPS IFD offset",
  0x8827: "ISO speed",
  0x9003: "Date original",
  0x9004: "Date digitized",
  0x9209: "Flash",
  0x920a: "Focal length",
  0xa002: "Pixel width",
  0xa003: "Pixel height",
};

function inspectExifPayload(
  tiff: Uint8Array,
  idPrefix: string,
): MetadataInspectionEntry[] {
  if (tiff.byteLength < 8) {
    return [];
  }

  const littleEndian =
    tiff[0] === 0x49 && tiff[1] === 0x49
      ? true
      : tiff[0] === 0x4d && tiff[1] === 0x4d
        ? false
        : undefined;
  if (littleEndian === undefined || readExifUint16(tiff, 2, littleEndian) !== 42) {
    return [];
  }

  const entries: MetadataInspectionEntry[] = [];
  const visited = new Set<number>();
  const ifd0Offset = readExifUint32(tiff, 4, littleEndian);
  inspectExifIfd(
    tiff,
    ifd0Offset,
    littleEndian,
    "EXIF fields",
    idPrefix,
    entries,
    visited,
  );
  return entries;
}

function inspectExifIfd(
  tiff: Uint8Array,
  offset: number,
  littleEndian: boolean,
  group: string,
  idPrefix: string,
  entries: MetadataInspectionEntry[],
  visited: Set<number>,
): void {
  if (offset <= 0 || offset + 2 > tiff.byteLength || visited.has(offset)) {
    return;
  }
  visited.add(offset);

  const count = readExifUint16(tiff, offset, littleEndian);
  const entriesStart = offset + 2;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = entriesStart + index * 12;
    if (entryOffset + 12 > tiff.byteLength) {
      break;
    }

    const tag = readExifUint16(tiff, entryOffset, littleEndian);
    const type = readExifUint16(tiff, entryOffset + 2, littleEndian);
    const valueCount = readExifUint32(tiff, entryOffset + 4, littleEndian);
    const value = readExifValue(tiff, entryOffset + 8, type, valueCount, littleEndian);
    const label = EXIF_TAG_LABELS[tag] ?? `EXIF 0x${tag.toString(16).padStart(4, "0")}`;

    entries.push(
      metadataEntry(`${idPrefix}-${tag}-${index}`, label, value, group, false),
    );

    if (tag === 0x8769 || tag === 0x8825) {
      const nestedOffset = readExifUint32(tiff, entryOffset + 8, littleEndian);
      inspectExifIfd(
        tiff,
        nestedOffset,
        littleEndian,
        tag === 0x8825 ? "GPS fields" : "EXIF fields",
        `${idPrefix}-${tag}`,
        entries,
        visited,
      );
    }
  }
}

function readExifValue(
  tiff: Uint8Array,
  valueOffset: number,
  type: number,
  count: number,
  littleEndian: boolean,
): string {
  const typeSize = exifTypeSize(type);
  const byteLength = typeSize * count;
  const dataOffset =
    byteLength <= 4 ? valueOffset : readExifUint32(tiff, valueOffset, littleEndian);
  if (dataOffset + byteLength > tiff.byteLength) {
    return `Invalid value (${byteLength} bytes)`;
  }

  const data = tiff.subarray(dataOffset, dataOffset + byteLength);
  if (type === 2) {
    return TEXT_DECODER.decode(data).replace(/\0+$/, "");
  }
  if (type === 7) {
    return `Undefined data (${formatMetadataBytes(byteLength)})`;
  }

  const values: string[] = [];
  const safeCount = Math.min(count, 16);
  for (let index = 0; index < safeCount; index += 1) {
    const offset = dataOffset + index * typeSize;
    if (type === 1) {
      values.push(String(tiff[offset]));
    } else if (type === 3) {
      values.push(String(readExifUint16(tiff, offset, littleEndian)));
    } else if (type === 4) {
      values.push(String(readExifUint32(tiff, offset, littleEndian)));
    } else if (type === 5) {
      const numerator = readExifUint32(tiff, offset, littleEndian);
      const denominator = readExifUint32(tiff, offset + 4, littleEndian);
      values.push(denominator ? `${numerator}/${denominator}` : String(numerator));
    } else if (type === 9) {
      values.push(String(readExifInt32(tiff, offset, littleEndian)));
    } else if (type === 10) {
      const numerator = readExifInt32(tiff, offset, littleEndian);
      const denominator = readExifInt32(tiff, offset + 4, littleEndian);
      values.push(denominator ? `${numerator}/${denominator}` : String(numerator));
    }
  }

  return `${values.join(", ")}${count > safeCount ? ", ..." : ""}`;
}

function exifTypeSize(type: number): number {
  if (type === 1 || type === 2 || type === 7) {
    return 1;
  }
  if (type === 3) {
    return 2;
  }
  if (type === 4 || type === 9) {
    return 4;
  }
  if (type === 5 || type === 10) {
    return 8;
  }
  return 1;
}

function readExifUint16(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function readExifUint32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  return littleEndian
    ? (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
        0
    : ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
        0;
}

function readExifInt32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  const unsigned = readExifUint32(bytes, offset, littleEndian);
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength + 2;
  if (length > 0xffff) {
    throw new Error("JPEG metadata is too large.");
  }

  return concatBytes([
    new Uint8Array([0xff, marker, (length >> 8) & 0xff, length & 0xff]),
    payload,
  ]);
}

function rewriteJpegMetadata(bytes: Uint8Array, options: MetadataOptions): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG file.");
  }

  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const comment = buildPlainTextMetadata(options.fields, options.customTextFields);
  if (options.mode === "edit" && comment) {
    parts.push(jpegSegment(0xfe, TEXT_ENCODER.encode(comment).subarray(0, 65530)));
  }

  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      parts.push(bytes.subarray(offset));
      return concatBytes(parts);
    }

    while (bytes[offset] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset];
    const segmentStart = offset - 1;
    offset += 1;

    if (marker === 0xda) {
      parts.push(bytes.subarray(segmentStart));
      return concatBytes(parts);
    }

    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(segmentStart, offset));
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      throw new Error("Invalid JPEG segment.");
    }

    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw new Error("Invalid JPEG segment length.");
    }

    const payload = bytes.subarray(offset + 2, segmentEnd);
    const isApp1 = marker === 0xe1;
    const isIptc = marker === 0xed;
    const isComment = marker === 0xfe;
    const isIcc = marker === 0xe2 && startsWithAscii(payload, "ICC_PROFILE");
    const shouldRemove =
      (options.mode === "edit" && (isApp1 || isIptc || isComment)) ||
      (options.removePrivateData && (isApp1 || isIptc)) ||
      (options.removeComments && isComment) ||
      (!options.preserveColorProfile && isIcc);

    if (!shouldRemove) {
      parts.push(bytes.subarray(segmentStart, segmentEnd));
    }

    offset = segmentEnd;
  }

  return concatBytes(parts);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[index] !== value.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function rewriteWebpMetadata(bytes: Uint8Array, options: MetadataOptions): Uint8Array {
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") {
    throw new Error("Invalid WebP file.");
  }

  if (
    options.mode === "edit" &&
    (hasTextFields(options.fields) ||
      normalizeCustomTextFields(options.customTextFields).some((field) =>
        field.value.trim(),
      ))
  ) {
    throw new Error("Text metadata editing is not supported for WebP yet.");
  }

  const parts: Uint8Array[] = [ascii("RIFF"), new Uint8Array(4), ascii("WEBP")];
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const type = readAscii(bytes, offset, 4);
    const length =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const chunkLength = length >>> 0;
    const paddedLength = chunkLength + (chunkLength % 2);
    const chunkEnd = offset + 8 + paddedLength;

    if (chunkEnd > bytes.byteLength) {
      throw new Error("Invalid WebP chunk length.");
    }

    const shouldRemove =
      (options.removePrivateData && (type === "EXIF" || type === "XMP ")) ||
      (!options.preserveColorProfile && type === "ICCP") ||
      (options.mode === "clean" && WEBP_METADATA_CHUNKS.has(type));

    if (!shouldRemove) {
      parts.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  const output = concatBytes(parts);
  const riffLength = output.byteLength - 8;
  output[4] = riffLength & 0xff;
  output[5] = (riffLength >> 8) & 0xff;
  output[6] = (riffLength >> 16) & 0xff;
  output[7] = (riffLength >> 24) & 0xff;
  return output;
}

function rewriteSvgMetadata(bytes: Uint8Array, options: MetadataOptions): Uint8Array {
  const text = TEXT_DECODER.decode(bytes);
  const parser = new DOMParser();
  const document = parser.parseFromString(text, "image/svg+xml");
  const parseError = document.querySelector("parsererror");

  if (parseError || document.documentElement.localName.toLowerCase() !== "svg") {
    throw new Error("Invalid SVG file.");
  }

  const root = document.documentElement;

  if (options.removePrivateData || options.mode === "edit") {
    document.querySelectorAll("metadata").forEach((node) => node.remove());
  }

  if (options.removeComments) {
    removeComments(document);
  }

  if (options.sanitizeSvg) {
    sanitizeSvg(document);
  }

  if (options.mode === "edit") {
    setSvgTextElement(document, root, "title", options.fields.title);
    setSvgTextElement(document, root, "desc", options.fields.description);

    const plainMetadata = buildPlainTextMetadata(
      {
        ...options.fields,
        title: "",
        description: "",
      },
      options.customTextFields,
    );
    if (plainMetadata) {
      const metadata = document.createElementNS(root.namespaceURI, "metadata");
      metadata.setAttribute("id", "privatepixel-metadata");
      metadata.textContent = plainMetadata;
      root.insertBefore(metadata, root.firstChild);
    }
  }

  const serialized = new XMLSerializer().serializeToString(document);
  return TEXT_ENCODER.encode(serialized);
}

function setSvgTextElement(
  document: XMLDocument,
  root: Element,
  tagName: "title" | "desc",
  value: string,
): void {
  const existing = Array.from(root.children).find(
    (child) => child.localName.toLowerCase() === tagName,
  );
  const trimmed = value.trim();

  if (!trimmed) {
    existing?.remove();
    return;
  }

  const element = existing ?? document.createElementNS(root.namespaceURI, tagName);
  element.textContent = trimmed;

  if (!existing) {
    root.insertBefore(element, root.firstChild);
  }
}

function removeComments(document: XMLDocument): void {
  const comments: ChildNode[] = [];

  function walk(node: Node): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) {
        comments.push(child);
      } else {
        walk(child);
      }
    }
  }

  walk(document);
  comments.forEach((comment) => comment.remove());
}

function sanitizeSvg(document: XMLDocument): void {
  document.querySelectorAll("script, foreignObject").forEach((node) => node.remove());

  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      const isEvent = name.startsWith("on");
      const isReference = name === "href" || name === "xlink:href";
      const isUnsafeReference =
        isReference &&
        (value.startsWith("http:") ||
          value.startsWith("https:") ||
          value.startsWith("//") ||
          value.startsWith("javascript:"));

      if (isEvent || isUnsafeReference) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}
