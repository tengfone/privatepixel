import init, {
  crop_rgba,
  resize_rgba,
  type PrivatePixelGeneratedModule,
} from "./privatepixel_core.generated";

export type PrivatePixelCore = Pick<
  PrivatePixelGeneratedModule,
  "resize_rgba" | "crop_rgba"
>;

let modulePromise: Promise<PrivatePixelCore | null> | undefined;

export function loadPrivatePixelCore(): Promise<PrivatePixelCore | null> {
  modulePromise ??= init()
    .then(() => ({ resize_rgba, crop_rgba }))
    .catch(() => null);

  return modulePromise;
}
