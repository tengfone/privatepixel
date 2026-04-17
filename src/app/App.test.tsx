import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
    expect(screen.getByLabelText("Batch workers")).toBeDisabled();
    expect(workerConstructor).not.toHaveBeenCalled();
  });
});
