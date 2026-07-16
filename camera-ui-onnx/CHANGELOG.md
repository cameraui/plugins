## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Removed the CoreML execution provider; "auto" now selects CUDA on Linux/Windows x86_64 and CPU otherwise
- Tuned CUDA provider options (heuristic conv algorithm search, max cuDNN workspace) for faster inference
- Failed model initialization is now logged and surfaced and the failed model is evicted from cache so the next request retries; batched warm-up continues when one model fails
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