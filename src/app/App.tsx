import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";
import {
  ChangeEvent,
  DragEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createImageAsset,
  formatBytes,
  formatDimensions,
  revokeImageAsset,
} from "../image/assets";
import { downloadBlob } from "../image/download";
import {
  OUTPUT_MIME_TYPES,
  RESIZE_PRESETS,
  applyResizePreset,
  calculateResizeDimensions,
  calculateRotatedDimensions,
  clampQuality,
  createDefaultCompressOptions,
  createDefaultMetadataOptions,
  createDefaultRemoveBackgroundOptions,
  createDefaultResizeOptions,
  createObjectSelectOptions,
  getDefaultOutputMime,
  getMimeLabel,
  getOutputSizeDelta,
  isSupportedInputMime,
  normalizeRotationDegrees,
} from "../image/options";
import {
  canProcessMetadata,
  getEffectiveMetadataOptions,
  getMetadataFormatSupport,
  inspectMetadataSource,
  type MetadataEditableTarget,
  type MetadataInspectionEntry,
  type MetadataInspectionResult,
} from "../image/metadata";
import type {
  CompressOptions,
  ConvertOptions,
  CropOptions,
  ImageAsset,
  ImageJobProgress,
  ImageJobRequest,
  ImageOperation,
  ImageTool,
  MetadataOptions,
  ObjectSelectPoint,
  OutputMimeType,
  ProcessedImageResult,
  RemoveBackgroundMode,
  RemoveBackgroundOptions,
  ResizeFitMode,
  ResizeOptions,
} from "../image/types";
import { ImageWorkerClient } from "../workers/imageClient";

type JobStatus = "idle" | "queued" | "processing" | "done" | "error";
type CropAspect = "original" | "1:1" | "4:3" | "16:9";
type ResizeHandle = "width" | "height" | "both";
type AvailableImageTool = ImageTool;

interface ToolProcessedImageResult extends ProcessedImageResult {
  tool: AvailableImageTool;
}

interface AssetJobView {
  status: JobStatus;
  progress: number;
  message: string;
  result?: ToolProcessedImageResult;
  error?: string;
}

type SizePreviewStatus = "idle" | "working" | "ready" | "error";

interface SizePreviewResult {
  size: number;
  width: number;
  height: number;
  mimeType: OutputMimeType;
  durationMs: number;
}

interface SizePreviewState {
  key?: string;
  status: SizePreviewStatus;
  message: string;
  result?: SizePreviewResult;
  error?: string;
}

type MetadataInspectionStatus = "idle" | "ready" | "error";

interface MetadataInspectionState {
  assetId?: string;
  status: MetadataInspectionStatus;
  result?: MetadataInspectionResult;
  error?: string;
}

type ObjectSelectionStatus = "idle" | "working" | "ready" | "error";

interface ObjectSelectionState {
  assetId: string;
  point: ObjectSelectPoint;
  status: ObjectSelectionStatus;
  message: string;
  maskUrl?: string;
  error?: string;
}

interface CropPercentOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  mimeType: OutputMimeType;
  quality: number;
}

const TOOL_LABELS: Record<AvailableImageTool, string> = {
  resize: "Resize",
  compress: "Compress",
  convert: "Convert",
  crop: "Crop",
  metadata: "Metadata",
  "object-select": "Object Select",
  "remove-background": "Remove BG",
};

const TOOL_COPY: Record<AvailableImageTool, string> = {
  resize: "Drag the frame, zoom the canvas, or set exact output dimensions.",
  compress: "Make a smaller file with local browser encoding.",
  convert: "Choose a target image format.",
  crop: "Drag, zoom, rotate, and export the selected area.",
  metadata: "Inspect, clean, and edit metadata without uploading the file.",
  "object-select": "Click something in the image, then cut it out.",
  "remove-background": "Create a transparent PNG with local background removal.",
};

const REMOVE_BACKGROUND_MODE_COPY: Record<
  RemoveBackgroundMode,
  { label: string; detail: string }
> = {
  auto: {
    label: "Auto",
    detail: "Detects faces locally, then chooses a portrait or object model.",
  },
  portrait: {
    label: "Portrait (faster/lighter)",
    detail: "Uses MODNet for people and headshots.",
  },
  general: {
    label: "General objects",
    detail: "Uses RMBG-1.4 for products, animals, logos, and mixed scenes.",
  },
  best: {
    label: "Best result",
    detail: "Runs the routed model and fallback, then keeps the cleaner mask.",
  },
};

type MetadataTextFieldKey = keyof MetadataOptions["fields"];

const METADATA_TEXT_FIELD_CONTROLS: Array<{
  field: MetadataTextFieldKey;
  label: string;
}> = [
  { field: "title", label: "Title" },
  { field: "description", label: "Description" },
  { field: "creator", label: "Creator" },
  { field: "copyright", label: "Copyright" },
  { field: "keywords", label: "Keywords" },
];

const CROP_ASPECTS: Record<Exclude<CropAspect, "original">, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
};

const EMPTY_JOB: AssetJobView = {
  status: "idle",
  progress: 0,
  message: "Ready",
};

const EMPTY_SIZE_PREVIEW: SizePreviewState = {
  status: "idle",
  message: "Add an image to calculate output size.",
};

function createConvertOptions(): ConvertOptions {
  return {
    mimeType: "image/png",
    quality: 0.92,
  };
}

function createCropPercentOptions(asset?: ImageAsset): CropPercentOptions {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    mimeType: getDefaultOutputMime(asset),
    quality: 0.92,
  };
}

function getJobView(jobs: Record<string, AssetJobView>, assetId: string): AssetJobView {
  return jobs[assetId] ?? EMPTY_JOB;
}

function getCropAspect(asset: ImageAsset | undefined, cropAspect: CropAspect): number {
  if (cropAspect === "original") {
    return asset ? asset.width / asset.height : 1;
  }

  return CROP_ASPECTS[cropAspect];
}

function buildCropFromPercent(
  asset: ImageAsset,
  cropPercent: CropPercentOptions,
): CropOptions {
  const rotation = normalizeRotationDegrees(cropPercent.rotation);
  const cropSource = calculateRotatedDimensions(asset.width, asset.height, rotation);

  return {
    x: Math.round((cropSource.width * cropPercent.x) / 100),
    y: Math.round((cropSource.height * cropPercent.y) / 100),
    width: Math.round((cropSource.width * cropPercent.width) / 100),
    height: Math.round((cropSource.height * cropPercent.height) / 100),
    rotation,
    mimeType: cropPercent.mimeType,
    quality: cropPercent.quality,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(5, value));
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFramePosition(
  position: Point,
  frameWidth: number,
  frameHeight: number,
): Point {
  return {
    x: clampValue(position.x, 0, Math.max(0, 100 - frameWidth)),
    y: clampValue(position.y, 0, Math.max(0, 100 - frameHeight)),
  };
}

function clampUnit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0.5;
  }

  return clampValue(value, 0, 1);
}

function anchorToFramePosition(
  anchorX: number | undefined,
  anchorY: number | undefined,
  frameWidth: number,
  frameHeight: number,
): Point {
  return {
    x: Math.max(0, 100 - frameWidth) * clampUnit(anchorX),
    y: Math.max(0, 100 - frameHeight) * clampUnit(anchorY),
  };
}

function framePositionToAnchors(
  position: Point,
  frameWidth: number,
  frameHeight: number,
): Pick<ResizeOptions, "cropAnchorX" | "cropAnchorY"> {
  const maxX = Math.max(0, 100 - frameWidth);
  const maxY = Math.max(0, 100 - frameHeight);

  return {
    cropAnchorX: maxX > 0 ? clampValue(position.x / maxX, 0, 1) : 0.5,
    cropAnchorY: maxY > 0 ? clampValue(position.y / maxY, 0, 1) : 0.5,
  };
}

