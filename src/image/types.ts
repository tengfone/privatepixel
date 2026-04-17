export type ImageTool =
  | "resize"
  | "compress"
  | "convert"
  | "crop"
  | "metadata"
  | "remove-background";

export type OutputMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/avif"
  | "image/svg+xml";

export type ResizeFitMode = "contain" | "cover" | "stretch";

export type RemoveBackgroundMode = "auto" | "portrait" | "general" | "best";

export interface ImageAsset {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  previewUrl: string;
}

export interface ImageJobSource {
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface ResizeOptions {
  width: number;
  height: number;
  lockAspectRatio: boolean;
  fitMode: ResizeFitMode;
  mimeType: OutputMimeType;
  quality: number;
}

export interface CompressOptions {
  mimeType: OutputMimeType;
  quality: number;
  maxDimension: number;
}

export interface ConvertOptions {
  mimeType: OutputMimeType;
  quality: number;
}

export interface CropOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  mimeType: OutputMimeType;
  quality: number;
}

export interface RemoveBackgroundOptions {
  outputMimeType: "image/png";
  mode: RemoveBackgroundMode;
}

export type MetadataMode = "clean" | "edit";

export interface MetadataTextFields {
  title: string;
  description: string;
  creator: string;
  copyright: string;
  keywords: string;
}

export interface MetadataOptions {
  mode: MetadataMode;
  fields: MetadataTextFields;
  removePrivateData: boolean;
  removeComments: boolean;
  preserveColorProfile: boolean;
  sanitizeSvg: boolean;
}

export type ImageOperation =
  | { type: "resize"; options: ResizeOptions }
  | { type: "compress"; options: CompressOptions }
  | { type: "convert"; options: ConvertOptions }
  | { type: "crop"; options: CropOptions }
  | { type: "metadata"; options: MetadataOptions }
  | { type: "remove-background"; options: RemoveBackgroundOptions };

export interface ImageJobRequest {
  jobId: string;
  assetId: string;
  source: ImageJobSource;
  operation: ImageOperation;
}

export interface ImageJobProgress {
  type: "progress";
  jobId: string;
  assetId: string;
  progress: number;
  message: string;
}

export interface ImageJobSuccess {
  type: "success";
  jobId: string;
  assetId: string;
  status: "success";
  blob: Blob;
  mimeType: OutputMimeType;
  size: number;
  width: number;
  height: number;
  filename: string;
  durationMs: number;
  error?: undefined;
}

export interface ImageJobFailure {
  type: "failure";
  jobId: string;
  assetId: string;
  status: "failure";
  blob?: undefined;
  mimeType?: undefined;
  size?: undefined;
  width?: undefined;
  height?: undefined;
  filename?: undefined;
  durationMs: number;
  error: string;
}

export type ImageJobResult = ImageJobSuccess | ImageJobFailure;

export type ImageWorkerInbound =
  | { type: "process"; request: ImageJobRequest }
  | { type: "cancel"; jobId: string };

export type ImageWorkerOutbound = ImageJobProgress | ImageJobResult;

export interface ProcessedImageResult extends ImageJobSuccess {
  url: string;
}
