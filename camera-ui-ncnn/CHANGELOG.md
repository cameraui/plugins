## [1.2.5]

- The confidence thresholds are gone from the plugin settings. Object, face and plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.

## [1.2.3]

- Updated camera.ui engine

## [1.2.2]

- **The recommended face detection model changed.** Behind the "default" option there is now a stronger model: on test footage it finds a face in 82% of frames where the previous one managed 30%, and it stops mistaking the back of a head for a face. Your current selection stays untouched. New installs get it right away; on an existing one, pick "default" in the model list or use Reset to Defaults. A face check then costs about twice the compute, and only runs when a person was seen.

## [1.2.1]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

## [1.2.0]

- Fixed the "Re-download Models" button doing nothing. Pressing it failed with a handler error in the log.
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.7]

- Pick which Vulkan GPU runs inference. A new Vulkan Device option lists the detected GPUs, so multi-GPU systems can pin detection to a specific card. Auto keeps the previous behavior.

## [1.1.6]

- No more "dlopen failed libvulkan.so.1" spam on systems without Vulkan. The GPU probe is skipped when the Vulkan library is not installed, inference runs on CPU as before.
- Software Vulkan devices (llvmpipe/lavapipe) no longer count as GPUs. Inference on them is slower than the plain CPU path, so setups without a real GPU stay on CPU.

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