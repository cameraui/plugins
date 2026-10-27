## [2.1.1]

- **Some cameras without a HomeBase show a live view again**, among them the Wired Doorbell 2K and the Floodlight Cam 2. They accepted the live view and never sent a picture.
- **Some HomeBases and cameras connect reliably after a restart again.** Their connection failed on most restarts.
- **Cameras connect when no direct connection gets through**, for example with camera.ui in Docker on the default bridge network. The plugin then goes through Eufy's relay servers, like the Eufy app.
- **A live view that joins a running stream starts at its next full frame** instead of a broken picture.
- **More cameras behind a recorder (T8N00) show a live view with sound**: the PoE Cam E41, eufyCam S3 Pro, Indoor Cam Pan & Tilt and Video Doorbell E340, on a 64-bit system. The PoE Cam E41 no longer shows a battery it does not have.
- **The Video Doorbell C30 shows a live view**, without sound and on a 64-bit system.
- **More devices work as in the Eufy app.** The spotlight of a Wall Light Cam S4 can be switched, an older Smart Lock Touch & Wi-Fi (T8520) locks and unlocks, and a Floodlight Cam T8423 no longer ignores guard mode changes.
- **Less memory and disk use on installs that run for a long time.** The plugin kept an ID for every Eufy notification it ever received and saved the whole list after each new one.

## [2.1.0]

- **Battery cameras and doorbells are recognized when you add them.** camera.ui then sets up a battery camera so it can sleep. Needs camera.ui 2.4.0.
- **The live view freezes less often.** Frames that arrive late, in a burst or cut between two network packets no longer stop the picture until the next full frame. After a frame is lost for good, the picture holds until the next full frame instead of showing grey smears.
- **A camera that went silent is noticed and reconnected**, so the live view no longer stays stuck on it. A camera on a power supply that accepts a live view but sends no picture gets a new connection after a few seconds instead of 20.
- **Closing the live view of a camera without a HomeBase stops its stream.** The camera kept streaming, and a light that follows the stream stayed on.
- **Cameras behind a HomeBase 3 keep streaming.** After a while every new live view failed until the connection was rebuilt.
- **Detections and doorbell presses come in more reliably.** The plugin signs up for Eufy notifications the way the Eufy app does. When that fails at startup it tries again, until now nothing came in until a restart. With debug logging on, every Eufy notification shows up in the log.
- **Cameras behind a HomeBase 2 show the picture of their latest event**, also when the event arrives before its picture. Some pictures that stayed empty show up now too.
- **Cameras behind a HomeBase S1 Pro (T9000) show a live view**, one camera at a time and without sound, on a 64-bit system. The siren of more cameras behind it can be triggered, among them the SoloCam S220 and L20, eufyCam 2C, Video Doorbell Dual and Indoor Cam. These cameras no longer offer RTSP, which never worked there.
- **The Video Doorbell C31 shows a live view**, without sound and on a 64-bit system.
- **PoE cameras behind their recorder show a live view with sound**, among them the PoE S4 and E40, on a 64-bit system.
- **More devices work as in the Eufy app.** The siren of a HomeBase 3 can be triggered, the PoE S4 behind its recorder shows up as a camera, and a Video Doorbell Dual behind a HomeBase shows the split picture instead of a small inset. The Baby Monitor E21 can pan and tilt, and the spotlight of an eufyCam E330 Pro can be switched.
- **More doorbells ring in camera.ui**, also when their name does not say doorbell. Among them the Video Doorbell T8210C and Video Doorbell Dual T8213, the Wired Doorbell, Wired Doorbell 2K Pro and Wired Doorbell Dual, and the Battery Doorbell, Battery Doorbell Slim and Battery Doorbell 2E.
- **An Indoor Cam Pan & Tilt behind a HomeBase can be turned on and off**, and its switch shows the right state. Before, "on" could turn it off. An Indoor Cam S350 behind a HomeBase can be turned on and off too.
- **The plugin stays logged in to Eufy when it moves to a worker and back**, instead of asking for a new verification code.
- **Some cameras no longer log the same warning about their motion sensitivity or AI detection every ten minutes.**
- **Stopping an alarm in the Eufy app ends it in camera.ui right away.** The guard mode kept showing the alarm for up to 15 minutes.
- **No new verification code every 30 minutes.** When Eufy asked for a verification code, the plugin tried to log in again every 30 minutes, and Eufy sent a new code each time.
- **The SoloCam S220 no longer shows pan and tilt controls** it does not have.
- **The Smoke Alarm E10 shows up as a smoke sensor** instead of a camera.
- **The guard mode of an Indoor Cam T8410C can be changed.** Every change failed before.
- **Changing the country in the plugin settings logs in again.** The plugin kept the session of the old country, a verification code may be asked for.
- **The Video Smart Lock S330 behind a HomeBase 3 locks and unlocks.** It refused every command before. When the lock does not turn, camera.ui shows its real state again after a few seconds.
- Bump camera.ui engine and SDK

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