import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { heicTo } from "heic-to";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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

  it("decodes a HEIC file locally and shows no compare slider before a result", async () => {
    vi.mocked(heicTo).mockResolvedValue(
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
    );
    stubObjectUrls();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 40,
        height: 20,
        close: vi.fn(),
      })),
    );

    const user = userEvent.setup();
    render(<App />);

    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array([9])], "vacation.heic", { type: "" }),
    );

    expect(await screen.findAllByText("vacation.jpg")).not.toHaveLength(0);
    expect(screen.getByText(/image\/jpeg/)).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported image type/)).not.toBeInTheDocument();
    expect(heicTo).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Compress/ }));
    expect(
      screen.queryByRole("slider", { name: "Before and after" }),
    ).not.toBeInTheDocument();
    expect(screen.getByAltText("Selected vacation.jpg")).toBeInTheDocument();
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
      await screen.findByText("HEIC/HEIF could not be decoded in this browser."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported image type/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add PNG, JPEG/)).not.toBeInTheDocument();
  });
});
