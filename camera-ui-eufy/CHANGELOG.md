## [2.0.2]

- No light control on cameras that have none. A battery doorbell reports the spotlight setting without having a lamp, so camera.ui showed a light switch that answered every press with an error. Cameras whose spotlight this plugin cannot switch no longer offer one.

## [2.0.1]

- Cameras on a power supply, like the Floodlight Cam and Indoor Cam, no longer show a battery stuck at 100%
- Cameras behind one HomeBase stream at the same time without taking turns, and a snapshot no longer holds up the live view
- The Wired Doorbell 2K is recognized as a doorbell

## [2.0.0]

- **Rebuilt on the new Eufy SDK.** The plugin now uses the same cloud and P2P protocol as the current Eufy app. Log in again once in the plugin settings, a verification code may be asked for. Needs camera.ui 2.2.3 and Node.js 24.5 or newer, which the desktop app and the Docker image already ship
- **Eufy sensors come to camera.ui.** Entry sensors, motion sensors, locks, leak, smoke and CO sensors and the guard mode and siren of a HomeBase show up on the Sensors page to adopt
- **Camera controls.** Spotlight with brightness, siren, pan and tilt with presets, turning the camera on or off and the guard mode of cameras without a HomeBase appear as controls where the camera supports them
- **More detections.** Unknown people, pets, sounds and crying come in as detections next to motion, people and vehicles
- **Live view.** A new viewer starts from the last keyframe, and two cameras behind one HomeBase can stream at the same time
- **Snapshots from the last event.** The picture of the latest Eufy notification is used without waking a battery camera, a fresh picture is taken only when asked for
- The stream mode is set per camera: P2P for every camera, RTSP where the camera or HomeBase offers it. Home name, device name and the local only option are gone

## [1.2.4]

- Updated camera.ui engine

## [1.2.3]

- Updated camera.ui engine and deps

## [1.2.1]

- Updated camera.ui engine

## [1.2.0]

- The live stream duration field steps in 10s increments
- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.5]

- Cleanup

## [1.1.4]

- Bump camera.ui engine and SDK

## [1.1.3]

- Bugfixes and improvements

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