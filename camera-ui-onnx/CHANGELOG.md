## [1.2.0]

- CPU models load faster after the first start. The optimized model graph is kept on disk and reused instead of being rebuilt on every plugin start.
- Fixed the "Re-download Models" button doing nothing. Pressing it failed with a handler error in the log.
- CUDA works again. The plugin installed both the GPU and the CPU runtime on Linux and whichever landed last won, so detection often stayed on the CPU no matter what the Execution Provider setting said. Linux x86 now gets exactly the GPU-enabled runtime, CPU inference included
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