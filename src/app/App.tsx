import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";
import {
  ChangeEvent,
  DragEvent,
  PointerEvent,
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
  calculateResizeDimensions,
  clampQuality,
  createDefaultCompressOptions,
  createDefaultResizeOptions,
  getMimeLabel,
  getOutputSizeDelta,
  isSupportedInputMime,
} from "../image/options";
import type {
  CompressOptions,
  ConvertOptions,
  CropOptions,
  ImageAsset,
  ImageJobProgress,
  ImageJobRequest,
  ImageOperation,
  ImageTool,
  OutputMimeType,
  ProcessedImageResult,
  ResizeFitMode,
  ResizeOptions,
} from "../image/types";
import { ImageWorkerClient } from "../workers/imageClient";

type JobStatus = "idle" | "queued" | "processing" | "done" | "error";
type CropAspect = "original" | "1:1" | "4:3" | "16:9";
type ResizeHandle = "width" | "height" | "both";

interface AssetJobView {
  status: JobStatus;
  progress: number;
  message: string;
  result?: ProcessedImageResult;
  error?: string;
}

interface CropPercentOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  mimeType: OutputMimeType;
  quality: number;
}

const TOOL_LABELS: Record<ImageTool, string> = {
  resize: "Resize",
  compress: "Compress",
  convert: "Convert",
  crop: "Crop",
  "remove-background": "Remove BG",
};

const TOOL_COPY: Record<ImageTool, string> = {
  resize: "Drag the frame, zoom the canvas, or set exact output dimensions.",
  compress: "Set format, quality, and maximum edge length.",
  convert: "Choose a target image format.",
  crop: "Drag, zoom, and export the selected area.",
  "remove-background": "Offline background removal needs a local model bundle.",
};

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

function createConvertOptions(): ConvertOptions {
  return {
    mimeType: "image/png",
    quality: 0.92,
  };
}

