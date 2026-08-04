## [1.2.3]

- New sensor types reach HomeKit. Carbon monoxide, carbon dioxide (level plus alarm above 1500 ppm), illuminance and vibration sensors now appear in Apple Home; vibration shows up as a motion sensor since HomeKit has no vibration category. Gas, heat, cold, tamper, problem and power stay camera.ui-only, HomeKit has no matching accessory type.

## [1.2.2]

- Minor bugfixes and improvements

## [1.2.1]

- The bridge is found by the Home app again. It announced itself under a name the network stack couldn't handle, so Home never saw it and pairing by QR code ran into a timeout. The bridge is now called "camera ui Bridge".
- The bridge now starts even when no sensor is exposed yet. QR code, PIN and port are there from the first start, so you can pair the bridge up front and sensors you expose later show up in the Home app right away.

## [1.2.0]

- New camera.ui Bridge accessory for standalone sensors. Contact, occupancy, smoke, leak, temperature, humidity, lock, garage door, switch and security system sensors, plus standalone lights and sirens, come across behind a single bridge. Pair it once and every sensor you expose later joins automatically. QR code, PIN, port and a reset button live in the plugin settings.
- Camera accessories now carry their camera's hardware: spotlight, siren and battery show up on the camera itself, alongside motion and doorbell.
- The "Expose sensor" toggle on the Sensors page decides what reaches HomeKit. Un-exposing a sensor removes it, exposing brings it back.
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.7]

- Added new camera settings flag to disable hardware acceleration

## [1.1.6]

- Disabled and offline cameras stay in HomeKit and show a placeholder image instead of disappearing. Snapshots and live streams show "privacy mode" for disabled cameras, "offline" for disconnected ones, and a fallback image when no snapshot is available
- HKSV recording and live streams clean up reliably after retries, reconnects and failed starts. Long-running setups no longer build up CPU and memory when a camera keeps dropping.

## [1.1.5]

- Bugfixes and improvements

## [1.1.4]

- Bugfixes and improvements

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Bugfixes and improvements

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