import type { CSSProperties } from "react";

const COMPARE_STEP = 5;
const COMPARE_PAGE_STEP = 10;

export interface Size {
  width: number;
  height: number;
}

export function clampPosition(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }

  return Math.min(100, Math.max(0, value));
}

/**
 * Places the processed image inside the frame the same way `object-fit:
 * contain` would, but as a real box so its checkerboard backdrop covers only
 * the image pixels and not the letterbox around a result with another shape.
 */
export function containedBox(frame: Size | null, image: Size | null): CSSProperties {
  if (!frame || !image) {
    return { left: 0, top: 0, width: "100%", height: "100%" };
  }

  const frameRatio = frame.width / frame.height;
  const imageRatio = image.width / image.height;
  if (imageRatio > frameRatio) {
    const height = (frameRatio / imageRatio) * 100;
    return {
      left: 0,
      top: `${(100 - height) / 2}%`,
      width: "100%",
      height: `${height}%`,
    };
  }

  const width = (imageRatio / frameRatio) * 100;
  return { left: `${(100 - width) / 2}%`, top: 0, width: `${width}%`, height: "100%" };
}

export function nextKeyboardPosition(key: string, current: number): number | null {
  const rounded = Math.round(current);
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clampPosition(rounded + COMPARE_STEP);
    case "ArrowLeft":
    case "ArrowDown":
      return clampPosition(rounded - COMPARE_STEP);
    case "PageUp":
      return clampPosition(rounded + COMPARE_PAGE_STEP);
    case "PageDown":
      return clampPosition(rounded - COMPARE_PAGE_STEP);
    case "Home":
      return 0;
    case "End":
      return 100;
    default:
      return null;
  }
}
