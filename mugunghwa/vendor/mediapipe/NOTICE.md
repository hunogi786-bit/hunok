# MediaPipe (vendored)

These files come from Google MediaPipe and are included unchanged, except that the
source-map comment was removed from `vision_bundle.mjs`.

- `vision_bundle.mjs`, `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm`:
  npm package `@mediapipe/tasks-vision` version 0.10.14
- `models/pose_landmarker_lite.task`: Pose Landmarker (lite, float16, version 1) model

License: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
Project: https://github.com/google-ai-edge/mediapipe

They are stored here so the app runs entirely from its own folder: body tracking
happens on the device, works offline once installed, and the page never needs to
contact another site.
