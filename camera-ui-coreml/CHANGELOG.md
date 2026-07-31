## [1.2.0]

- Models load much faster after the first start. The compiled model is kept on disk and reused instead of being recompiled on every plugin start.
- Fixed the "Re-download Models" button doing nothing. Pressing it failed with a handler error in the log.
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

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

- Log the model name at load start and surface initialization failures across object/face/plate detectors, the face embedder, OCR, and the CLIP encoder instead of swallowing them; a failed load is now rolled back so it can be retried
- Model reloads no longer abort the whole batch when a single model fails to load
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