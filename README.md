# PrivatePixel

PrivatePixel is a browser-based image utility suite for resizing, compressing,
converting, cropping, and exporting images entirely on the user's device.

The app is intentionally static-hosting friendly: no uploads, no accounts, no
server-side image processing, no paywalls, and no watermarks.

## Stack

- Vite + React + TypeScript
- Web Workers for image jobs
- Browser-native image APIs first
- Rust/WASM boundary for future hot paths
- GitHub Pages deployment

## Scripts

```sh
pnpm install
pnpm run dev
pnpm run build
pnpm run test
pnpm run test:e2e
```

The Rust crate is scaffolded in `wasm/privatepixel-core`. Building it requires a
local Rust toolchain and `wasm-pack`.
