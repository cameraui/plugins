## [2.0.5]

- **Battery cameras and doorbells are recognized when you add them.** camera.ui then sets up a battery camera so it can sleep. Needs camera.ui 2.3.1.
- The live view freezes less often. A frame lost on the way, or cut between two network packets, stopped the picture until the next full frame arrived
- Cameras behind a HomeBase 3 keep streaming. After a while every new live view failed until the connection was rebuilt
- Cameras behind a HomeBase 2 show the picture of their latest event, and an event that arrives before its picture still gets one
- The siren of a HomeBase 3 can be triggered
- A connection to a camera that went silent is noticed and rebuilt. The live view no longer stays stuck on it
- With debug logging on, every Eufy notification shows up in the log, so a missing detection can be traced

## [2.0.4]

- Detections that come in as Eufy notifications reach their camera. Many of them were dropped because the notification could not be assigned to a device
- Cameras connect more reliably when the direct connection has to pass a router
- The Wall Light Cam S100 no longer cuts its live view about once a minute
- The light of the Floodlight Cam T8423 can be switched
- Bump camera.ui engine and SDK

## [2.0.3]

- The HomeBase T9000 is recognized as a HomeBase. It showed up as a camera before, without guard mode, and the cameras behind it did not find their station

## [2.0.2]

- **Log in again once.** The update brings a fix for a login that eufy's gateway rejected, and the stored session does not carry what that fix needs. A verification code may be asked for. Go to Plugins > Eufy and Log in again.
- Snapshots from an event need a fraction of the memory they used to
- The guard mode of a camera without a HomeBase, like the Indoor Cam Pan & Tilt, can be changed again. The change hung and never reached the camera
- More Eufy smart locks show whether they are locked, and the state follows along when the lock is used
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