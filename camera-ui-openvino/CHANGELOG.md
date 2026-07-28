## [1.1.7]

- Pick the exact inference device on multi-GPU systems. The device dropdown now lists every detected device individually (for example GPU.0 and GPU.1), so detection can run on a specific card instead of whatever OpenVINO picks.

## [1.1.6]

- Fixed a crash loop on machines with an Intel NPU: loading the CLIP model killed the plugin right after startup, over and over.
- Face recognition, license plate OCR and CLIP no longer fall back to the CPU. These models are now loaded with fixed input shapes, so the NPU and GPU can run them like the object detection models.

## [1.1.5]

- Exclude downloaded models from backups
- Update deps

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Failed model initialization is now logged and surfaced instead of silently swallowed, and the failed model is evicted from cache so the next request retries cleanly
- Model warm-up no longer aborts when a single model fails to load; the remaining models still initialize
- Update camera.ui SDK
- Bump camera.ui engine to v2.0.5

## [1.1.0]

- Bump camera.ui engine to v2

## [1.0.4]

- Bump camera.ui engine

## [1.0.3]

- Bugfixes and improvements

## [1.0.2]

- Bugfixes and improvements

## [1.0.1]

- Bugfixes and improvements

## [1.0.0]

- Initial Release