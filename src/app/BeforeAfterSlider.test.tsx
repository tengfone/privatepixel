import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeforeAfterSlider } from "./BeforeAfterSlider";

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

    const frame = screen.getByTestId("compare-frame");
    frame.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    fireEvent.pointerDown(slider(), { clientX: 150, pointerId: 1, button: 0 });

    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(slider()).toHaveFocus();
    expect(slider()).toHaveAttribute("aria-valuenow", "75");
  });
});
