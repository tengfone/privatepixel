import type {
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

interface MetadataProcessResult {
  blob: Blob;
  mimeType: OutputMimeType;
  width: number;
  height: number;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
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

function hasTextFields(fields: MetadataTextFields): boolean {
  return Object.values(fields).some((value) => value.trim().length > 0);
}

function buildPlainTextMetadata(fields: MetadataTextFields): string {
  return [
    ["Title", fields.title],
    ["Description", fields.description],
    ["Creator", fields.creator],
    ["Copyright", fields.copyright],
    ["Keywords", fields.keywords],
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

function rewritePngMetadata(bytes: Uint8Array, options: MetadataOptions): Uint8Array {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("Invalid PNG file.");
  }

  const chunks: Uint8Array[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.byteLength;

  while (offset + 12 <= bytes.byteLength) {
    const length =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
    const chunkLength = length >>> 0;
    const type = readAscii(bytes, offset + 4, 4);
    const chunkEnd = offset + 12 + chunkLength;

    if (chunkEnd > bytes.byteLength) {
      throw new Error("Invalid PNG chunk length.");
    }

    if (type === "IEND") {
      for (const chunk of buildPngTextChunks(options.fields)) {
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

function buildPngTextChunks(fields: MetadataTextFields): Uint8Array[] {
  const chunks = [
    pngTextChunk("Title", fields.title),
    pngTextChunk("Description", fields.description),
    pngTextChunk("Author", fields.creator),
    pngTextChunk("Copyright", fields.copyright),
    pngTextChunk("Keywords", fields.keywords),
  ];

  return chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
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
  const comment = buildPlainTextMetadata(options.fields);
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

  if (options.mode === "edit" && hasTextFields(options.fields)) {
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

    const plainMetadata = buildPlainTextMetadata({
      ...options.fields,
      title: "",
      description: "",
    });
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