export function App() {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, AssetJobView>>({});
  const [activeTool, setActiveTool] = useState<AvailableImageTool>("resize");
  const [resizeOptions, setResizeOptions] = useState<ResizeOptions>(
    createDefaultResizeOptions(),
  );
  const [compressOptions, setCompressOptions] = useState<CompressOptions>(
    createDefaultCompressOptions(),
  );
  const [convertOptions, setConvertOptions] =
    useState<ConvertOptions>(createConvertOptions());
  const [removeBackgroundOptions, setRemoveBackgroundOptions] =
    useState<RemoveBackgroundOptions>(createDefaultRemoveBackgroundOptions());
  const [metadataOptions, setMetadataOptions] = useState<MetadataOptions>(
    createDefaultMetadataOptions(),
  );
  const [cropAspect, setCropAspect] = useState<CropAspect>("original");
  const [cropPercent, setCropPercent] = useState(createCropPercentOptions);
  const [cropPosition, setCropPosition] = useState<Point>({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [resizeViewZoom, setResizeViewZoom] = useState(1);
  const [previewViewZoom, setPreviewViewZoom] = useState(1);
  const [concurrency, setConcurrency] = useState(2);
  const [notice, setNotice] = useState("Images stay in this browser session.");
  const [sizePreview, setSizePreview] = useState<SizePreviewState>(EMPTY_SIZE_PREVIEW);
  const [objectSelection, setObjectSelection] = useState<ObjectSelectionState | null>(
    null,
  );
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const workerRef = useRef<ImageWorkerClient | null>(null);
  const runTokenRef = useRef(0);
  const objectSelectionTokenRef = useRef(0);
  const objectSelectionJobIdRef = useRef<string | null>(null);
  const activeJobIdsRef = useRef(new Set<string>());
  const activeJobAssetIdRef = useRef(new Map<string, string>());
  const activeAssetJobIdsRef = useRef(new Map<string, Set<string>>());
  const assetIdsRef = useRef(new Set<string>());
  const assetUrlsRef = useRef(new Set<string>());
  const resultUrlsRef = useRef(new Set<string>());
  const selectionUrlsRef = useRef(new Set<string>());

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0],
    [assets, selectedAssetId],
  );

  const completedResults = useMemo(
    () =>
      assets
        .map((asset) => getJobView(jobs, asset.id).result)
        .filter((result): result is ToolProcessedImageResult => Boolean(result)),
    [assets, jobs],
  );
  const currentObjectSelection =
    selectedAsset && objectSelection?.assetId === selectedAsset.id
      ? objectSelection
      : undefined;
  const activeToolCannotRun =
    activeTool === "metadata" && selectedAsset
      ? !canProcessMetadata(
          selectedAsset.mimeType,
          getEffectiveMetadataOptions(selectedAsset.mimeType, metadataOptions),
        )
      : activeTool === "object-select"
        ? currentObjectSelection?.status !== "ready"
        : false;

  const sizePreviewKey = useMemo(
    () =>
      selectedAsset
        ? JSON.stringify({
            activeTool,
            assetId: selectedAsset.id,
            compressOptions,
            convertOptions,
            cropPercent,
            metadataOptions,
            resizeOptions,
          })
        : "empty",
    [
      activeTool,
      compressOptions,
      convertOptions,
      cropPercent,
      metadataOptions,
      resizeOptions,
      selectedAsset,
    ],
  );

  const displayedSizePreview = useMemo<SizePreviewState>(() => {
    if (!selectedAsset) {
      return EMPTY_SIZE_PREVIEW;
    }

    if (activeTool === "remove-background") {
      return {
        status: "idle",
        message:
          "Run Remove BG to create a transparent PNG. Models load only when needed.",
      };
    }

    if (activeTool === "object-select") {
      if (currentObjectSelection?.status === "working") {
        return {
          status: "working",
          message: currentObjectSelection.message,
        };
      }

      if (currentObjectSelection?.status === "ready") {
        return {
          status: "idle",
          message: "Selection ready. Cut it out when you are happy.",
        };
      }

      if (currentObjectSelection?.status === "error") {
        return {
          status: "error",
          message: "Could not select that object.",
          error: currentObjectSelection.error,
        };
      }

      return {
        status: "idle",
        message: "Click the object you want to cut out.",
      };
    }

    if (
      activeTool === "metadata" &&
      !canProcessMetadata(
        selectedAsset.mimeType,
        getEffectiveMetadataOptions(selectedAsset.mimeType, metadataOptions),
      )
    ) {
      return {
        status: "idle",
        message: "Metadata writing is not available for this format yet.",
      };
    }

    if (isProcessing) {
      return {
        status: "idle",
        message: "Live size is paused during batch processing.",
      };
    }

    if (sizePreview.key !== sizePreviewKey) {
      return {
        key: sizePreviewKey,
        status: "working",
        message: "Preparing local size preview.",
      };
    }

    return sizePreview;
  }, [
    activeTool,
    currentObjectSelection,
    isProcessing,
    metadataOptions,
    selectedAsset,
    sizePreview,
    sizePreviewKey,
  ]);

  useEffect(() => {
    const activeJobIds = activeJobIdsRef.current;
    const assetUrls = assetUrlsRef.current;
    const resultUrls = resultUrlsRef.current;
    const selectionUrls = selectionUrlsRef.current;

    return () => {
      const worker = workerRef.current;
      for (const jobId of activeJobIds) {
        worker?.cancel(jobId);
      }
      worker?.destroy();
      for (const url of assetUrls) {
        URL.revokeObjectURL(url);
      }
      for (const url of resultUrls) {
        URL.revokeObjectURL(url);
      }
      for (const url of selectionUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    assetIdsRef.current = new Set(assets.map((asset) => asset.id));
  }, [assets]);

  const getWorker = useCallback((): ImageWorkerClient => {
    workerRef.current ??= new ImageWorkerClient();
    return workerRef.current;
  }, []);

  function trackActiveJob(assetId: string, jobId: string): void {
    activeJobIdsRef.current.add(jobId);
    activeJobAssetIdRef.current.set(jobId, assetId);

    const assetJobIds = activeAssetJobIdsRef.current.get(assetId) ?? new Set<string>();
    assetJobIds.add(jobId);
    activeAssetJobIdsRef.current.set(assetId, assetJobIds);
  }

  function untrackActiveJob(jobId: string): void {
    activeJobIdsRef.current.delete(jobId);

    const assetId = activeJobAssetIdRef.current.get(jobId);
    if (!assetId) {
      return;
    }

    activeJobAssetIdRef.current.delete(jobId);
    const assetJobIds = activeAssetJobIdsRef.current.get(assetId);
    assetJobIds?.delete(jobId);
    if (assetJobIds && !assetJobIds.size) {
      activeAssetJobIdsRef.current.delete(assetId);
    }
  }

  function cancelAssetJobs(assetId: string): void {
    const jobIds = activeAssetJobIdsRef.current.get(assetId);
    if (!jobIds) {
      return;
    }

    for (const jobId of Array.from(jobIds)) {
      workerRef.current?.cancel(jobId);
      untrackActiveJob(jobId);
      if (objectSelectionJobIdRef.current === jobId) {
        objectSelectionJobIdRef.current = null;
      }
    }
  }

  function updateJob(assetId: string, update: Partial<AssetJobView>): void {
    setJobs((current) => ({
      ...current,
      [assetId]: {
        ...getJobView(current, assetId),
        ...update,
      },
    }));
  }

  function setJobResult(assetId: string, result: ToolProcessedImageResult): void {
    setJobs((current) => {
      const previous = current[assetId]?.result;
      if (previous) {
        resultUrlsRef.current.delete(previous.url);
        URL.revokeObjectURL(previous.url);
      }

      return {
        ...current,
        [assetId]: {
          status: "done",
          progress: 100,
          message: "Ready to download",
          result,
        },
      };
    });
  }

  function replaceObjectSelection(selection: ObjectSelectionState | null): void {
    setObjectSelection((current) => {
      if (current?.maskUrl) {
        selectionUrlsRef.current.delete(current.maskUrl);
        URL.revokeObjectURL(current.maskUrl);
      }

      return selection;
    });
  }

  function clearObjectSelection(): void {
    objectSelectionTokenRef.current += 1;
    const jobId = objectSelectionJobIdRef.current;
    if (jobId) {
      workerRef.current?.cancel(jobId);
      untrackActiveJob(jobId);
      objectSelectionJobIdRef.current = null;
    }
    replaceObjectSelection(null);
    setNotice("Selection cleared.");
  }

  async function importFiles(fileList: FileList | File[]): Promise<void> {
    const files = Array.from(fileList).filter((file) =>
      isSupportedInputMime(file.type),
    );

    if (!files.length) {
      setNotice("Add PNG, JPEG, WebP, GIF, BMP, or AVIF images.");
      return;
    }

    setNotice("Reading local image metadata.");

    const settled = await Promise.allSettled(files.map(createImageAsset));
    const imported: ImageAsset[] = [];
    const failed = settled.filter((entry) => entry.status === "rejected").length;

    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        imported.push(entry.value);
        assetUrlsRef.current.add(entry.value.previewUrl);
      }
    }

    setAssets((current) => [...current, ...imported]);
    if (!assets.length && imported[0]) {
      setSelectedAssetId(imported[0].id);
      setResizeOptions(createDefaultResizeOptions(imported[0]));
      setCropPercent(createCropPercentOptions(imported[0]));
    }
    setNotice(
      failed
        ? `Imported ${imported.length} image${imported.length === 1 ? "" : "s"}; ${failed} could not be decoded.`
        : `Imported ${imported.length} image${imported.length === 1 ? "" : "s"} locally.`,
    );
  }

  function removeAsset(assetId: string): void {
    const asset = assets.find((candidate) => candidate.id === assetId);
    const result = jobs[assetId]?.result;

    assetIdsRef.current.delete(assetId);
    cancelAssetJobs(assetId);
    if (objectSelection?.assetId === assetId) {
      objectSelectionTokenRef.current += 1;
      replaceObjectSelection(null);
    }

    if (asset) {
      assetUrlsRef.current.delete(asset.previewUrl);
      revokeImageAsset(asset);
    }

    if (result) {
      resultUrlsRef.current.delete(result.url);
      URL.revokeObjectURL(result.url);
    }

    setAssets((current) => {
      const next = current.filter((candidate) => candidate.id !== assetId);
      if (selectedAssetId === assetId) {
        setSelectedAssetId(next[0]?.id ?? null);
      }
      return next;
    });
    setJobs((current) => {
      const next = { ...current };
      delete next[assetId];
      return next;
    });
  }

  function clearAll(): void {
    cancelProcessing();
    for (const asset of assets) {
      assetUrlsRef.current.delete(asset.previewUrl);
      revokeImageAsset(asset);
    }
    for (const result of Object.values(jobs)) {
      if (result.result) {
        resultUrlsRef.current.delete(result.result.url);
        URL.revokeObjectURL(result.result.url);
      }
    }
    assetIdsRef.current.clear();
    setAssets([]);
    setSelectedAssetId(null);
    setJobs({});
    setNotice("Workspace cleared.");
  }

  const buildOperation = useCallback(
    (asset: ImageAsset): ImageOperation => {
      if (activeTool === "resize") {
        return {
          type: "resize",
          options: {
            ...resizeOptions,
            quality: clampQuality(resizeOptions.quality),
          },
        };
      }

      if (activeTool === "compress") {
        return {
          type: "compress",
          options: {
            ...compressOptions,
            quality: clampQuality(compressOptions.quality),
          },
        };
      }

      if (activeTool === "convert") {
        return {
          type: "convert",
          options: {
            ...convertOptions,
            quality: clampQuality(convertOptions.quality),
          },
        };
      }

      if (activeTool === "crop") {
        return { type: "crop", options: buildCropFromPercent(asset, cropPercent) };
      }

      if (activeTool === "metadata") {
        return {
          type: "metadata",
          options: getEffectiveMetadataOptions(asset.mimeType, metadataOptions),
        };
      }

      if (activeTool === "object-select") {
        if (
          !objectSelection ||
          objectSelection.assetId !== asset.id ||
          objectSelection.status !== "ready"
        ) {
          throw new Error("Click an object before cutting it out.");
        }

        return {
          type: "object-select",
          options: createObjectSelectOptions(objectSelection.point, "cutout"),
        };
      }

      return {
        type: "remove-background",
        options: removeBackgroundOptions,
      };
    },
    [
      activeTool,
      compressOptions,
      convertOptions,
      cropPercent,
      metadataOptions,
      objectSelection,
      removeBackgroundOptions,
      resizeOptions,
    ],
  );

  useEffect(() => {
    if (
      !selectedAsset ||
      activeTool === "remove-background" ||
      activeTool === "object-select" ||
      (activeTool === "metadata" &&
        !canProcessMetadata(
          selectedAsset.mimeType,
          getEffectiveMetadataOptions(selectedAsset.mimeType, metadataOptions),
        )) ||
      isProcessing
    ) {
      return;
    }

    let stale = false;
    const jobId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      async function calculatePreview(): Promise<void> {
        setSizePreview({
          key: sizePreviewKey,
          status: "working",
          message: "Encoding a local size preview.",
        });

        try {
          const buffer = await selectedAsset.file.arrayBuffer();
          if (stale) {
            return;
          }

          trackActiveJob(selectedAsset.id, jobId);
          const request: ImageJobRequest = {
            jobId,
            assetId: selectedAsset.id,
            source: {
              name: selectedAsset.name,
              mimeType: selectedAsset.mimeType,
              size: selectedAsset.size,
              width: selectedAsset.width,
              height: selectedAsset.height,
              buffer,
            },
            operation: buildOperation(selectedAsset),
          };

          const result = await getWorker().process(request, (progress) => {
            if (!stale && progress.progress >= 20) {
              setSizePreview({
                key: sizePreviewKey,
                status: "working",
                message: progress.message,
              });
            }
          });

          if (stale) {
            return;
          }

          setSizePreview({
            key: sizePreviewKey,
            status: "ready",
            message: "Exact size from a local browser encode.",
            result: {
              size: result.size,
              width: result.width,
              height: result.height,
              mimeType: result.mimeType,
              durationMs: result.durationMs,
            },
          });
        } catch (error) {
          if (stale) {
            return;
          }

          const message =
            error instanceof Error ? error.message : "Size preview failed.";
          if (message === "Job canceled") {
            return;
          }

          setSizePreview({
            key: sizePreviewKey,
            status: "error",
            message: "Could not calculate output size.",
            error: message,
          });
        } finally {
          untrackActiveJob(jobId);
        }
      }

      void calculatePreview();
    }, 350);

    return () => {
      stale = true;
      window.clearTimeout(timeout);
      workerRef.current?.cancel(jobId);
      untrackActiveJob(jobId);
    };
  }, [
    activeTool,
    getWorker,
    buildOperation,
    isProcessing,
    metadataOptions,
    selectedAsset,
    sizePreviewKey,
  ]);

  function handleProgress(progress: ImageJobProgress): void {
    updateJob(progress.assetId, {
      status: "processing",
      progress: progress.progress,
      message: progress.message,
    });
  }

  async function selectObjectAtPoint(point: ObjectSelectPoint): Promise<void> {
    if (!selectedAsset) {
      return;
    }

    const previousJobId = objectSelectionJobIdRef.current;
    if (previousJobId) {
      workerRef.current?.cancel(previousJobId);
      untrackActiveJob(previousJobId);
    }

    const token = objectSelectionTokenRef.current + 1;
    objectSelectionTokenRef.current = token;
    const jobId = crypto.randomUUID();
    objectSelectionJobIdRef.current = jobId;
    trackActiveJob(selectedAsset.id, jobId);
    replaceObjectSelection({
      assetId: selectedAsset.id,
      point,
      status: "working",
      message: "Finding selected object locally.",
    });
    setNotice("Finding the object you clicked. This stays local.");

    try {
      const buffer = await selectedAsset.file.arrayBuffer();
      if (objectSelectionTokenRef.current !== token) {
        return;
      }

      const request: ImageJobRequest = {
        jobId,
        assetId: selectedAsset.id,
        source: {
          name: selectedAsset.name,
          mimeType: selectedAsset.mimeType,
          size: selectedAsset.size,
          width: selectedAsset.width,
          height: selectedAsset.height,
          buffer,
        },
        operation: {
          type: "object-select",
          options: createObjectSelectOptions(point, "mask"),
        },
      };

      const result = await getWorker().process(request, (progress) => {
        if (objectSelectionTokenRef.current !== token) {
          return;
        }

        setObjectSelection((current) =>
          current?.assetId === selectedAsset.id
            ? {
                ...current,
                status: "working",
                message: progress.message,
              }
            : current,
        );
      });
      if (objectSelectionTokenRef.current !== token) {
        return;
      }

      const maskUrl = URL.createObjectURL(result.blob);
      selectionUrlsRef.current.add(maskUrl);
      replaceObjectSelection({
        assetId: selectedAsset.id,
        point,
        status: "ready",
        message: "Selection ready.",
        maskUrl,
      });
      setNotice("Selection ready. Cut it out when you are happy.");
    } catch (error) {
      if (objectSelectionTokenRef.current !== token) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Object selection failed.";
      if (message === "Job canceled") {
        return;
      }

      replaceObjectSelection({
        assetId: selectedAsset.id,
        point,
        status: "error",
        message: "Could not select that object.",
        error: message,
      });
      setNotice("Could not select that object.");
    } finally {
      untrackActiveJob(jobId);
      if (objectSelectionJobIdRef.current === jobId) {
        objectSelectionJobIdRef.current = null;
      }
    }
  }

  async function processAsset(asset: ImageAsset, runToken: number): Promise<void> {
    const jobId = crypto.randomUUID();
    trackActiveJob(asset.id, jobId);
    updateJob(asset.id, {
      status: "processing",
      progress: 1,
      message: "Starting",
      error: undefined,
    });

    try {
      const buffer = await asset.file.arrayBuffer();
      const request: ImageJobRequest = {
        jobId,
        assetId: asset.id,
        source: {
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          width: asset.width,
          height: asset.height,
          buffer,
        },
        operation: buildOperation(asset),
      };

      const result = await getWorker().process(request, handleProgress);
      if (runTokenRef.current !== runToken || !assetIdsRef.current.has(asset.id)) {
        return;
      }

      const url = URL.createObjectURL(result.blob);
      resultUrlsRef.current.add(url);
      setJobResult(asset.id, { ...result, url, tool: activeTool });
    } catch (error) {
      if (runTokenRef.current !== runToken || !assetIdsRef.current.has(asset.id)) {
        return;
      }

      updateJob(asset.id, {
        status: "error",
        progress: 0,
        message: "Failed",
        error: error instanceof Error ? error.message : "Processing failed.",
      });
    } finally {
      untrackActiveJob(jobId);
    }
  }

  async function processBatch(): Promise<void> {
    if (!assets.length) {
      setNotice("Add images before running a tool.");
      return;
    }

    if (activeToolCannotRun) {
      setNotice(
        activeTool === "object-select"
          ? "Click an object in the selected image first."
          : "This tool cannot run for the selected image.",
      );
      return;
    }

    const runAssets =
      activeTool === "object-select" && selectedAsset ? [selectedAsset] : assets;
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setIsProcessing(true);
    setNotice(
      activeTool === "remove-background"
        ? "Running Remove BG locally. Models load on first use."
        : activeTool === "object-select"
          ? "Cutting out the selected object locally."
          : `Running ${TOOL_LABELS[activeTool].toLowerCase()} locally.`,
    );

    setJobs((current) => {
      const next = { ...current };
      for (const asset of runAssets) {
        next[asset.id] = {
          ...getJobView(current, asset.id),
          status: "queued",
          progress: 0,
          message: "Queued",
          error: undefined,
        };
      }
      return next;
    });

    let cursor = 0;
    const workerCount =
      activeTool === "remove-background" || activeTool === "object-select"
        ? 1
        : Math.min(Math.max(1, concurrency), runAssets.length);

    async function consumeQueue(): Promise<void> {
      while (runTokenRef.current === runToken) {
        const asset = runAssets[cursor];
        cursor += 1;

        if (!asset) {
          return;
        }

        await processAsset(asset, runToken);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, consumeQueue));

    if (runTokenRef.current === runToken) {
      setIsProcessing(false);
      setNotice("Processing complete. Download results from the manifest.");
    }
  }

  function cancelProcessing(): void {
    runTokenRef.current += 1;
    for (const jobId of activeJobIdsRef.current) {
      workerRef.current?.cancel(jobId);
    }
    activeJobIdsRef.current.clear();
    activeJobAssetIdRef.current.clear();
    activeAssetJobIdsRef.current.clear();
    objectSelectionJobIdRef.current = null;
    setIsProcessing(false);
    setJobs((current) => {
      const next = { ...current };
      for (const [assetId, job] of Object.entries(next)) {
        if (job.status === "queued" || job.status === "processing") {
          next[assetId] = {
            ...job,
            status: "idle",
            progress: 0,
            message: "Canceled",
          };
        }
      }
      return next;
    });
    setNotice("Processing canceled.");
  }

  function downloadAll(): void {
    completedResults.forEach((result, index) => {
      window.setTimeout(() => downloadBlob(result.blob, result.filename), index * 250);
    });
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    const { files } = event.currentTarget;
    if (files) {
      void importFiles(files);
    }
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragging(false);
    void importFiles(event.dataTransfer.files);
  }

  return (
    <main className="app-shell">
      <header className="site-header" aria-label="Primary navigation">
        <a className="site-mark" href="#app">
          <img
            src={`${import.meta.env.BASE_URL}assets/private_pixel.png`}
            alt="PrivatePixel"
            height={28}
          />
          PrivatePixel
        </a>
        <nav className="site-nav" aria-label="Sections">
          <a className="active" href="#app">
            App
          </a>
          <a href="#local-first">Local-first</a>
          <a href="#about">About</a>
        </nav>
        <div className="site-status" aria-live="polite">
          <span>Existing selection</span>
          <strong>{selectedAsset ? selectedAsset.name : "No image selected"}</strong>
        </div>
      </header>

      <header className="masthead swiss-grid-pattern">
        <div className="masthead-index">
          <span>01</span>
          <span>PrivatePixel</span>
        </div>
        <h1>Local image editor</h1>
        <p>Resize, compress, convert, crop, remove backgrounds.</p>
      </header>

      <section
        id="app"
        className={`dropzone swiss-dots${isDragging ? " dropzone-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        data-testid="dropzone"
      >
        <div>
          <p className="eyebrow">02. Ingest</p>
          <h2>Drop images here</h2>
        </div>
        <p>{notice}</p>
        <label className="file-button">
          Choose images
          <input
            data-testid="file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml"
            multiple
            onChange={handleFileInput}
          />
        </label>
      </section>

      <section className="workbench" aria-label="PrivatePixel workspace">
        <aside className="tool-rail" aria-label="Tool selection">
          <p className="eyebrow">03. Method</p>
          {(Object.keys(TOOL_LABELS) as AvailableImageTool[]).map((tool, index) => (
            <button
              key={tool}
              className={tool === activeTool ? "active" : ""}
              type="button"
              onClick={() => setActiveTool(tool)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {TOOL_LABELS[tool]}
            </button>
          ))}
        </aside>

        <section className="stage-panel" aria-label="Image editor">
          <div className="section-heading">
            <div>
              <p className="eyebrow">04. Work area</p>
              <h2>{TOOL_LABELS[activeTool]}</h2>
            </div>
            <p>{TOOL_COPY[activeTool]}</p>
          </div>

          {selectedAsset ? (
            <EditorStage
              activeTool={activeTool}
              asset={selectedAsset}
              job={getJobView(jobs, selectedAsset.id)}
              resizeOptions={resizeOptions}
              resizeViewZoom={resizeViewZoom}
              previewViewZoom={previewViewZoom}
              cropAspect={cropAspect}
              cropPosition={cropPosition}
              cropZoom={cropZoom}
              cropRotation={cropPercent.rotation}
              objectSelection={currentObjectSelection}
              onResizeChange={setResizeOptions}
              onResizeViewZoomChange={setResizeViewZoom}
              onPreviewViewZoomChange={setPreviewViewZoom}
              onObjectSelectPoint={(point) => void selectObjectAtPoint(point)}
              onCropPositionChange={setCropPosition}
              onCropZoomChange={setCropZoom}
              onCropRotationChange={(rotation) =>
                setCropPercent((current) => ({
                  ...current,
                  rotation: normalizeRotationDegrees(rotation),
                }))
              }
              onCropAreaChange={(area) =>
                setCropPercent((current) => ({
                  ...current,
                  x: area.x,
                  y: area.y,
                  width: area.width,
                  height: area.height,
                }))
              }
            />
          ) : (
            <div className="empty-stage swiss-diagonal">
              <span>0</span>
              <p>Add images to open the local work area.</p>
            </div>
          )}
        </section>

        <aside className="control-panel" aria-label="Tool controls">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">05. Controls</p>
              <h2>Output</h2>
            </div>
          </div>

          {activeTool === "resize" ? (
            <ResizeControls
              asset={selectedAsset}
              options={resizeOptions}
              onChange={setResizeOptions}
            />
          ) : null}

          {activeTool === "compress" ? (
            <CompressControls options={compressOptions} onChange={setCompressOptions} />
          ) : null}

          {activeTool === "convert" ? (
            <ConvertControls options={convertOptions} onChange={setConvertOptions} />
          ) : null}

          {activeTool === "crop" ? (
            <CropControls
              cropAspect={cropAspect}
              cropPercent={cropPercent}
              cropZoom={cropZoom}
              onAspectChange={setCropAspect}
              onCropPercentChange={setCropPercent}
              onCropZoomChange={setCropZoom}
              onCropRotationChange={(rotation) =>
                setCropPercent((current) => ({
                  ...current,
                  rotation: normalizeRotationDegrees(rotation),
                }))
              }
            />
          ) : null}

          {activeTool === "metadata" ? (
            <MetadataControls
              asset={selectedAsset}
              options={metadataOptions}
              onChange={setMetadataOptions}
            />
          ) : null}

          {activeTool === "object-select" ? (
            <ObjectSelectControls
              selection={currentObjectSelection}
              onClear={clearObjectSelection}
            />
          ) : null}

          {activeTool === "remove-background" ? (
            <RemoveBackgroundControls
              options={removeBackgroundOptions}
              onChange={setRemoveBackgroundOptions}
            />
          ) : null}

          <SizePreviewPanel asset={selectedAsset} preview={displayedSizePreview} />

          <div className="runbar">
            <label>
              Batch speed
              <select
                value={
                  activeTool === "remove-background" || activeTool === "object-select"
                    ? 1
                    : concurrency
                }
                disabled={
                  activeTool === "remove-background" || activeTool === "object-select"
                }
                aria-describedby="batch-speed-note"
                onChange={(event) => setConcurrency(Number(event.target.value))}
              >
                <option value={1}>Safer</option>
                <option value={2}>Faster</option>
              </select>
            </label>
            <p id="batch-speed-note" className="runbar-note">
              {activeTool === "remove-background"
                ? "Remove BG works on one image at a time to keep local model memory stable."
                : activeTool === "object-select"
                  ? "Object Select works on the image you clicked."
                  : "Faster works on two images at once. Safer works on one."}
            </p>
            <button
              type="button"
              onClick={() => void processBatch()}
              disabled={isProcessing || !assets.length || activeToolCannotRun}
              data-testid="run-tool"
            >
              {activeTool === "object-select"
                ? "Cut Out Selection"
                : `Run ${TOOL_LABELS[activeTool]}`}
            </button>
            <button
              className="secondary"
              type="button"
              onClick={cancelProcessing}
              disabled={!isProcessing}
            >
              Cancel
            </button>
          </div>
        </aside>
      </section>

      <section className="manifest-panel" aria-label="Image queue">
        <div className="section-heading">
          <div>
            <p className="eyebrow">06. Manifest</p>
            <h2>
              {assets.length} image{assets.length === 1 ? "" : "s"}
            </h2>
          </div>
          <div className="queue-actions">
            <button
              className="secondary"
              type="button"
              onClick={downloadAll}
              disabled={!completedResults.length}
            >
              Download results
            </button>
            <button
              className="secondary danger"
              type="button"
              onClick={clearAll}
              disabled={!assets.length}
            >
              Clear
            </button>
          </div>
        </div>

        {assets.length ? (
          <div className="asset-manifest" data-testid="asset-grid">
            {assets.map((asset, index) => (
              <AssetItem
                key={asset.id}
                asset={asset}
                index={index}
                isSelected={selectedAsset?.id === asset.id}
                job={getJobView(jobs, asset.id)}
                onRemove={() => removeAsset(asset.id)}
                onSelect={() => {
                  setSelectedAssetId(asset.id);
                  setResizeOptions(createDefaultResizeOptions(asset));
                  setCropPercent(createCropPercentOptions(asset));
                }}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state swiss-dots">
            <h3>Your local queue is empty</h3>
            <p>Add images to preview metadata and run tools in batches.</p>
          </div>
        )}
      </section>

      <section
        id="local-first"
        className="local-proof-panel swiss-grid-pattern"
        aria-labelledby="local-first-title"
      >
        <div className="local-proof-copy">
          <p className="eyebrow">07. Local-first</p>
          <h2 id="local-first-title">Don't take our word for it. Verify it.</h2>
          <p>
            PrivatePixel opens images in your browser, runs the work on this device,
            and exports files only when you choose. No account. No server-side image
            processing. No hidden upload step.
          </p>
        </div>

        <div className="proof-steps" aria-label="Ways to verify PrivatePixel">
          <article className="proof-step">
            <span>01</span>
            <h3>Watch the network tab</h3>
            <p>Your image should not appear in request payloads while tools run.</p>
          </article>
          <article className="proof-step">
            <span>02</span>
            <h3>Read the source</h3>
            <p>The app, workers, local models, and WebAssembly path are public.</p>
          </article>
        </div>

        <div className="proof-actions" aria-label="Verification links">
          <a
            href="https://github.com/tengfone/privatepixel"
            target="_blank"
            rel="noreferrer"
          >
            View source on GitHub
          </a>
        </div>
      </section>

      <section
        id="about"
        className="about-panel swiss-diagonal"
        aria-labelledby="about-title"
      >
        <div>
          <p className="eyebrow">08. About</p>
          <h2 id="about-title">Private image work, kept local.</h2>
        </div>
        <div className="about-copy">
          <p>
            Resize, compress, convert, crop, and export images in this browser. Source
            files stay in memory on this device; no server processing, accounts,
            paywalls, or watermarks.
          </p>
          <div className="about-links" aria-label="Project links">
            <a href="https://tengfone.dev" target="_blank" rel="noreferrer">
              Made with love - tengfone.dev
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

interface EditorStageProps {
  activeTool: AvailableImageTool;
  asset: ImageAsset;
  job: AssetJobView;
  resizeOptions: ResizeOptions;
  resizeViewZoom: number;
  previewViewZoom: number;
  cropAspect: CropAspect;
  cropPosition: Point;
  cropZoom: number;
  cropRotation: number;
  objectSelection?: ObjectSelectionState;
  onResizeChange: (options: ResizeOptions) => void;
  onResizeViewZoomChange: (zoom: number) => void;
  onPreviewViewZoomChange: (zoom: number) => void;
  onObjectSelectPoint: (point: ObjectSelectPoint) => void;
  onCropPositionChange: (position: Point) => void;
  onCropZoomChange: (zoom: number) => void;
  onCropRotationChange: (rotation: number) => void;
  onCropAreaChange: (area: Area) => void;
}

function EditorStage({
  activeTool,
  asset,
  job,
  resizeOptions,
  resizeViewZoom,
  previewViewZoom,
  cropAspect,
  cropPosition,
  cropZoom,
  cropRotation,
  objectSelection,
  onResizeChange,
  onResizeViewZoomChange,
  onPreviewViewZoomChange,
  onObjectSelectPoint,
  onCropPositionChange,
  onCropZoomChange,
  onCropRotationChange,
  onCropAreaChange,
}: EditorStageProps) {
  const result = job.result?.tool === activeTool ? job.result : undefined;

  if (activeTool === "crop") {
    return (
      <div className="editor-stage crop-stage">
        <Cropper
          image={asset.previewUrl}
          crop={cropPosition}
          zoom={cropZoom}
          rotation={cropRotation}
          aspect={getCropAspect(asset, cropAspect)}
          onCropChange={onCropPositionChange}
          onZoomChange={onCropZoomChange}
          onRotationChange={onCropRotationChange}
          onCropComplete={onCropAreaChange}
          showGrid
          classes={{
            containerClassName: "cropper-container",
            cropAreaClassName: "cropper-area",
          }}
        />
        <StageMeta asset={asset} result={result} />
      </div>
    );
  }

  if (activeTool === "resize") {
    return (
      <ResizeStage
        asset={asset}
        options={resizeOptions}
        viewZoom={resizeViewZoom}
        result={result}
        onChange={onResizeChange}
        onViewZoomChange={onResizeViewZoomChange}
      />
    );
  }

  return (
    <PreviewStage
      key={`${asset.id}-${result?.url ?? "source"}`}
      asset={asset}
      result={result}
      viewZoom={previewViewZoom}
      isObjectSelectActive={activeTool === "object-select"}
      objectSelection={objectSelection}
      onObjectSelectPoint={onObjectSelectPoint}
      onViewZoomChange={onPreviewViewZoomChange}
    />
  );
}

interface PreviewStageProps {
  asset: ImageAsset;
  result?: ProcessedImageResult;
  viewZoom: number;
  isObjectSelectActive: boolean;
  objectSelection?: ObjectSelectionState;
  onObjectSelectPoint: (point: ObjectSelectPoint) => void;
  onViewZoomChange: (zoom: number) => void;
}

function PreviewStage({
  asset,
  result,
  viewZoom,
  isObjectSelectActive,
  objectSelection,
  onObjectSelectPoint,
  onViewZoomChange,
}: PreviewStageProps) {
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{
    pointerId: number;
    origin: Point;
    pan: Point;
  } | null>(null);

  function changeViewZoom(nextZoom: number): void {
    onViewZoomChange(clampValue(nextZoom, 0.5, 3));
  }

  function resetView(): void {
    setPan({ x: 0, y: 0 });
    onViewZoomChange(1);
  }

  function startPan(event: PointerEvent<HTMLElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      pan,
    };
    setIsPanning(true);
  }

  function updatePan(event: PointerEvent<HTMLElement>): void {
    const dragStart = dragStartRef.current;
    if (!dragStart || dragStart.pointerId !== event.pointerId) {
      return;
    }

    setPan({
      x: dragStart.pan.x + event.clientX - dragStart.origin.x,
      y: dragStart.pan.y + event.clientY - dragStart.origin.y,
    });
  }

  function maybeSelectObject(event: PointerEvent<HTMLElement>): void {
    const image = sourceImageRef.current;
    if (!isObjectSelectActive || !image) {
      return;
    }

    const rect = image.getBoundingClientRect();
    const rawX = (event.clientX - rect.left) / rect.width;
    const rawY = (event.clientY - rect.top) / rect.height;
    if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) {
      return;
    }

    onObjectSelectPoint({
      x: clampValue(rawX, 0, 1),
      y: clampValue(rawY, 0, 1),
    });
  }

  function endPan(event: PointerEvent<HTMLElement>, isSource = false): void {
    const dragStart = dragStartRef.current;
    if (!dragStart || dragStart.pointerId !== event.pointerId) {
      return;
    }

    const dragDistance = Math.hypot(
      event.clientX - dragStart.origin.x,
      event.clientY - dragStart.origin.y,
    );
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    setIsPanning(false);
    if (isSource && dragDistance <= 4) {
      maybeSelectObject(event);
    }
  }

  function renderPreviewFigure(src: string, alt: string, isSource = false) {
    const visibleObjectSelection =
      isSource && isObjectSelectActive ? objectSelection : undefined;

    return (
      <figure
        className={[
          isPanning ? "is-panning" : "",
          isSource && isObjectSelectActive ? "is-object-selectable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerDown={startPan}
        onPointerMove={updatePan}
        onPointerUp={(event) => endPan(event, isSource)}
        onPointerCancel={(event) => endPan(event)}
      >
        <div
          className={`preview-canvas ${isPanning ? "is-panning" : ""}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${viewZoom})`,
          }}
        >
          <div className="preview-image-stack">
            <img ref={isSource ? sourceImageRef : undefined} src={src} alt={alt} />
            {visibleObjectSelection?.maskUrl ? (
              <img
                className="selection-mask"
                src={visibleObjectSelection.maskUrl}
                alt=""
                aria-hidden="true"
              />
            ) : null}
            {visibleObjectSelection ? (
              <span
                className={`selection-click-dot ${
                  visibleObjectSelection.status === "working" ? "is-working" : ""
                }`}
                style={{
                  left: `${visibleObjectSelection.point.x * 100}%`,
                  top: `${visibleObjectSelection.point.y * 100}%`,
                }}
                aria-hidden="true"
              />
            ) : null}
          </div>
        </div>
      </figure>
    );
  }

  return (
    <div
      className={`editor-stage preview-stage ${
        result ? "preview-stage-compare" : "preview-stage-single"
      } swiss-grid-pattern`}
      onWheel={(event) => {
        event.preventDefault();
        changeViewZoom(viewZoom + (event.deltaY > 0 ? -0.1 : 0.1));
      }}
    >
      <div
        className="resize-zoom-tools preview-zoom-tools"
        aria-label="Preview zoom controls"
      >
        <button type="button" onClick={() => changeViewZoom(viewZoom - 0.25)}>
          -
        </button>
        <span>{Math.round(viewZoom * 100)}%</span>
        <button type="button" onClick={() => changeViewZoom(viewZoom + 0.25)}>
          +
        </button>
        <button type="button" onClick={resetView}>
          Fit
        </button>
      </div>
      {renderPreviewFigure(asset.previewUrl, `Selected ${asset.name}`, true)}
      {result ? renderPreviewFigure(result.url, `Processed ${asset.name}`) : null}
      <StageMeta asset={asset} result={result} />
    </div>
  );
}

interface ResizeStageProps {
  asset: ImageAsset;
  options: ResizeOptions;
  viewZoom: number;
  result?: ProcessedImageResult;
  onChange: (options: ResizeOptions) => void;
  onViewZoomChange: (zoom: number) => void;
}

function ResizeStage({
  asset,
  options,
  viewZoom,
  result,
  onChange,
  onViewZoomChange,
}: ResizeStageProps) {
  const output = calculateResizeDimensions({
    sourceWidth: asset.width,
    sourceHeight: asset.height,
    targetWidth: options.width,
    targetHeight: options.height,
    fitMode: options.fitMode,
    lockAspectRatio: options.lockAspectRatio,
  });
  const frameWidth = clampPercent((output.width / asset.width) * 100);
  const frameHeight = clampPercent((output.height / asset.height) * 100);
  const boundedFramePosition = clampFramePosition(
    anchorToFramePosition(
      options.cropAnchorX,
      options.cropAnchorY,
      frameWidth,
      frameHeight,
    ),
    frameWidth,
    frameHeight,
  );

  function updateFromPointer(
    event: PointerEvent<HTMLButtonElement> | globalThis.PointerEvent,
    handle: ResizeHandle,
    rect: DOMRect,
  ): void {
    const widthRatio = Math.min(
      1,
      Math.max(0.05, (event.clientX - rect.left) / rect.width),
    );
    const heightRatio = Math.min(
      1,
      Math.max(0.05, (event.clientY - rect.top) / rect.height),
    );
    const nextWidth =
      handle === "height" ? options.width : Math.round(asset.width * widthRatio);
    const nextHeight =
      handle === "width" ? options.height : Math.round(asset.height * heightRatio);

    if (options.lockAspectRatio) {
      const lockedRatio =
        options.width > 0 && options.height > 0
          ? options.width / options.height
          : asset.width / asset.height;
      if (handle === "height") {
        onChange({
          ...options,
          width: Math.max(1, Math.round(nextHeight * lockedRatio)),
          height: Math.max(1, nextHeight),
        });
      } else {
        onChange({
          ...options,
          width: Math.max(1, nextWidth),
          height: Math.max(1, Math.round(nextWidth / lockedRatio)),
        });
      }
      return;
    }

    onChange({
      ...options,
      width: Math.max(1, nextWidth),
      height: Math.max(1, nextHeight),
    });
  }

  function startDrag(handle: ResizeHandle) {
    return (event: PointerEvent<HTMLButtonElement>): void => {
      const canvas = event.currentTarget.closest(".resize-canvas");
      const rect = canvas?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      updateFromPointer(event, handle, rect);

      const handleMove = (moveEvent: globalThis.PointerEvent): void => {
        updateFromPointer(moveEvent, handle, rect);
      };
      const stop = (): void => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", stop);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", stop);
    };
  }

  function startFrameDrag(event: PointerEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLButtonElement) {
      return;
    }

    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const initial = boundedFramePosition;

    event.currentTarget.setPointerCapture(event.pointerId);

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const deltaX = ((moveEvent.clientX - startX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - startY) / rect.height) * 100;
      const nextPosition = clampFramePosition(
        {
          x: initial.x + deltaX,
          y: initial.y + deltaY,
        },
        frameWidth,
        frameHeight,
      );

      onChange({
        ...options,
        ...framePositionToAnchors(nextPosition, frameWidth, frameHeight),
      });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
  }

  function changeViewZoom(nextZoom: number): void {
    onViewZoomChange(clampValue(nextZoom, 0.5, 3));
  }

  return (
    <div
      className="editor-stage resize-stage swiss-grid-pattern"
      onWheel={(event) => {
        event.preventDefault();
        changeViewZoom(viewZoom + (event.deltaY > 0 ? -0.1 : 0.1));
      }}
    >
      <div className="resize-zoom-tools" aria-label="Resize canvas zoom controls">
        <button type="button" onClick={() => changeViewZoom(viewZoom - 0.25)}>
          -
        </button>
        <span>{Math.round(viewZoom * 100)}%</span>
        <button type="button" onClick={() => changeViewZoom(viewZoom + 0.25)}>
          +
        </button>
      </div>
      <div
        className="resize-canvas"
        style={{ transform: `translate(-50%, -50%) scale(${viewZoom})` }}
      >
        <img src={asset.previewUrl} alt={`Selected ${asset.name}`} />
        <div
          className="resize-frame"
          style={{
            left: `${boundedFramePosition.x}%`,
            top: `${boundedFramePosition.y}%`,
            width: `${frameWidth}%`,
            height: `${frameHeight}%`,
          }}
          onPointerDown={startFrameDrag}
        >
          <span>{formatDimensions(output.width, output.height)}</span>
          <button
            type="button"
            className="resize-handle resize-handle-x"
            aria-label="Drag width"
            onPointerDown={startDrag("width")}
          />
          <button
            type="button"
            className="resize-handle resize-handle-y"
            aria-label="Drag height"
            onPointerDown={startDrag("height")}
          />
          <button
            type="button"
            className="resize-handle resize-handle-corner"
            aria-label="Drag width and height"
            onPointerDown={startDrag("both")}
          />
        </div>
      </div>
      <StageMeta asset={asset} result={result} />
    </div>
  );
}

interface StageMetaProps {
  asset: ImageAsset;
  result?: ProcessedImageResult;
}

function StageMeta({ asset, result }: StageMetaProps) {
  return (
    <div className="stage-meta">
      <span>{asset.name}</span>
      <span>{formatDimensions(asset.width, asset.height)}</span>
      <span>{formatBytes(asset.size)}</span>
      {result ? <span>Result {formatBytes(result.size)}</span> : null}
    </div>
  );
}

interface SizePreviewPanelProps {
  asset?: ImageAsset;
  preview: SizePreviewState;
}

function SizePreviewPanel({ asset, preview }: SizePreviewPanelProps) {
  const result = preview.result;

  return (
    <div className={`size-preview size-preview-${preview.status}`} aria-live="polite">
      <p className="eyebrow">Live output</p>
      <div className="size-preview-grid">
        <span>
          Source
          <strong>{asset ? formatBytes(asset.size) : "None"}</strong>
        </span>
        <span>
          Output
          <strong>{result ? formatBytes(result.size) : "--"}</strong>
        </span>
        <span>
          Change
          <strong>
            {asset && result ? getOutputSizeDelta(asset.size, result.size) : "--"}
          </strong>
        </span>
        <span>
          Pixels
          <strong>
            {result ? formatDimensions(result.width, result.height) : "--"}
          </strong>
        </span>
      </div>
      <p>
        {preview.error
          ? `${preview.message} ${preview.error}`
          : result
            ? `${preview.message} ${getMimeLabel(result.mimeType)} in ${result.durationMs}ms.`
            : preview.message}
      </p>
    </div>
  );
}

interface ResizeControlsProps {
  asset?: ImageAsset;
  options: ResizeOptions;
  onChange: (options: ResizeOptions) => void;
}

function ResizeControls({ asset, options, onChange }: ResizeControlsProps) {
  function resizeWithLinkedRatio(
    next: Partial<Pick<ResizeOptions, "width" | "height">>,
  ) {
    const currentRatio =
      options.width > 0 && options.height > 0
        ? options.width / options.height
        : (asset?.width ?? 1) / (asset?.height ?? 1);

    if (!options.lockAspectRatio || currentRatio <= 0) {
      onChange({ ...options, ...next });
      return;
    }

    if (typeof next.width === "number") {
      onChange({
        ...options,
        width: next.width,
        height: Math.max(1, Math.round(next.width / currentRatio)),
      });
      return;
    }

    if (typeof next.height === "number") {
      onChange({
        ...options,
        width: Math.max(1, Math.round(next.height * currentRatio)),
        height: next.height,
      });
      return;
    }

    onChange({ ...options, ...next });
  }

  return (
    <div className="control-stack">
      <div className="dimension-controls">
        <NumberField
          label="Width"
          value={options.width}
          min={1}
          onChange={(width) => resizeWithLinkedRatio({ width })}
        />
        <button
          type="button"
          className={
            options.lockAspectRatio ? "active aspect-lock" : "secondary aspect-lock"
          }
          aria-pressed={options.lockAspectRatio}
          onClick={() =>
            onChange({
              ...options,
              lockAspectRatio: !options.lockAspectRatio,
            })
          }
        >
          {options.lockAspectRatio ? "Locked" : "Unlocked"}
        </button>
        <NumberField
          label="Height"
          value={options.height}
          min={1}
          onChange={(height) => resizeWithLinkedRatio({ height })}
        />
      </div>
      <div className="resize-presets" aria-label="Common resize targets">
        <p className="eyebrow">Common sizes</p>
        <div className="preset-grid">
          {RESIZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="secondary preset-button"
              type="button"
              onClick={() => onChange(applyResizePreset(options, preset))}
            >
              <span>{preset.label}</span>
              <small>
                {formatDimensions(preset.width, preset.height)} / {preset.detail}
              </small>
            </button>
          ))}
        </div>
      </div>
      <label>
        Fit mode
        <select
          value={options.fitMode}
          onChange={(event) =>
            onChange({
              ...options,
              fitMode: event.target.value as ResizeFitMode,
            })
          }
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="stretch">Stretch</option>
        </select>
      </label>
      <MimeSelect
        value={options.mimeType}
        onChange={(mimeType) => onChange({ ...options, mimeType })}
      />
      {asset ? (
        <button
          className="secondary"
          type="button"
          onClick={() => onChange(createDefaultResizeOptions(asset))}
        >
          Match selected
        </button>
      ) : null}
    </div>
  );
}

interface CompressControlsProps {
  options: CompressOptions;
  onChange: (options: CompressOptions) => void;
}

function CompressControls({ options, onChange }: CompressControlsProps) {
  return (
    <div className="control-stack">
      <MimeSelect
        value={options.mimeType}
        onChange={(mimeType) => onChange({ ...options, mimeType })}
      />
      <QualityField
        value={options.quality}
        label="Image quality"
        min={0.2}
        max={0.95}
        onChange={(quality) => onChange({ ...options, quality })}
      />
    </div>
  );
}

interface ConvertControlsProps {
  options: ConvertOptions;
  onChange: (options: ConvertOptions) => void;
}

function ConvertControls({ options, onChange }: ConvertControlsProps) {
  return (
    <div className="control-stack">
      <MimeSelect
        value={options.mimeType}
        onChange={(mimeType) => onChange({ ...options, mimeType })}
      />
    </div>
  );
}

interface CropControlsProps {
  cropAspect: CropAspect;
  cropPercent: CropPercentOptions;
  cropZoom: number;
  onAspectChange: (aspect: CropAspect) => void;
  onCropPercentChange: (crop: CropPercentOptions) => void;
  onCropZoomChange: (zoom: number) => void;
  onCropRotationChange: (rotation: number) => void;
}

function CropControls({
  cropAspect,
  cropPercent,
  cropZoom,
  onAspectChange,
  onCropPercentChange,
  onCropZoomChange,
  onCropRotationChange,
}: CropControlsProps) {
  return (
    <div className="control-stack">
      <div className="crop-presets">
        {(["original", "1:1", "4:3", "16:9"] as CropAspect[]).map((aspect) => (
          <button
            key={aspect}
            type="button"
            className={cropAspect === aspect ? "active" : ""}
            onClick={() => onAspectChange(aspect)}
          >
            {aspect === "original" ? "Original" : aspect}
          </button>
        ))}
      </div>
      <QualityField
        value={cropZoom}
        label="Zoom"
        min={1}
        max={3}
        onChange={onCropZoomChange}
      />
      <RotationField value={cropPercent.rotation} onChange={onCropRotationChange} />
      <MimeSelect
        value={cropPercent.mimeType}
        onChange={(mimeType) => onCropPercentChange({ ...cropPercent, mimeType })}
      />
    </div>
  );
}

interface ObjectSelectControlsProps {
  selection?: ObjectSelectionState;
  onClear: () => void;
}

function ObjectSelectControls({ selection, onClear }: ObjectSelectControlsProps) {
  return (
    <div className="control-stack">
      <div className="runtime-note runtime-note-ready">
        <p className="eyebrow">Local only</p>
        <h3>Click an object</h3>
        <p>
          Click one thing in the image. PrivatePixel highlights it before creating the
          transparent PNG.
        </p>
      </div>
      <div className="runtime-note">
        <p className="eyebrow">
          {selection?.status === "ready"
            ? "Selection ready"
            : selection?.status === "working"
              ? "Selecting"
              : selection?.status === "error"
                ? "Try again"
                : "No selection"}
        </p>
        <h3>
          {selection?.status === "ready"
            ? "Cutout ready"
            : selection?.status === "working"
              ? "Finding edges"
              : "Click the preview"}
        </h3>
        <p>
          {selection?.status === "ready"
            ? "Run the cutout, or click another spot to refine the selection."
            : selection?.status === "working"
              ? selection.message
              : selection?.status === "error"
                ? selection.error
                : "Choose the shoe, mug, person, logo, or object you want."}
        </p>
        {selection ? (
          <button type="button" className="secondary" onClick={onClear}>
            Clear selection
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface RemoveBackgroundControlsProps {
  options: RemoveBackgroundOptions;
  onChange: (options: RemoveBackgroundOptions) => void;
}

function RemoveBackgroundControls({
  options,
  onChange,
}: RemoveBackgroundControlsProps) {
  const selectedCopy = REMOVE_BACKGROUND_MODE_COPY[options.mode];

  return (
    <div className="control-stack">
      <div className="runtime-note runtime-note-ready">
        <p className="eyebrow">Local only</p>
        <h3>Transparent PNG</h3>
        <p>Auto chooses MODNet for portraits and RMBG-1.4 for general objects.</p>
      </div>
      <details className="advanced-panel">
        <summary>Advanced</summary>
        <label>
          Cutout model
          <select
            value={options.mode}
            onChange={(event) =>
              onChange({
                ...options,
                mode: event.target.value as RemoveBackgroundMode,
              })
            }
          >
            {(Object.keys(REMOVE_BACKGROUND_MODE_COPY) as RemoveBackgroundMode[]).map(
              (mode) => (
                <option key={mode} value={mode}>
                  {REMOVE_BACKGROUND_MODE_COPY[mode].label}
                </option>
              ),
            )}
          </select>
        </label>
        <p>{selectedCopy.detail}</p>
      </details>
    </div>
  );
}

interface MetadataControlsProps {
  asset?: ImageAsset;
  options: MetadataOptions;
  onChange: (options: MetadataOptions) => void;
}

function groupMetadataEntries(
  entries: MetadataInspectionEntry[],
): Array<[string, MetadataInspectionEntry[]]> {
  const groups = new Map<string, MetadataInspectionEntry[]>();
  for (const entry of entries) {
    const current = groups.get(entry.group) ?? [];
    current.push(entry);
    groups.set(entry.group, current);
  }
  return Array.from(groups.entries());
}

function customMetadataFieldIndex(
  fields: MetadataOptions["customTextFields"],
  key: string,
): number {
  const normalizedKey = key.trim().toLowerCase();
  return fields.findIndex((field) => field.key.trim().toLowerCase() === normalizedKey);
}

function mergeMetadataInspectionValues(
  options: MetadataOptions,
  inspection: MetadataInspectionResult,
  overwriteExisting: boolean,
): MetadataOptions {
  const fields = { ...options.fields };
  const customTextFields = [...options.customTextFields];

  for (const entry of inspection.entries) {
    if (!entry.editable || !entry.target) {
      continue;
    }

    if (entry.target.type === "field") {
      if (overwriteExisting || !fields[entry.target.field].trim()) {
        fields[entry.target.field] = entry.value;
      }
      continue;
    }

    const key = entry.target.key.trim();
    if (!key) {
      continue;
    }

    const existingIndex = customMetadataFieldIndex(customTextFields, key);
    if (existingIndex >= 0) {
      if (overwriteExisting) {
        customTextFields[existingIndex] = {
          ...customTextFields[existingIndex],
          value: entry.value,
        };
      }
      continue;
    }

    customTextFields.push({ key, value: entry.value });
  }

  return {
    ...options,
    fields,
    customTextFields,
  };
}

function metadataTargetValue(
  target: MetadataEditableTarget,
  fallback: string,
  options: MetadataOptions,
  isEditing: boolean,
): string {
  if (target.type === "field") {
    return isEditing ? options.fields[target.field] : fallback;
  }

  const existing = options.customTextFields.find(
    (field) => field.key.trim().toLowerCase() === target.key.trim().toLowerCase(),
  );
  return existing ? existing.value : fallback;
}

function MetadataControls({ asset, options, onChange }: MetadataControlsProps) {
  const [inspectionState, setInspectionState] = useState<MetadataInspectionState>({
    status: "idle",
  });
  const latestMetadataOptionsRef = useRef(options);
  const latestOnChangeRef = useRef(onChange);
  const support = getMetadataFormatSupport(asset?.mimeType ?? "");
  const effectiveOptions = asset
    ? getEffectiveMetadataOptions(asset.mimeType, options)
    : options;
  const canWrite = support.canClean || support.canEditText;
  const isEditing = support.canEditText && effectiveOptions.mode === "edit";
  const inspectionResult =
    asset && inspectionState.assetId === asset.id ? inspectionState.result : undefined;
  const inspectionError =
    asset && inspectionState.assetId === asset.id ? inspectionState.error : undefined;
  const inspectionStatus =
    !asset || inspectionState.assetId === asset.id ? inspectionState.status : "working";
  const metadataGroups = useMemo(
    () => groupMetadataEntries(inspectionResult?.entries ?? []),
    [inspectionResult],
  );
  const inspectedTextFields = useMemo(() => {
    const fields = new Set<MetadataTextFieldKey>();
    for (const entry of inspectionResult?.entries ?? []) {
      if (entry.editable && entry.target?.type === "field") {
        fields.add(entry.target.field);
      }
    }
    return fields;
  }, [inspectionResult]);
  const additionalTextFields = METADATA_TEXT_FIELD_CONTROLS.filter(
    (control) => !inspectedTextFields.has(control.field),
  );

  useEffect(() => {
    latestMetadataOptionsRef.current = options;
    latestOnChangeRef.current = onChange;
  }, [options, onChange]);

  useEffect(() => {
    if (!asset) {
      return;
    }

    const inspectedAsset = asset;
    let stale = false;

    async function inspectAssetMetadata(): Promise<void> {
      try {
        const buffer = await inspectedAsset.file.arrayBuffer();
        if (stale) {
          return;
        }

        const result = inspectMetadataSource({
          name: inspectedAsset.name,
          mimeType: inspectedAsset.mimeType,
          size: inspectedAsset.size,
          width: inspectedAsset.width,
          height: inspectedAsset.height,
          buffer,
        });

        setInspectionState({
          assetId: inspectedAsset.id,
          status: "ready",
          result,
        });

        const latestOptions = latestMetadataOptionsRef.current;
        if (latestOptions.mode === "edit") {
          latestOnChangeRef.current(
            mergeMetadataInspectionValues(latestOptions, result, true),
          );
        }
      } catch (error) {
        if (stale) {
          return;
        }

        setInspectionState({
          assetId: inspectedAsset.id,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Could not read existing metadata.",
        });
      }
    }

    void inspectAssetMetadata();

    return () => {
      stale = true;
    };
  }, [asset]);

  function updateMode(mode: MetadataOptions["mode"]): void {
    const seededOptions =
      mode === "edit" && inspectionResult
        ? mergeMetadataInspectionValues(options, inspectionResult, true)
        : options;
    onChange({
      ...seededOptions,
      mode,
    });
  }

  function updateField(field: MetadataTextFieldKey, value: string): void {
    onChange({
      ...options,
      fields: {
        ...options.fields,
        [field]: value,
      },
    });
  }

  function updateCustomField(key: string, value: string): void {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }

    const customTextFields = [...options.customTextFields];
    const existingIndex = customMetadataFieldIndex(customTextFields, normalizedKey);

    if (existingIndex >= 0) {
      customTextFields[existingIndex] = {
        ...customTextFields[existingIndex],
        value,
      };
    } else {
      customTextFields.push({ key: normalizedKey, value });
    }

    onChange({
      ...options,
      customTextFields,
    });
  }

  function updateTarget(target: MetadataEditableTarget, value: string): void {
    if (target.type === "field") {
      updateField(target.field, value);
      return;
    }
    updateCustomField(target.key, value);
  }

  return (
    <div className="control-stack">
      <div className="runtime-note runtime-note-ready">
        <p className="eyebrow">{support.label}</p>
        <h3>{canWrite ? "Format-aware metadata" : "Inspect only"}</h3>
        <p>{support.summary}</p>
      </div>

      {canWrite ? (
        <>
          <label>
            Metadata mode
            <select
              value={effectiveOptions.mode}
              onChange={(event) =>
                updateMode(event.target.value as MetadataOptions["mode"])
              }
            >
              <option value="clean" disabled={!support.canClean}>
                Clean private data
              </option>
              <option value="edit" disabled={!support.canEditText}>
                Edit public text
              </option>
            </select>
          </label>

          <div className="metadata-switches">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={effectiveOptions.removePrivateData}
                disabled={!support.canStripPrivateData}
                onChange={(event) =>
                  onChange({
                    ...options,
                    removePrivateData: event.target.checked,
                  })
                }
              />
              Remove EXIF / GPS / private data
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={effectiveOptions.removeComments}
                disabled={!support.canStripComments}
                onChange={(event) =>
                  onChange({
                    ...options,
                    removeComments: event.target.checked,
                  })
                }
              />
              Remove comments / text chunks
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={effectiveOptions.preserveColorProfile}
                disabled={!support.canPreserveColorProfile}
                onChange={(event) =>
                  onChange({
                    ...options,
                    preserveColorProfile: event.target.checked,
                  })
                }
              />
              Preserve color profile
            </label>
            {support.canSanitizeSvg ? (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={effectiveOptions.sanitizeSvg}
                  onChange={(event) =>
                    onChange({
                      ...options,
                      sanitizeSvg: event.target.checked,
                    })
                  }
                />
                Sanitize SVG scripts and external refs
              </label>
            ) : null}
          </div>
        </>
      ) : null}

      <section className="metadata-inspector" aria-live="polite">
        <div className="metadata-inspector-heading">
          <h4>Existing metadata</h4>
          <p>
            {inspectionStatus === "ready"
              ? `${metadataGroups.reduce((total, [, entries]) => total + entries.length, 0)} fields found`
              : inspectionStatus === "error"
                ? "Could not read every field"
                : asset
                  ? "Reading local file"
                  : "Add an image first"}
          </p>
        </div>

        {inspectionStatus === "ready" && metadataGroups.length ? (
          metadataGroups.map(([group, entries]) => (
            <div className="metadata-group" key={group}>
              <h5>{group}</h5>
              <div className="metadata-entry-list">
                {entries.map((entry) => {
                  const canEditEntry = isEditing && entry.editable && entry.target;
                  return (
                    <article
                      className={`metadata-entry ${canEditEntry ? "is-editable" : ""}`}
                      key={entry.id}
                    >
                      <div className="metadata-entry-heading">
                        <span>{entry.label}</span>
                        <small>{canEditEntry ? "Editable" : "Read only"}</small>
                      </div>
                      {canEditEntry && entry.target ? (
                        <TextAreaField
                          label={entry.label}
                          value={metadataTargetValue(
                            entry.target,
                            entry.value,
                            options,
                            isEditing,
                          )}
                          onChange={(value) => {
                            if (entry.target) {
                              updateTarget(entry.target, value);
                            }
                          }}
                        />
                      ) : (
                        <p>{entry.value || "Empty"}</p>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <p className="metadata-empty">
            {inspectionStatus === "error"
              ? inspectionError
              : asset
                ? "Reading existing metadata locally."
                : "Metadata appears here after you load an image."}
          </p>
        )}
      </section>

      {support.canEditText &&
      effectiveOptions.mode === "edit" &&
      additionalTextFields.length ? (
        <div className="metadata-fields">
          <p className="metadata-section-label">Add public text fields</p>
          {additionalTextFields.map((control) => (
            <TextField
              key={control.field}
              label={control.label}
              value={options.fields[control.field]}
              onChange={(value) => updateField(control.field, value)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface RotationFieldProps {
  value: number;
  onChange: (value: number) => void;
}

function RotationField({ value, onChange }: RotationFieldProps) {
  function shiftRotation(delta: number): void {
    onChange(normalizeRotationDegrees(value + delta));
  }

  return (
    <div className="rotation-control">
      <label>
        Rotation {Math.round(value)} deg
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={Math.round(value)}
          onChange={(event) =>
            onChange(normalizeRotationDegrees(Number(event.target.value)))
          }
        />
      </label>
      <div className="rotation-actions">
        <button type="button" className="secondary" onClick={() => shiftRotation(-90)}>
          -90
        </button>
        <button type="button" className="secondary" onClick={() => onChange(0)}>
          Reset
        </button>
        <button type="button" className="secondary" onClick={() => shiftRotation(90)}>
          +90
        </button>
      </div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function TextField({ label, value, onChange }: TextFieldProps) {
  return (
    <label>
      {label}
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({ label, value, onChange }: TextFieldProps) {
  return (
    <label>
      {label}
      <textarea
        value={value}
        rows={value.length > 160 ? 6 : 3}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({ label, value, min, max, onChange }: NumberFieldProps) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

interface QualityFieldProps {
  value: number;
  label?: string;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}

function QualityField({
  value,
  label = "Quality",
  min = 0.05,
  max = 1,
  onChange,
}: QualityFieldProps) {
  const scale = label === "Zoom" ? 100 : 100;
  return (
    <label>
      {label} {label === "Zoom" ? value.toFixed(1) : `${Math.round(value * 100)}%`}
      <input
        type="range"
        min={Math.round(min * scale)}
        max={Math.round(max * scale)}
        step={1}
        value={Math.round(value * scale)}
        onChange={(event) => onChange(Number(event.target.value) / scale)}
      />
    </label>
  );
}

interface MimeSelectProps {
  value: OutputMimeType;
  onChange: (mimeType: OutputMimeType) => void;
}

function MimeSelect({ value, onChange }: MimeSelectProps) {
  return (
    <label>
      Output
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as OutputMimeType)}
      >
        {OUTPUT_MIME_TYPES.map((mimeType) => (
          <option key={mimeType} value={mimeType}>
            {getMimeLabel(mimeType)}
          </option>
        ))}
      </select>
    </label>
  );
}

interface AssetItemProps {
  asset: ImageAsset;
  index: number;
  isSelected: boolean;
  job: AssetJobView;
  onRemove: () => void;
  onSelect: () => void;
}

function AssetItem({
  asset,
  index,
  isSelected,
  job,
  onRemove,
  onSelect,
}: AssetItemProps) {
  const result = job.result;

  return (
    <article
      className={`asset-item${isSelected ? " selected" : ""}`}
      data-testid="asset-item"
    >
      <button className="asset-select" type="button" onClick={onSelect}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <img src={asset.previewUrl} alt={`Original ${asset.name}`} />
        <span>{asset.name}</span>
      </button>

      <div className="asset-copy">
        <p>
          {formatDimensions(asset.width, asset.height)} / {formatBytes(asset.size)} /{" "}
          {asset.mimeType}
        </p>
        <div className="status-row">
          <div>
            <span className={`status-dot ${job.status}`} />
            {job.message}
          </div>
          <span>{job.progress}%</span>
        </div>
        <progress value={job.progress} max={100} />
        {job.error ? <p className="error-text">{job.error}</p> : null}
      </div>

      {result ? (
        <div className="result-row" data-testid="result-row">
          <span>
            {formatDimensions(result.width, result.height)} / {formatBytes(result.size)}{" "}
            / {getOutputSizeDelta(asset.size, result.size)}
          </span>
          <button
            type="button"
            onClick={() => downloadBlob(result.blob, result.filename)}
          >
            Download
          </button>
        </div>
      ) : (
        <span className="result-pending">No result</span>
      )}

      <button className="remove-button" type="button" onClick={onRemove}>
        Remove
      </button>
    </article>
  );
}
