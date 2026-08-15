## [1.2.8]

- The confidence threshold is gone from the plugin settings. Object, face and plate detection now uses the value from the camera's detection settings, so it is set in one place and a change takes effect right away.

## [1.2.6]

- Updated camera.ui engine

## [1.2.5]

- **The recommended face detection model changed.** Behind the "default" option there is now a stronger model: on test footage it finds a face in 82% of frames where the previous one managed 30%, and it stops mistaking the back of a head for a face. Your current selection stays untouched. New installs get it right away; on an existing one, pick "default" in the model list or use Reset to Defaults. A face check then costs about twice the compute, and only runs when a person was seen.

## [1.2.4]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

## [1.2.3]

- Initial release. Same features as the ONNX plugin, but on the CUDA 12 runtime line (onnxruntime-gpu 1.26). The regular plugin moved to CUDA 13, which dropped NVIDIA GPUs before the GTX 1650 (Maxwell, Pascal, Volta); this plugin keeps them running on the GPU. Also for systems that stay on an installed CUDA 12 toolkit.
