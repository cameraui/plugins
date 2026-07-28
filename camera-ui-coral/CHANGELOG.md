## [1.1.6]

- Pick which Edge TPU runs inference when several are attached. A new device option accepts usb, pci or an index like :0. Empty keeps the previous behavior (first available).

## [1.1.5]

- Exclude downloaded models from backups

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Log the model name when a detector starts loading and surface initialization failures instead of swallowing them; a failed load is now rolled back so it can be retried
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