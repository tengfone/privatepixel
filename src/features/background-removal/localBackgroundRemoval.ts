export interface LocalBackgroundRemovalRuntime {
  removeBackground(source: ImageData): Promise<ImageData>;
}

export async function loadLocalBackgroundRemovalRuntime(): Promise<LocalBackgroundRemovalRuntime> {
  throw new Error(
    "Local background removal model assets are not bundled in this build.",
  );
}
