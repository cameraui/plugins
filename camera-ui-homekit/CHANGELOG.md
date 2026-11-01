## [1.3.6]

- Update deps

## [1.3.5]

- **Transcoded live view on the classic path no longer blocks up or freezes.** Cameras that Home cannot play as they are, MJPEG or H.265 on the classic path, got the bitrate the Home app asks for, at best 300 kbit/s for 720p. Now the bitrate follows the picture size and frame rate, and the picture keeps the camera's aspect ratio. A lost packet froze the picture for up to 8 s. Now Home gets a new keyframe as soon as it reports the loss, and every 2 s anyway.
- **Remote live view on the classic path starts on the small stream.** The Home app starts remote view with a small picture and asks for more once the connection holds. Cameras with a source in low or mid resolution now send that one first, transcoded to H.264 in the camera's aspect ratio when needed, and move to the main stream without a break. A slow connection no longer gets the full stream from the start.
- **Remote live view on the Secure Video path keeps the camera's aspect ratio.** When the small stream came from a source with a different shape, a 4:3 substream next to a 16:9 main stream say, the Home app kept that shape after switching to the main stream. The small stream now takes the aspect ratio set in the camera's interface settings.
- **New switches under Advanced, all off by default.** **Always transcode** transcodes live view even when Home could play the camera's stream as it is. **Stream as requested** sends live view in the size, frame rate and bitrate Home asks for. **Always transcode for HKSV** does the same for recordings, as H.264 in the format Home asks for.

## [1.3.4]

- **Battery cameras can sleep.** HomeKit Secure Video only keeps a camera connected for the seconds before an event when hot mode is on for its main stream. Without hot mode, as plugins set it for battery cameras, a recording opens the stream when the event starts.
- **The picture in Home follows the camera's snapshot setting.** It used to fetch a new one on every request, which woke battery cameras. While an event runs or the doorbell rings, it still fetches a fresh one.
- **Pairings move with the plugin.** They are kept in the plugin settings on the main server instead of files on the machine the plugin runs on, so cameras and the bridge stay paired when the plugin moves to a worker or back. Existing pairings are taken over on the first start.
- **Every bridge has its own identity.** Two camera.ui servers in the same network showed up in Home as the same bridge. A bridge that is not paired yet gets an identity of its own on the first start, paired bridges keep theirs.
- **A copy of the server gets new pairings.** After a backup is restored as a copy, the bridge and the cameras get new pairing codes there, so they no longer answer for the original. Add them to Home again on the copy. A move keeps the pairings.
- **The pairing code in the settings works.** A camera or bridge that had no saved code showed a different one on every start, and the code in the settings did not match the one Home expected. Scanning the QR code worked, typing the code did not.
- **HomeKit Secure Video records again after the camera stream got stuck.** The plugin restarts a recording stream that sends nothing for about 25 seconds.
- **Remote live view works over mobile data.** On iOS 27 the Home app stopped the stream right after it started when the iPhone was on 5G or LTE, only Wi-Fi worked. Cameras with a low or mid resolution source also send a small stream from it for slow connections, transcoded only when that source is not HEVC. The new setting **Allow transcoding for mobile data** under **Secure Video**, next to **Force legacy path**, turns the transcoding off.
- **MJPEG cameras work in Home.** Cameras that send neither H.264 nor H.265 were treated as H.265 and only worked on iOS 27. They now get an H.264 stream, transcoded on the server.
- Bump camera.ui engine and SDK

## [1.3.3]

- Bump camera.ui engine and SDK

## [1.3.2]

- **Remote live view stays clean.** Encrypted video packets could end up larger than the size the Home app asked for, so the picture got more and more corrupted when watching away from home.
- The bridge no longer reports "No server addresses are set" when an address is set but missing on this machine. The warning above it names the ignored address and the addresses the plugin does find.

## [1.3.1]

- **A camera that changes its encoder is picked up again.** Switching a camera's main stream from H.264 to H.265 while camera.ui was running left HomeKit recording an H.265 stream labelled as H.264, which Apple dropped after three fragments. The accessory now follows the change.
- **Clean audio in local live view on iOS 27.** HEVC cameras on the Secure Video path could sound distorted when watched at home. Audio now uses the sample rate Apple expects there, remote view was not affected.

## [1.3.0]

- **HomeKit Secure Video for iOS 27.** Cameras with an HEVC main stream use Apple's new secure video services: local and remote live view, recording and two-way audio run on the camera's native HEVC stream without transcoding, so 4K cameras no longer cost a CPU core each. Needs iOS 27 / tvOS 27 on the viewer and the home hub. Remote view is HEVC only on Apple's side, H.264 cameras stay on the classic path.
- **Force legacy path.** A per-camera switch in the advanced settings keeps a camera on the classic HomeKit services, for homes that stay on iOS 26 or older.
- A failed publish no longer drops the camera's pairing. Before, a startup error during publishing removed the accessory including its pairing, so the camera had to be added to Home again.

## [1.2.11]

- Updated camera.ui engine

## [1.2.10]

- Bugfixes and improvements

## [1.2.9]

- Bugfixes and improvements

## [1.2.8]

- When a stream ends, one line reports what the Apple device measured: packet loss, jitter, round trip time and keyframe requests. If no reports arrived, the line says so.
- Minor bugfixes and improvements

## [1.2.7]

- Updated camera.ui engine and deps

## [1.2.5]

- Updated camera.ui engine

## [1.2.4]

- A stale network address no longer kills the bridge. When camera.ui is bound to an address the machine does not have anymore (changed IP, old config), the bridge and camera accessories now skip that address with a warning and publish on the remaining ones, instead of failing to start.

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