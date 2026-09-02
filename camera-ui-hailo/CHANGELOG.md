## [1.2.8]

- Minor bugfixes

## [1.2.7]

- Updated deps

## [1.2.5]

- Object detection follows the per-type confidence values (person, vehicle, animal) from the camera settings

## [1.2.4]

- The confidence threshold is gone from the plugin settings. Object detection now uses the value from the camera's detection settings, so it is set in one place and a change takes effect right away.
- The plugin reports which model it loaded and which device it runs on, so camera.ui can show it in the camera metrics.

## [1.2.2]

- Updated camera.ui engine

## [1.2.1]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in the model dropdown.** It follows the recommended model, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.

## [1.2.0]

- Fixed the "Re-download Models" button doing nothing. Pressing it failed with a handler error in the log.
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.6]

- Pick which Hailo device runs inference when several are installed. A new device dropdown lists the detected devices. Auto keeps the previous behavior.

## [1.1.5]

- Exclude downloaded models from backups

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Hailo device/architecture detection now runs off the event loop, so startup no longer blocks while probing for the device
- Log the model name at load start and surface initialization failures instead of swallowing them; a failed load is now rolled back so it can be retried
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