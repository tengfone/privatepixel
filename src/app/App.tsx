import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
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
  createCenteredCrop,
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

interface AssetJobView {
  status: JobStatus;
  progress: number;
  message: string;
  result?: ProcessedImageResult;
  error?: string;
}

type CropAspect = "free" | "1:1" | "4:3" | "16:9";

const TOOL_LABELS: Record<ImageTool, string> = {
  resize: "Resize",
  compress: "Compress",
  convert: "Convert",
  crop: "Crop",
  "remove-background": "Remove BG",
};

const TOOL_COPY: Record<ImageTool, string> = {
  resize: "Set target dimensions and export clean local copies.",
  compress: "Reduce file size with a practical quality target.",
  convert: "Switch between PNG, JPEG, and WebP without uploading.",
  crop: "Use centered presets or a freeform crop box.",
  "remove-background": "Prepared for local model assets in a lazy runtime.",
};

const CROP_ASPECTS: Record<Exclude<CropAspect, "free">, number> = {
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

function createCropPercentOptions() {
  return {
    x: 10,
    y: 10,
    width: 80,
    height: 80,
    mimeType: "image/png" as OutputMimeType,
    quality: 0.92,
  };
}

function getJobView(jobs: Record<string, AssetJobView>, assetId: string): AssetJobView {
  return jobs[assetId] ?? EMPTY_JOB;
}

function getAspectDescription(asset: ImageAsset, options: ResizeOptions): string {
  const dimensions = calculateResizeDimensions({
    sourceWidth: asset.width,
    sourceHeight: asset.height,
    targetWidth: options.width,
    targetHeight: options.height,
    fitMode: options.fitMode,
    lockAspectRatio: options.lockAspectRatio,
  });

  return formatDimensions(dimensions.width, dimensions.height);
}

function buildCropFromPercent(
  asset: ImageAsset,
  cropPercent: ReturnType<typeof createCropPercentOptions>,
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

export function App() {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
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
  const [cropAspect, setCropAspect] = useState<CropAspect>("1:1");
  const [cropPercent, setCropPercent] = useState(createCropPercentOptions);
  const [concurrency, setConcurrency] = useState(2);
  const [notice, setNotice] = useState("Images stay in this browser session.");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const workerRef = useRef<ImageWorkerClient | null>(null);
  const runTokenRef = useRef(0);
  const activeJobIdsRef = useRef(new Set<string>());
  const assetUrlsRef = useRef(new Set<string>());
  const resultUrlsRef = useRef(new Set<string>());

  const completedResults = useMemo(
    () =>
      assets
        .map((asset) => getJobView(jobs, asset.id).result)
        .filter((result): result is ProcessedImageResult => Boolean(result)),
    [assets, jobs],
  );

  const selectedPreview = assets[0];
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

    setAssets((current) => current.filter((candidate) => candidate.id !== assetId));
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
      const crop =
        cropAspect === "free"
          ? buildCropFromPercent(asset, cropPercent)
          : createCenteredCrop(
              asset.width,
              asset.height,
              CROP_ASPECTS[cropAspect],
              cropPercent.mimeType,
              cropPercent.quality,
            );

      return { type: "crop", options: crop };
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
      setNotice(
        "Background removal is wired as a lazy local runtime, but model assets are not bundled yet.",
      );
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
      setNotice("Processing complete. Download results from the queue.");
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
      <header className="topbar">
        <div>
          <p className="eyebrow">PrivatePixel</p>
          <h1>Local image tools, no upload path.</h1>
        </div>
        <p className="privacy-note">
          No accounts. No watermarks. No server-side image processing.
        </p>
      </header>

      <section className="workspace" aria-label="PrivatePixel workspace">
        <div
          className={`dropzone${isDragging ? " dropzone-active" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          data-testid="dropzone"
        >
          <div>
            <h2>Drop images here</h2>
            <p>{notice}</p>
          </div>
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
        </div>

        <div className="tool-layout">
          <section className="tools" aria-label="Image tools">
            <nav className="tool-tabs" aria-label="Tool selection">
              {(Object.keys(TOOL_LABELS) as ImageTool[]).map((tool) => (
                <button
                  key={tool}
                  className={tool === activeTool ? "active" : ""}
                  type="button"
                  onClick={() => setActiveTool(tool)}
                >
                  {TOOL_LABELS[tool]}
                </button>
              ))}
            </nav>

            <div className="tool-panel">
              <div className="tool-heading">
                <div>
                  <p className="eyebrow">{TOOL_LABELS[activeTool]}</p>
                  <h2>{TOOL_COPY[activeTool]}</h2>
                </div>
                {selectedPreview && activeTool === "resize" ? (
                  <span className="prediction">
                    First result: {getAspectDescription(selectedPreview, resizeOptions)}
                  </span>
                ) : null}
              </div>

              {activeTool === "resize" ? (
                <ResizeControls options={resizeOptions} onChange={setResizeOptions} />
              ) : null}

              {activeTool === "compress" ? (
                <CompressControls
                  options={compressOptions}
                  onChange={setCompressOptions}
                />
              ) : null}

              {activeTool === "convert" ? (
                <ConvertControls
                  options={convertOptions}
                  onChange={setConvertOptions}
                />
              ) : null}

              {activeTool === "crop" ? (
                <CropControls
                  cropAspect={cropAspect}
                  cropPercent={cropPercent}
                  onAspectChange={setCropAspect}
                  onCropPercentChange={setCropPercent}
                />
              ) : null}

              {activeTool === "remove-background" ? (
                <div className="runtime-note">
                  <h3>Local model runtime</h3>
                  <p>
                    The worker contract is ready, but model files are not shipped in
                    this build. When added, they should load from local static assets
                    and stay out of the initial bundle.
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
            </div>
          </section>

          <section className="queue" aria-label="Image queue">
            <div className="queue-heading">
              <div>
                <p className="eyebrow">Queue</p>
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
              <div className="asset-grid" data-testid="asset-grid">
                {assets.map((asset) => (
                  <AssetItem
                    key={asset.id}
                    asset={asset}
                    job={getJobView(jobs, asset.id)}
                    onRemove={() => removeAsset(asset.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <h3>Your local queue is empty</h3>
                <p>Add images to preview metadata and run tools in batches.</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

interface ResizeControlsProps {
  options: ResizeOptions;
  onChange: (options: ResizeOptions) => void;
}

function ResizeControls({ options, onChange }: ResizeControlsProps) {
  return (
    <div className="control-grid">
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
    </div>
  );
}

interface CompressControlsProps {
  options: CompressOptions;
  onChange: (options: CompressOptions) => void;
}

function CompressControls({ options, onChange }: CompressControlsProps) {
  return (
    <div className="control-grid">
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
    <div className="control-grid">
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
  cropPercent: ReturnType<typeof createCropPercentOptions>;
  onAspectChange: (aspect: CropAspect) => void;
  onCropPercentChange: (crop: ReturnType<typeof createCropPercentOptions>) => void;
}

function CropControls({
  cropAspect,
  cropPercent,
  onAspectChange,
  onCropPercentChange,
}: CropControlsProps) {
  return (
    <>
      <div className="crop-presets">
        {(["1:1", "4:3", "16:9", "free"] as CropAspect[]).map((aspect) => (
          <button
            key={aspect}
            type="button"
            className={cropAspect === aspect ? "active" : ""}
            onClick={() => onAspectChange(aspect)}
          >
            {aspect === "free" ? "Freeform" : aspect}
          </button>
        ))}
      </div>
      <div className="control-grid">
        <MimeSelect
          value={cropPercent.mimeType}
          onChange={(mimeType) => onCropPercentChange({ ...cropPercent, mimeType })}
        />
        <QualityField
          value={cropPercent.quality}
          onChange={(quality) => onCropPercentChange({ ...cropPercent, quality })}
        />
        {cropAspect === "free" ? (
          <>
            <NumberField
              label="X %"
              value={cropPercent.x}
              min={0}
              max={99}
              onChange={(x) => onCropPercentChange({ ...cropPercent, x })}
            />
            <NumberField
              label="Y %"
              value={cropPercent.y}
              min={0}
              max={99}
              onChange={(y) => onCropPercentChange({ ...cropPercent, y })}
            />
            <NumberField
              label="Width %"
              value={cropPercent.width}
              min={1}
              max={100}
              onChange={(width) => onCropPercentChange({ ...cropPercent, width })}
            />
            <NumberField
              label="Height %"
              value={cropPercent.height}
              min={1}
              max={100}
              onChange={(height) => onCropPercentChange({ ...cropPercent, height })}
            />
          </>
        ) : null}
      </div>
    </>
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
  onChange: (value: number) => void;
}

function QualityField({ value, onChange }: QualityFieldProps) {
  return (
    <label>
      Quality {Math.round(value * 100)}%
      <input
        type="range"
        min={5}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
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
  job: AssetJobView;
  onRemove: () => void;
}

function AssetItem({ asset, job, onRemove }: AssetItemProps) {
  const result = job.result;

  return (
    <article className="asset-item" data-testid="asset-item">
      <div className="preview-pair">
        <figure>
          <img src={asset.previewUrl} alt={`Original ${asset.name}`} />
          <figcaption>Original</figcaption>
        </figure>
        {result ? (
          <figure>
            <img src={result.url} alt={`Processed ${asset.name}`} />
            <figcaption>Result</figcaption>
          </figure>
        ) : null}
      </div>

      <div className="asset-copy">
        <h3 title={asset.name}>{asset.name}</h3>
        <p>
          {formatDimensions(asset.width, asset.height)} · {formatBytes(asset.size)} ·{" "}
          {asset.mimeType}
        </p>
      </div>

      <div className="status-row">
        <div>
          <span className={`status-dot ${job.status}`} />
          {job.message}
        </div>
        <span>{job.progress}%</span>
      </div>
      <progress value={job.progress} max={100} />

      {job.error ? <p className="error-text">{job.error}</p> : null}

      {result ? (
        <div className="result-row" data-testid="result-row">
          <span>
            {formatDimensions(result.width, result.height)} · {formatBytes(result.size)}{" "}
            · {getOutputSizeDelta(asset.size, result.size)}
          </span>
          <button
            type="button"
            onClick={() => downloadBlob(result.blob, result.filename)}
          >
            Download
          </button>
        </div>
      ) : null}

      <button className="remove-button" type="button" onClick={onRemove}>
        Remove
      </button>
    </article>
  );
}
