import type {
  ImageJobProgress,
  ImageJobRequest,
  ImageJobSuccess,
  ImageWorkerInbound,
  ImageWorkerOutbound,
} from "../image/types";

export class ImageWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: ImageJobSuccess) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ImageJobProgress) => void;
    }
  >();

  constructor() {
    this.worker = new Worker(new URL("./image.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleMessage);
  }

  process(
    request: ImageJobRequest,
    onProgress?: (progress: ImageJobProgress) => void,
  ): Promise<ImageJobSuccess> {
    const message: ImageWorkerInbound = { type: "process", request };

    return new Promise((resolve, reject) => {
      this.pending.set(request.jobId, { resolve, reject, onProgress });
      this.worker.postMessage(message, [request.source.buffer]);
    });
  }

  cancel(jobId: string): void {
    const message: ImageWorkerInbound = { type: "cancel", jobId };
    this.worker.postMessage(message);

    const pending = this.pending.get(jobId);
    if (pending) {
      pending.reject(new Error("Job canceled"));
      this.pending.delete(jobId);
    }
  }

  destroy(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Image worker was terminated"));
    }
    this.pending.clear();
  }

  private readonly handleMessage = (event: MessageEvent<ImageWorkerOutbound>): void => {
    const message = event.data;
    const pending = this.pending.get(message.jobId);

    if (!pending) {
      return;
    }

    if (message.type === "progress") {
      pending.onProgress?.(message);
      return;
    }

    this.pending.delete(message.jobId);

    if (message.type === "success") {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error));
    }
  };
}
