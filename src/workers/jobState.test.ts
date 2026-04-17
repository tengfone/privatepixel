import { describe, expect, it } from "vitest";
import { JobCanceledError, JobCancellationRegistry } from "./jobState";

describe("JobCancellationRegistry", () => {
  it("tracks canceled jobs", () => {
    const registry = new JobCancellationRegistry();

    registry.cancel("job-1");

    expect(registry.isCanceled("job-1")).toBe(true);
    expect(registry.isCanceled("job-2")).toBe(false);
  });

  it("throws a typed cancellation error", () => {
    const registry = new JobCancellationRegistry();
    registry.cancel("job-1");

    expect(() => registry.throwIfCanceled("job-1")).toThrow(JobCanceledError);
  });

  it("clears canceled jobs", () => {
    const registry = new JobCancellationRegistry();
    registry.cancel("job-1");
    registry.clear("job-1");

    expect(registry.isCanceled("job-1")).toBe(false);
  });
});
