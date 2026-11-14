import {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  Ref,
  SyntheticEvent,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Size,
  clampPosition,
  containedBox,
  nextKeyboardPosition,
} from "./compareGeometry";

export interface BeforeAfterSliderHandle {
  /** Moves the divider to a viewport x coordinate and focuses the handle. */
  moveToClientX: (clientX: number) => void;
}

interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
  beforeImageRef?: Ref<HTMLImageElement>;
  handleRef?: Ref<BeforeAfterSliderHandle>;
  children?: ReactNode;
}

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Pointer capture is unavailable until the browser activates the pointer.
  }
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore capture cleanup when the pointer id was never captured.
  }
}

function naturalSize(event: SyntheticEvent<HTMLImageElement>): Size | null {
  const { naturalWidth, naturalHeight } = event.currentTarget;
  return naturalWidth > 0 && naturalHeight > 0
    ? { width: naturalWidth, height: naturalHeight }
    : null;
}

/**
 * Original on the left of the divider, processed result on the right. Both
 * layers are clipped to their own side and sit on a checkerboard so
 * transparent pixels in a cut-out never reveal the other image.
 */
export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeAlt,
  afterAlt,
  beforeImageRef,
  handleRef,
  children,
}: BeforeAfterSliderProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [position, setPosition] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [beforeSize, setBeforeSize] = useState<Size | null>(null);
  const [afterSize, setAfterSize] = useState<Size | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useImperativeHandle(handleRef, () => ({
    moveToClientX(clientX: number) {
      sliderRef.current?.focus({ preventScroll: true });
      moveTo(clientX);
    },
  }));

  const transition =
    reducedMotion || dragging ? "none" : "left 120ms linear, clip-path 120ms linear";
  const rounded = Math.round(position);
  const beforeClip = `inset(0 ${100 - position}% 0 0)`;
  const afterClip = `inset(0 0 0 ${position}%)`;

  function moveTo(clientX: number): void {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    setPosition(clampPosition(((clientX - rect.left) / rect.width) * 100));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    event.currentTarget.focus({ preventScroll: true });
    event.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    capturePointer(event.currentTarget, event.pointerId);
    moveTo(event.clientX);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }

    event.stopPropagation();
    moveTo(event.clientX);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) {
      return;
    }

    event.stopPropagation();
    draggingRef.current = false;
    setDragging(false);
    releasePointer(event.currentTarget, event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = nextKeyboardPosition(event.key, position);
    if (next === null) {
      return;
    }

    event.preventDefault();
    setPosition(next);
  }

  return (
    <div
      ref={frameRef}
      className="preview-image-stack compare-frame"
      data-testid="compare-frame"
      style={{ "--compare-position": `${position}%` } as CSSProperties}
    >
      <img
        ref={beforeImageRef}
        className="compare-before checkerboard"
        data-testid="compare-before"
        src={beforeSrc}
        alt={beforeAlt}
        style={{ clipPath: beforeClip, transition }}
        onLoad={(event) => setBeforeSize(naturalSize(event))}
      />
      <div
        className="compare-after"
        data-testid="compare-after"
        style={{ clipPath: afterClip, transition }}
      >
        <img
          className="checkerboard"
          src={afterSrc}
          alt={afterAlt}
          style={containedBox(beforeSize, afterSize)}
          onLoad={(event) => setAfterSize(naturalSize(event))}
        />
      </div>
      {children}
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label="Before and after"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={`${rounded}% original on the left, ${100 - rounded}% processed on the right`}
        className="compare-handle"
        style={{ transition }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/**
 * Side labels live on the stage, outside the zoomed canvas, so they stay
 * readable at every zoom level and never sit under the zoom toolbar.
 */
export function CompareLabels() {
  return (
    <>
      <span className="compare-label compare-label-before" data-testid="label-before">
        Before
      </span>
      <span className="compare-label compare-label-after" data-testid="label-after">
        After
      </span>
    </>
  );
}
