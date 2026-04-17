export class JobCancellationRegistry {
  private readonly canceledJobIds = new Set<string>();

  cancel(jobId: string): void {
    this.canceledJobIds.add(jobId);
  }

  isCanceled(jobId: string): boolean {
    return this.canceledJobIds.has(jobId);
  }

  throwIfCanceled(jobId: string): void {
    if (this.isCanceled(jobId)) {
      throw new JobCanceledError(jobId);
    }
  }

  clear(jobId: string): void {
    this.canceledJobIds.delete(jobId);
  }
}

export class JobCanceledError extends Error {
  constructor(jobId: string) {
    super(`Job canceled: ${jobId}`);
    this.name = "JobCanceledError";
  }
}
