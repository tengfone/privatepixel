export interface PrivatePixelGeneratedModule {
  resize_rgba(
    input: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): Uint8Array;
  crop_rgba(
    input: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8Array;
}

export default async function init(): Promise<void> {
  throw new Error("PrivatePixel WASM bindings have not been generated yet.");
}

export function resize_rgba(): Uint8Array {
  throw new Error("PrivatePixel WASM bindings have not been generated yet.");
}

export function crop_rgba(): Uint8Array {
  throw new Error("PrivatePixel WASM bindings have not been generated yet.");
}
