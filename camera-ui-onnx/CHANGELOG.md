## [1.2.8]

- The confidence thresholds are gone from the plugin settings. Object, face and plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it loaded and which device it runs on, so camera.ui can show it in the camera metrics.

## [1.2.6]

- Updated camera.ui engine

## [1.2.5]

- **The recommended face detection model changed.** Behind the "default" option there is now a stronger model: on test footage it finds a face in 82% of frames where the previous one managed 30%, and it stops mistaking the back of a head for a face. Your current selection stays untouched. New installs get it right away; on an existing one, pick "default" in the model list or use Reset to Defaults. A face check then costs about twice the compute, and only runs when a person was seen.

## [1.2.4]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

## [1.2.3]

- The plugin moved to the CUDA 13 runtime (onnxruntime-gpu 1.28). The RTX 50 series now runs with native kernels instead of relying on a JIT fallback. Your system needs CUDA 13, cuDNN 9 for CUDA 13 and NVIDIA driver 580 or newer.
- NVIDIA GPUs before the GTX 1650 (Maxwell, Pascal, Volta) lost GPU support in CUDA 13. Use the new sibling plugin "ONNX Legacy" on those cards, it stays on the CUDA 12 runtime and keeps them on the GPU. Also the right choice if you want to keep an installed CUDA 12 toolkit. The log points to it when GPU inference fails.

## [1.2.2]

- Fixed license plate detection failing whenever exactly one plate was in the frame. The log showed "License plate detection error: invalid index to scalar variable" and the plate was not read. Two or more plates worked fine.

## [1.2.1]

- CUDA works again on Linux and Windows. The fix from 1.2.0 was undone shortly before the release, so the CPU runtime was installed next to the GPU one again and overwrote it. Detection then stayed on the CPU no matter what the Execution Provider setting said.
- The log says it now when the selected provider is missing from the installed runtime, instead of quietly running on the CPU.

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