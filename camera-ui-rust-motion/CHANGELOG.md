## [1.2.3]

- Small and slow movement is detected reliably now, day and night. The detector briefly holds its comparison image, so slow movement adds up instead of slipping below the threshold. Nearby changed regions count as one movement, so a distant animal is one hit instead of a few specks. A camera move or a sudden exposure change resets the detector instead of lighting up the whole picture.
- New Reference Hold setting: how many seconds the comparison image is kept. Higher catches slower movement, lower keeps boxes closer to the current position.
- The Area setting changed its meaning with this and applies to the combined size of nearby regions. All installations are moved to the new defaults once; your own tuning stays untouched after that.

## [1.2.2]

- Updated camera.ui engine

## [1.2.1]

- Updated camera.ui engine

## [1.2.0]

- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Fix resetting the sensor to defaults not persisting the area, threshold, blur radius, and dilation size values, because the storage writes were not awaited; defaults are now saved reliably

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