function createCropPercentOptions(): CropPercentOptions {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    mimeType: "image/png",
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
  return {
    x: Math.round((asset.width * cropPercent.x) / 100),
    y: Math.round((asset.height * cropPercent.y) / 100),
    width: Math.round((asset.width * cropPercent.width) / 100),
    height: Math.round((asset.height * cropPercent.height) / 100),
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

export function App() {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, AssetJobView>>({});
  const [activeTool, setActiveTool] = useState<ImageTool>("resize");
  const [resizeOptions, setResizeOptions] = useState<ResizeOptions>(
    createDefaultResizeOptions(),
  );
  const [compressOptions, setCompressOptions] = useState<CompressOptions>(
    createDefaultCompressOptions(),
  );
  const [convertOptions, setConvertOptions] =
    useState<ConvertOptions>(createConvertOptions());
  const [cropAspect, setCropAspect] = useState<CropAspect>("original");
  const [cropPercent, setCropPercent] = useState(createCropPercentOptions);
  const [cropPosition, setCropPosition] = useState<Point>({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [resizeViewZoom, setResizeViewZoom] = useState(1);
  const [concurrency, setConcurrency] = useState(2);
  const [notice, setNotice] = useState("Images stay in this browser session.");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const workerRef = useRef<ImageWorkerClient | null>(null);
  const runTokenRef = useRef(0);
  const activeJobIdsRef = useRef(new Set<string>());
  const assetUrlsRef = useRef(new Set<string>());
  const resultUrlsRef = useRef(new Set<string>());

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? assets[0],
    [assets, selectedAssetId],
  );

  const completedResults = useMemo(
    () =>
      assets
        .map((asset) => getJobView(jobs, asset.id).result)
        .filter((result): result is ProcessedImageResult => Boolean(result)),
    [assets, jobs],
  );

  const activeToolDisabled = activeTool === "remove-background";

  useEffect(() => {
    const activeJobIds = activeJobIdsRef.current;
    const assetUrls = assetUrlsRef.current;
    const resultUrls = resultUrlsRef.current;

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
    };
  }, []);

  function getWorker(): ImageWorkerClient {
    workerRef.current ??= new ImageWorkerClient();
    return workerRef.current;
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

  function setJobResult(assetId: string, result: ProcessedImageResult): void {
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
    setAssets([]);
    setSelectedAssetId(null);
    setJobs({});
    setNotice("Workspace cleared.");
  }

  function buildOperation(asset: ImageAsset): ImageOperation {
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

    return {
      type: "remove-background",
      options: { outputMimeType: "image/png" },
    };
  }

  function handleProgress(progress: ImageJobProgress): void {
    updateJob(progress.assetId, {
      status: "processing",
      progress: progress.progress,
      message: progress.message,
    });
  }

  async function processAsset(asset: ImageAsset, runToken: number): Promise<void> {
    const jobId = crypto.randomUUID();
    activeJobIdsRef.current.add(jobId);
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
          buffer,
        },
        operation: buildOperation(asset),
      };

      const result = await getWorker().process(request, handleProgress);
      if (runTokenRef.current !== runToken) {
        return;
      }

      const url = URL.createObjectURL(result.blob);
      resultUrlsRef.current.add(url);
      setJobResult(asset.id, { ...result, url });
    } catch (error) {
      if (runTokenRef.current !== runToken) {
        return;
      }

      updateJob(asset.id, {
        status: "error",
        progress: 0,
        message: "Failed",
        error: error instanceof Error ? error.message : "Processing failed.",
      });
    } finally {
      activeJobIdsRef.current.delete(jobId);
    }
  }

  async function processBatch(): Promise<void> {
    if (!assets.length) {
      setNotice("Add images before running a tool.");
      return;
    }

    if (activeToolDisabled) {
      setNotice("Add a bundled local model before enabling background removal.");
      return;
    }

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setIsProcessing(true);
    setNotice(`Running ${TOOL_LABELS[activeTool].toLowerCase()} locally.`);

    setJobs((current) => {
      const next = { ...current };
      for (const asset of assets) {
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
    const workerCount = Math.min(Math.max(1, concurrency), assets.length);

    async function consumeQueue(): Promise<void> {
      while (runTokenRef.current === runToken) {
        const asset = assets[cursor];
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
          PrivatePixel
        </a>
        <nav className="site-nav" aria-label="Sections">
          <a className="active" href="#app">
            App
          </a>
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
        <h1>Local image workshop</h1>
        <p>No uploads. No account. No watermark.</p>
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
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
            multiple
            onChange={handleFileInput}
          />
        </label>
      </section>

      <section className="workbench" aria-label="PrivatePixel workspace">
        <aside className="tool-rail" aria-label="Tool selection">
          <p className="eyebrow">03. Method</p>
          {(Object.keys(TOOL_LABELS) as ImageTool[]).map((tool, index) => (
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
              cropAspect={cropAspect}
              cropPosition={cropPosition}
              cropZoom={cropZoom}
              onResizeChange={setResizeOptions}
              onResizeViewZoomChange={setResizeViewZoom}
              onCropPositionChange={setCropPosition}
              onCropZoomChange={setCropZoom}
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
              viewZoom={resizeViewZoom}
              onChange={setResizeOptions}
              onViewZoomChange={setResizeViewZoom}
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
            />
          ) : null}

          {activeTool === "remove-background" ? (
            <div className="runtime-note">
              <p className="eyebrow">Not installed</p>
              <h3>Local cutout model pending.</h3>
              <p>
                This tool is disabled until a bundled browser model is added. There is
                no upload fallback.
              </p>
            </div>
          ) : null}

          <div className="runbar">
            <label>
              Batch workers
              <select
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void processBatch()}
              disabled={isProcessing || activeToolDisabled || !assets.length}
              data-testid="run-tool"
            >
              Run {TOOL_LABELS[activeTool]}
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
        id="about"
        className="about-panel swiss-diagonal"
        aria-labelledby="about-title"
      >
        <div>
          <p className="eyebrow">07. About</p>
          <h2 id="about-title">Private image work, kept local.</h2>
        </div>
        <p>
          Resize, compress, convert, crop, and export images in this browser. Source
          files stay in memory on this device; no server processing, accounts, paywalls,
          or watermarks.
        </p>
      </section>
    </main>
  );
}

interface EditorStageProps {
  activeTool: ImageTool;
  asset: ImageAsset;
  job: AssetJobView;
  resizeOptions: ResizeOptions;
  resizeViewZoom: number;
  cropAspect: CropAspect;
  cropPosition: Point;
  cropZoom: number;
  onResizeChange: (options: ResizeOptions) => void;
  onResizeViewZoomChange: (zoom: number) => void;
  onCropPositionChange: (position: Point) => void;
  onCropZoomChange: (zoom: number) => void;
  onCropAreaChange: (area: Area) => void;
}

function EditorStage({
  activeTool,
  asset,
  job,
  resizeOptions,
  resizeViewZoom,
  cropAspect,
  cropPosition,
  cropZoom,
  onResizeChange,
  onResizeViewZoomChange,
  onCropPositionChange,
  onCropZoomChange,
  onCropAreaChange,
}: EditorStageProps) {
  const result = job.result;

  if (activeTool === "crop") {
    return (
      <div className="editor-stage crop-stage">
        <Cropper
          image={asset.previewUrl}
          crop={cropPosition}
          zoom={cropZoom}
          aspect={getCropAspect(asset, cropAspect)}
          onCropChange={onCropPositionChange}
          onZoomChange={onCropZoomChange}
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
    <div className="editor-stage preview-stage swiss-grid-pattern">
      <figure>
        <img src={asset.previewUrl} alt={`Selected ${asset.name}`} />
      </figure>
      {result ? (
        <figure>
          <img src={result.url} alt={`Processed ${asset.name}`} />
        </figure>
      ) : null}
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
  const [framePosition, setFramePosition] = useState<Point>({ x: 0, y: 0 });
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
    framePosition,
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
      const sourceRatio = asset.width / asset.height;
      if (handle === "height") {
        onChange({
          ...options,
          width: Math.max(1, Math.round(nextHeight * sourceRatio)),
          height: Math.max(1, nextHeight),
        });
      } else {
        onChange({
          ...options,
          width: Math.max(1, nextWidth),
          height: Math.max(1, Math.round(nextWidth / sourceRatio)),
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
      setFramePosition(
        clampFramePosition(
          {
            x: initial.x + deltaX,
            y: initial.y + deltaY,
          },
          frameWidth,
          frameHeight,
        ),
      );
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

interface ResizeControlsProps {
  asset?: ImageAsset;
  options: ResizeOptions;
  viewZoom: number;
  onChange: (options: ResizeOptions) => void;
  onViewZoomChange: (zoom: number) => void;
}

function ResizeControls({
  asset,
  options,
  viewZoom,
  onChange,
  onViewZoomChange,
}: ResizeControlsProps) {
  return (
    <div className="control-stack">
      <NumberField
        label="Width"
        value={options.width}
        min={1}
        onChange={(width) => onChange({ ...options, width })}
      />
      <NumberField
        label="Height"
        value={options.height}
        min={1}
        onChange={(height) => onChange({ ...options, height })}
      />
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
      <QualityField
        value={options.quality}
        onChange={(quality) => onChange({ ...options, quality })}
      />
      <QualityField
        value={viewZoom}
        label="View zoom"
        min={0.5}
        max={3}
        onChange={onViewZoomChange}
      />
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={options.lockAspectRatio}
          onChange={(event) =>
            onChange({ ...options, lockAspectRatio: event.target.checked })
          }
        />
        Lock aspect ratio
      </label>
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
        onChange={(quality) => onChange({ ...options, quality })}
      />
      <NumberField
        label="Max dimension"
        value={options.maxDimension}
        min={1}
        onChange={(maxDimension) => onChange({ ...options, maxDimension })}
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
      <QualityField
        value={options.quality}
        onChange={(quality) => onChange({ ...options, quality })}
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
}

function CropControls({
  cropAspect,
  cropPercent,
  cropZoom,
  onAspectChange,
  onCropPercentChange,
  onCropZoomChange,
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
      <MimeSelect
        value={cropPercent.mimeType}
        onChange={(mimeType) => onCropPercentChange({ ...cropPercent, mimeType })}
      />
      <QualityField
        value={cropPercent.quality}
        onChange={(quality) => onCropPercentChange({ ...cropPercent, quality })}
      />
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
