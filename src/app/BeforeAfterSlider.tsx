import {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  Ref,
  useEffect,
  useRef,
  useState,
} from "react";

const COMPARE_STEP = 5;

interface BeforeAfterSliderProps {
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
  beforeImageRef?: Ref<HTMLImageElement>;
  children?: ReactNode;
}

function clampPosition(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }

  return Math.min(100, Math.max(0, value));
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

export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeAlt,
  afterAlt,
  beforeImageRef,
  children,
}: BeforeAfterSliderProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [position, setPosition] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const transition =
    reducedMotion || dragging ? "none" : "left 120ms linear, clip-path 120ms linear";
  const frameStyle = {
    "--compare-position": `${position}%`,
  } as CSSProperties;

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
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const delta = event.key === "ArrowRight" ? COMPARE_STEP : -COMPARE_STEP;
    setPosition((current) => clampPosition(Math.round(current) + delta));
  }

  return (
    <div
      ref={frameRef}
      className="preview-image-stack compare-frame"
      data-testid="compare-frame"
      style={frameStyle}
    >
      <img ref={beforeImageRef} src={beforeSrc} alt={beforeAlt} />
      <div className="compare-after" data-testid="compare-after" style={{ transition }}>
        <img src={afterSrc} alt={afterAlt} />
      </div>
      {children}
      <span className="compare-label compare-label-before">Before</span>
      <span className="compare-label compare-label-after">After</span>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Before and after"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)} percent processed`}
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
