# PrivatePixel

PrivatePixel is a browser-based image utility suite for local image editing. It
lets users resize, compress, convert, crop, preview output size, and export images
entirely on their own device.

The product promise is simple:

- No uploads
- No account
- No paywall
- No watermark
- No server-side image processing
- No remote inference fallback for private image work

PrivatePixel is designed for static hosting on GitHub Pages. Source images stay in
browser memory for the session, and image jobs run through browser APIs, Web
Workers, and narrow WASM-ready processing boundaries.

## Current Features

- Drag and drop or file picker import for local images.
- Local queue with file name, dimensions, MIME type, byte size, preview, progress,
  and output results.
- Resize tool with exact width and height fields, aspect-ratio lock, fit modes,
  interactive resize frame handles, canvas zoom, and common publishing presets.
- Compress tool with target format, image-quality control, and local size preview.
- Convert tool with target format and high-quality local browser encoding.
- Crop tool powered by an interactive cropper with zoom, aspect presets, rotation,
  and output format controls.
- Centered preview stage with zoom controls for preview, compress, convert, and
  remove-background views.
- Live output size preview that locally encodes the selected image after option
  changes and shows output bytes, percentage change, dimensions, format, and encode
  time.
- Batch processing with a small worker concurrency limit to reduce memory spikes.
- Result download per image, plus download-all for completed results.
- GitHub Pages deployment workflow.

## Supported Formats

Input formats:

- PNG
- JPEG
- WebP
- GIF
- BMP
- AVIF

Output formats:

- PNG
- JPEG
- WebP
- AVIF
- SVG wrapper

SVG output is a raster wrapper: the processed image is encoded as PNG data inside
an SVG container. It is useful for workflows that require an `.svg` file extension,
but it does not vectorize the image.

Browser support still matters. If the current browser cannot encode a selected
format, PrivatePixel reports that failure instead of sending the image elsewhere.

## Resize Presets

The resize tool includes common target sizes:

- Slack profile: `1024 x 1024`
- YouTube thumbnail: `1280 x 720`
- Instagram portrait: `1080 x 1350`
- Story / TikTok: `1080 x 1920`
- Instagram square: `1080 x 1080`
- Instagram wide: `1080 x 566`
- YouTube banner: `2560 x 1440`
- LinkedIn post: `1200 x 627`
- X post: `1600 x 900`
- X header: `1500 x 500`
- Facebook link: `1200 x 630`
- Pinterest pin: `1000 x 1500`

Presets use `cover` mode so the output matches the exact requested dimensions with
a centered local crop. Use `contain` when preserving the full source image is more
important than filling the target box.

## Background Removal

The remove-background tool is intentionally present but disabled in the current
runtime path. The worker contract, lazy runtime boundary, local model folder, and
local vendor asset folder are prepared, but the actual background-removal runtime
still needs to be wired before the UI enables the tool.

Prepared local asset paths include:

- `public/models/briaai/RMBG-1.4`
- `public/models/Xenova/modnet`
- `public/models/mediapipe/face_detector`
- `public/vendor/onnxruntime-web`
- `public/vendor/mediapipe/tasks-vision`

When background removal is enabled, model and runtime assets should load from these
local static paths and remain outside the initial app bundle. The app should not
call a remote image-processing or inference API as a fallback.

## Stack

- Vite
- React
- TypeScript
- Plain CSS
- Web Workers
- Browser image APIs: `createImageBitmap`, `OffscreenCanvas`, canvas encoding,
  object URLs, file input, and drag/drop
- `pica` for high-quality local resizing paths
- `react-easy-crop` for the interactive crop UI
- `@huggingface/transformers` and local ONNX Runtime assets prepared for future
  local background removal
- `@mediapipe/tasks-vision` and local MediaPipe assets prepared for future local
  model utilities
- Rust/WASM scaffold for future hot paths
- Vitest for unit tests
- Playwright for browser flow tests
- GitHub Actions and GitHub Pages for static deployment

## Project Structure

```text
src/app                  React app shell, layout, controls, and workspace UI
src/features             Feature-specific runtime boundaries
src/image                Shared image types, option helpers, metadata, downloads
src/workers              Worker client, worker entrypoint, job handling
src/wasm                 TypeScript wrappers and generated WASM binding location
wasm/privatepixel-core   Rust crate for future WASM image operations
public/models            Local model assets kept out of the initial JS bundle
public/vendor            Local model runtime assets kept out of the initial JS bundle
e2e                      Playwright browser tests
.github/workflows        GitHub Pages deployment workflow
```

## Local Development

PrivatePixel uses pnpm.

```sh
pnpm install
pnpm run dev
```

Build for production:

```sh
pnpm run build
```

Preview a production build locally:

```sh
pnpm run preview
```

To test the GitHub Pages project base path locally:

```sh
PRIVATEPIXEL_BASE=/privatepixel/ pnpm run build
PRIVATEPIXEL_BASE=/privatepixel/ pnpm exec vite preview --host 127.0.0.1 --port 4173
```

Then open:

```text
http://127.0.0.1:4173/privatepixel/
```

## Scripts

```sh
pnpm run dev
pnpm run build
pnpm run preview
pnpm run lint
pnpm run format
pnpm run format:check
pnpm run test
pnpm run test:watch
pnpm run test:e2e
pnpm run wasm:build
pnpm run wasm:test
```

## Testing

Unit tests cover image option logic such as resize dimension calculation, crop
normalization, rotation helpers, MIME/extension mapping, quality clamping, and
resize presets.

Playwright tests cover the browser workflow under the GitHub Pages-style base path:
importing an image, verifying the live output size preview, applying a resize
preset, running a resize job, and seeing the output result.

Run the main checks:

```sh
pnpm run format:check
pnpm run lint
pnpm run test
pnpm run build
pnpm run test:e2e
```

## Rust/WASM

The Rust crate lives in `wasm/privatepixel-core` and is intended for narrow image
hot paths such as RGBA resize, crop, alpha handling, and pixel utilities.

The browser currently decodes images first, then the worker pipeline can pass RGBA
buffers through optimized local processing paths. The app does not depend on WASM
threads or `SharedArrayBuffer` because GitHub Pages does not provide the COOP/COEP
headers needed for threaded WASM.

WASM commands require a local Rust toolchain and `wasm-pack`:

```sh
pnpm run wasm:build
pnpm run wasm:test
```

## Deployment

The GitHub Actions workflow builds and deploys the static app to GitHub Pages on
pushes to `main`.

The Vite base path is controlled by `vite.config.ts`:

- Default local base: `/`
- GitHub Pages base when `GITHUB_PAGES=true`: `/privatepixel/`
- Manual override: `PRIVATEPIXEL_BASE=/some-base/`

## Privacy Model

PrivatePixel is built so basic image editing stays local:

- Files are read through browser file APIs.
- Previews use object URLs.
- Image processing runs in the browser and Web Worker.
- Results are returned as local blobs.
- Downloads are initiated from the browser session.
- The current background-removal path does not fall back to remote inference.

Avoid adding telemetry, hosted model URLs, upload endpoints, or server-side image
processing unless the product promise is intentionally changed.
