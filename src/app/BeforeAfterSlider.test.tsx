import { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BeforeAfterSlider,
  BeforeAfterSliderHandle,
  CompareLabels,
} from "./BeforeAfterSlider";
import { containedBox } from "./compareGeometry";

function stubFrameRect(width = 200, height = 100): void {
  screen.getByTestId("compare-frame").getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

function renderSlider() {
  return render(
    <BeforeAfterSlider
      beforeSrc="blob:before"
      afterSrc="blob:after"
      beforeAlt="Original vacation"
      afterAlt="Processed vacation"
    />,
  );
}

function slider() {
  return screen.getByRole("slider", { name: "Before and after" });
}

describe("BeforeAfterSlider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts halfway and nudges with Left and Right when focused", async () => {
    const user = userEvent.setup();
    renderSlider();

    expect(slider()).toHaveAttribute("aria-valuenow", "50");
    expect(slider()).toHaveAttribute("aria-valuemin", "0");
    expect(slider()).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByAltText("Original vacation")).toBeInTheDocument();
    expect(screen.getByAltText("Processed vacation")).toBeInTheDocument();

    slider().focus();
    await user.keyboard("{ArrowRight}");
    expect(slider()).toHaveAttribute("aria-valuenow", "55");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(slider()).toHaveAttribute("aria-valuenow", "45");
  });

  it("does not animate the handle when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderSlider();

    expect(slider()).toHaveStyle({ transition: "none" });
    expect(screen.getByTestId("compare-after")).toHaveStyle({ transition: "none" });
  });

  it("drags on pointer input without letting the gesture bubble", () => {
    const parentPointerDown = vi.fn();
    render(
      <div onPointerDown={parentPointerDown}>
        <BeforeAfterSlider
          beforeSrc="blob:before"
          afterSrc="blob:after"
          beforeAlt="Original vacation"
          afterAlt="Processed vacation"
        />
      </div>,
    );

    stubFrameRect();

    fireEvent.pointerDown(slider(), { clientX: 150, pointerId: 1, button: 0 });

    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(slider()).toHaveFocus();
    expect(slider()).toHaveAttribute("aria-valuenow", "75");
  });

  it("shows the original left of the divider and the processed image right of it", () => {
    render(
      <>
        <BeforeAfterSlider
          beforeSrc="blob:before"
          afterSrc="blob:after"
          beforeAlt="Original vacation"
          afterAlt="Processed vacation"
        />
        <CompareLabels />
      </>,
    );

    const before = screen.getByTestId("compare-before");
    const after = screen.getByTestId("compare-after");
    expect(before).toHaveAttribute("alt", "Original vacation");
    expect(after.querySelector("img")).toHaveAttribute("alt", "Processed vacation");
    // inset(top right bottom left): the original keeps its left part, the
    // result keeps its right part.
    expect(before.style.clipPath).toBe("inset(0 50% 0 0)");
    expect(after.style.clipPath).toBe("inset(0 0 0 50%)");
    expect(screen.getByTestId("label-before")).toHaveTextContent("Before");
    expect(screen.getByTestId("label-before")).toHaveClass("compare-label-before");
    expect(screen.getByTestId("label-after")).toHaveTextContent("After");
    expect(screen.getByTestId("label-after")).toHaveClass("compare-label-after");

    slider().focus();
    fireEvent.keyDown(slider(), { key: "End" });
    // Divider at the far right: only the original is visible.
    expect(before.style.clipPath).toBe("inset(0 0% 0 0)");
    expect(after.style.clipPath).toBe("inset(0 0 0 100%)");
    expect(slider()).toHaveAttribute(
      "aria-valuetext",
      "100% original on the left, 0% processed on the right",
    );
  });

  it("puts both layers on a checkerboard so transparency is visible", () => {
    renderSlider();

    expect(screen.getByTestId("compare-before")).toHaveClass("checkerboard");
    expect(screen.getByAltText("Processed vacation")).toHaveClass("checkerboard");
  });

  it("supports Home, End, Page Up, Page Down and the vertical arrows", async () => {
    const user = userEvent.setup();
    renderSlider();
    slider().focus();

    await user.keyboard("{Home}");
    expect(slider()).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{ArrowDown}");
    expect(slider()).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{PageUp}");
    expect(slider()).toHaveAttribute("aria-valuenow", "10");
    await user.keyboard("{ArrowUp}");
    expect(slider()).toHaveAttribute("aria-valuenow", "15");
    await user.keyboard("{End}");
    expect(slider()).toHaveAttribute("aria-valuenow", "100");
    await user.keyboard("{PageUp}");
    expect(slider()).toHaveAttribute("aria-valuenow", "100");
    await user.keyboard("{PageDown}");
    expect(slider()).toHaveAttribute("aria-valuenow", "90");
    await user.keyboard("{ArrowDown}");
    expect(slider()).toHaveAttribute("aria-valuenow", "85");
  });

  it("moves the divider to a tapped point through its handle", () => {
    const handle = createRef<BeforeAfterSliderHandle>();
    render(
      <BeforeAfterSlider
        beforeSrc="blob:before"
        afterSrc="blob:after"
        beforeAlt="Original vacation"
        afterAlt="Processed vacation"
        handleRef={handle}
      />,
    );
    stubFrameRect();

    act(() => handle.current?.moveToClientX(50));
    expect(slider()).toHaveAttribute("aria-valuenow", "25");
    expect(slider()).toHaveFocus();
    act(() => handle.current?.moveToClientX(-40));
    expect(slider()).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("containedBox", () => {
  it("fills the frame when sizes are unknown or match", () => {
    expect(containedBox(null, null)).toEqual({
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
    });
    expect(
      containedBox({ width: 400, height: 200 }, { width: 200, height: 100 }),
    ).toEqual({ left: "0%", top: 0, width: "100%", height: "100%" });
  });

  it("letterboxes a wider or taller result inside the frame", () => {
    expect(
      containedBox({ width: 100, height: 100 }, { width: 200, height: 100 }),
    ).toEqual({ left: 0, top: "25%", width: "100%", height: "50%" });
    expect(
      containedBox({ width: 200, height: 100 }, { width: 100, height: 100 }),
    ).toEqual({ left: "25%", top: 0, width: "50%", height: "100%" });
  });
});
