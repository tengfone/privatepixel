import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { heicTo } from "heic-to";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "./App";
import type { ImageJobRequest } from "../image/types";
import { ImageWorkerClient } from "../workers/imageClient";

vi.mock("heic-to", () => ({
  heicTo: vi.fn(),
}));

let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

function stubObjectUrls(): void {
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:privatepixel-test"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
}

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
    } else {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
    }

    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    } else {
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }

    originalCreateObjectUrl = undefined;
    originalRevokeObjectUrl = undefined;
  });

  it("renders the workspace as the first screen", () => {
    render(<App />);

    expect(screen.getByText("Drop images here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Resize" })).toBeDisabled();
    expect(screen.getByText("Your local queue is empty")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Don't take our word for it. Verify it.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Watch the network tab")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View source on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/tengfone/privatepixel",
    );
    expect(screen.getByTestId("file-input")).toHaveAttribute(
      "accept",
      expect.stringContaining("image/heic"),
    );
    expect(screen.getByTestId("file-input")).toHaveAttribute(
      "accept",
      expect.stringContaining(".heic"),
    );
  });

  it("enables Remove BG controls without starting live preview inference", async () => {
    const workerConstructor = vi.fn();
    class MockWorker {
      constructor() {
        workerConstructor();
      }

      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      postMessage = vi.fn();
      terminate = vi.fn();
    }

    stubObjectUrls();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 120,
        height: 80,
        close: vi.fn(),
      })),
    );
    vi.stubGlobal("Worker", MockWorker);

    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Remove BG/ }));
    expect(screen.queryByText("Not installed")).not.toBeInTheDocument();

    await user.click(screen.getByText("Advanced"));
    expect(screen.getByLabelText("Cutout model")).toHaveValue("auto");
    expect(screen.getByRole("option", { name: "Auto" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Portrait (faster/lighter)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "General objects" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Best result" })).toBeInTheDocument();

    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array([1, 2, 3])], "portrait.png", {
        type: "image/png",
      }),
    );

    expect(await screen.findAllByText("portrait.png")).not.toHaveLength(0);
    expect(
      await screen.findByText(
        "Run Remove BG to create a transparent PNG. Models load only when needed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Remove BG" })).toBeEnabled();
    expect(screen.getByLabelText("Batch speed")).toBeDisabled();
    expect(screen.getByLabelText("Batch speed")).toHaveValue("1");
    expect(
      screen.getByText(
        "Remove BG works on one image at a time to keep local model memory stable.",
      ),
    ).toBeInTheDocument();
    expect(workerConstructor).not.toHaveBeenCalled();
  });

  it("shows Object Select as a click-first tool without loading a worker", async () => {
    const workerConstructor = vi.fn();
    class MockWorker {
      constructor() {
        workerConstructor();
      }

      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      postMessage = vi.fn();
      terminate = vi.fn();
    }

    vi.stubGlobal("Worker", MockWorker);

    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Object Select/ }));

    expect(screen.getByText("Click an object")).toBeInTheDocument();
    expect(
      screen.getByText("Choose the shoe, mug, person, logo, or object you want."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Object Select works on the image you clicked."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cut Out Selection" })).toBeDisabled();
    expect(workerConstructor).not.toHaveBeenCalled();
  });

  it("decodes a HEIC file, keeps its name and size, and compares after a run", async () => {
    vi.mocked(heicTo).mockResolvedValue(
      new Blob([new Uint8Array(4096)], { type: "image/png" }),
    );
    stubObjectUrls();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        // No native HEIC decoder in this browser; the PNG working copy decodes.
        if (blob.type !== "image/png") {
          throw new DOMException("The source image could not be decoded.");
        }
        return { width: 40, height: 20, close: vi.fn() };
      }),
    );
    // jsdom's Blob has no arrayBuffer(); the app reads file bytes before a run.
    const hadArrayBuffer = "arrayBuffer" in Blob.prototype;
    if (!hadArrayBuffer) {
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        value(this: Blob) {
          return Promise.resolve(new ArrayBuffer(this.size));
        },
      });
    }
    onTestFinished(() => {
      if (!hadArrayBuffer) {
        delete (Blob.prototype as unknown as Record<string, unknown>).arrayBuffer;
      }
    });
    const processed: ImageJobRequest[] = [];
    vi.spyOn(ImageWorkerClient.prototype, "process").mockImplementation(
      async (request) => {
        processed.push(request);
        return {
          type: "success",
          jobId: request.jobId,
          assetId: request.assetId,
          status: "success",
          blob: new Blob([new Uint8Array(1000)], { type: "image/jpeg" }),
          mimeType: "image/jpeg",
          size: 1000,
          width: 40,
          height: 20,
          filename: "vacation-compress.jpg",
          durationMs: 5,
        };
      },
    );
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        postMessage = vi.fn();
        terminate = vi.fn();
      },
    );

    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array(2000)], "vacation.heic", { type: "" }),
    );

    expect(await screen.findAllByText("vacation.heic")).not.toHaveLength(0);
    expect(heicTo).toHaveBeenCalledTimes(1);
    expect(heicTo).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }));
    expect(screen.queryByText(/Unsupported image type/)).not.toBeInTheDocument();
    expect(screen.getByTestId("heic-note")).toHaveTextContent(
      /EXIF\/GPS metadata, colour profile, and HDR are not carried over/,
    );
    // Sizes are reported against the 2 KB HEIC, not the PNG working copy.
    expect(screen.getByText(/40 x 20 \/ 2\.0 KB \/ image\/heic/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Compress/ }));
    expect(
      screen.queryByRole("slider", { name: "Before and after" }),
    ).not.toBeInTheDocument();
    expect(screen.getByAltText("Selected vacation.heic")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run Compress" }));

    const slider = await screen.findByRole("slider", { name: "Before and after" });
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByAltText("Processed vacation.heic")).toBeInTheDocument();
    expect(screen.getByTestId("label-before")).toHaveTextContent("Before");
    expect(screen.getByTestId("label-after")).toHaveTextContent("After");
    expect(screen.getByTestId("result-row")).toHaveTextContent("-50%");

    const run = processed.find((request) => request.operation.type === "compress");
    expect(run?.source.name).toBe("vacation.heic");
    expect(run?.source.mimeType).toBe("image/png");
  });

  it("reports a HEIC decode failure instead of an unsupported type", async () => {
    vi.mocked(heicTo).mockRejectedValue(new Error("wasm failed"));
    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array([9])], "vacation.heic", { type: "image/heic" }),
    );

    expect(
      await screen.findByText(
        "vacation.heic couldn't be decoded. The file may be damaged or use an unsupported HEIC variant.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported image type/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add PNG, JPEG/)).not.toBeInTheDocument();
  });
});
