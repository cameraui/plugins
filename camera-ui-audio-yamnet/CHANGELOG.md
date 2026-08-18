## [1.2.4]

- The sensor settings are gone: the plugin always listens for the standard camera.ui sounds, and the confidence comes from the camera's audio confidence setting
- Detections use the standard camera.ui labels; unmapped YAMNet classes no longer leak through as raw class names

## [1.2.3]

- The plugin reports which model it loaded and which device it runs on, so camera.ui can show it in the camera metrics.

## [1.2.2]

- Bugfixes and improvements

## [1.2.1]

- Updated camera.ui engine

## [1.2.0]

- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.6]

- Raise the default confidence threshold to 0.7, the old default let through almost every noise
- Report one sound once, a bark no longer counts as both Bark and Dog

## [1.1.5]

- Exclude downloaded models from backups

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Load classifier labels off the event loop, alongside the model, so plugin startup no longer blocks
- Update camera.ui SDK
- Bump camera.ui engine to v2.0.5

## [1.1.0]

- Bump camera.ui engine to v2

## [1.0.3]

- Bump camera.ui engine

## [1.0.2]

- Bugfixes and improvements

## [1.0.1]

- Bugfixes and improvements

## [1.0.0]

- Initial Release