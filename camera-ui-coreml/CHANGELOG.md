## [1.2.9]

- Minor bugfixes

## [1.2.8]

- **License plates are read again.** Every read was scored as unreadable and dropped before it reached an event, whatever the camera saw. If you lowered the reading confidence in the camera settings to work around it, put it back.

## [1.2.6]

- A second CLIP model is available for the semantic search, and the model is a single plugin setting now instead of a per-camera choice. After switching, the recordings view offers to reindex existing events so old footage stays searchable.
- Object detection follows the per-type confidence values (person, vehicle, animal) from the camera settings

## [1.2.5]

- The confidence thresholds are gone from the plugin settings. Object, face and plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it loaded and which device it runs on, so camera.ui can show it in the camera metrics.

## [1.2.3]

- Updated camera.ui engine

## [1.2.2]

- **The recommended face detection model changed.** Behind the "default" option there is now a stronger model: on test footage it finds a face in 82% of frames where the previous one managed 30%, and it stops mistaking the back of a head for a face. Your current selection stays untouched. New installs get it right away; on an existing one, pick "default" in the model list or use Reset to Defaults. A face check then costs about twice the compute, and only runs when a person was seen.

## [1.2.1]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

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