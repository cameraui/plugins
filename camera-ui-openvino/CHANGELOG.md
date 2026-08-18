## [1.2.11]

- A second CLIP model is available for semantic search. The dropdown now has a Default option, existing setups move to it automatically, and search picks the matching text model on its own.
- Object detection follows the per-type confidence values (person, vehicle, animal) from the camera settings

## [1.2.10]

- The confidence thresholds are gone from the plugin settings. Object, face and plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it loaded and which device it runs on, so camera.ui can show it in the camera metrics.

## [1.2.8]

- Updated camera.ui engine

## [1.2.7]

- **The recommended face detection model changed.** Behind the "default" option there is now a stronger model: on test footage it finds a face in 82% of frames where the previous one managed 30%, and it stops mistaking the back of a head for a face. Your current selection stays untouched. New installs get it right away; on an existing one, pick "default" in the model list or use Reset to Defaults. A face check then costs about twice the compute, and only runs when a person was seen.

## [1.2.6]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

## [1.2.5]

- Maintenance release. The readme now points old Intel GPUs on Windows to the OpenVino Legacy plugin, no functional changes.

## [1.2.4]

- When an Intel GPU on Windows refuses to compile a model, the log now points to the new OpenVino Legacy plugin. Its older runtime still loads all models on GPUs up to 10th gen Core, where the regular plugin silently fell back to the CPU.

## [1.2.3]

- Fixed license plate detection failing whenever exactly one plate was in the frame. The log showed "License plate detection error: invalid index to scalar variable" and the plate was not read. Two or more plates worked fine.

## [1.2.2]

- Detection is roughly 50 times faster. The plugin set up your hardware for throughput, which pays off when hundreds of images are queued at once, but detection sends one frame and waits for the answer. On an Intel GPU that single frame took about a second instead of eleven milliseconds, so only one frame per second was analyzed and anyone walking past was easily missed. The setup is now tuned for a fast single answer.
- A GPU serves more cameras at once. It now works on two frames in parallel, which keeps it busy while picture data is being moved around.

## [1.2.1]

- A device that can't run a model no longer floods the log. If your GPU driver refuses a model, the log now says so in one line and names the reason, instead of dumping a multi-line driver trace for every model. Detection keeps running on the next device, as before.
- The device list in the log now includes the graphics driver version. On older Intel chips the driver decides whether the GPU can be used at all, and this is the first thing to check when models end up on the CPU.
- Older Intel GPUs get a second chance before a model drops to the CPU. If the graphics driver refuses a model, it is now retried at full precision on the same device.

## [1.2.0]

- Models now compile once instead of on every start. Compiled models are cached on disk, so a plugin restart skips the heavy GPU/NPU compilation that could stall weaker systems. The first start after an update or model change still compiles.
- The Active Hardware field shows the device inference actually runs on. With AUTO it used to freeze on the temporary CPU stage shown while the real device was still compiling in the background.
- Fixed the "Re-download Models" button doing nothing. Pressing it failed with a handler error in the log.
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

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