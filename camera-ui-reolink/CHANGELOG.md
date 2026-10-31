## [1.3.5]

- **A camera you connect to an NVR or Home Hub later shows up in the camera search.** The plugin checks the NVRs you added on every search, before you had to add the NVR again.

## [1.3.4]

- **Cameras in privacy mode are back as soon as it ends.** The picture returns within a second instead of up to a minute later, and the log no longer reports the stream as stalled while privacy mode is on.

## [1.3.3]

- **Battery cameras on a Home Hub or NVR get their events through the recorder.** The plugin keeps its connection to the recorder open for them, as Home Assistant does, and no longer takes over the recorder's push address, which Home Assistant uses too.
- **Battery cameras reached over their UID can sleep as soon as the plugin is done.** The plugin now tells the camera it leaves, before it stayed awake until it timed out.
- **Smaller fixes.** Cameras on an NVR or Home Hub no longer log a warning about alarms for other channels, and an account device that offers no local login at all is named as such.

## [1.3.2]

- Build with Go 1.27.3, which brings security fixes for certificate checks, TLS and HTTP

## [1.3.1]

- Update camera.ui SDK
- Update dependencies

## [1.3.0]

- **Battery cameras and doorbells are recognized when you add them**, also doorbells on an NVR or Home Hub. camera.ui then sets up a battery camera so it can sleep. Needs camera.ui 2.4.0.
- **A camera that answers late while you add it keeps its features.** Adding it now fails and can be retried, instead of setting it up as mains-powered without siren, spotlight or PTZ.
- **Cameras on an NVR or Home Hub show their own model, serial number and firmware** instead of the recorder's. This applies to cameras you add from now on.
- **Cameras without a speaker no longer offer two-way audio.** The talk button did nothing on them. Cameras you already added are checked the next time they connect, the button goes away with the next stream start.
- **Two-way audio no longer crackles or cuts off the end of a sentence.** A camera that refuses to talk keeps its live view, and the plugin asks it again after a few seconds instead of many times a second.
- **Fewer stream drops.** Models that refuse the event subscription, such as the Elite Floodlight WiFi, no longer reconnect every few seconds. A stream the camera turns down right after connecting is back within seconds instead of five minutes.
- **A camera that goes silent is noticed sooner.** Over its UID it reconnects or shows as offline within a minute instead of after about eight, and a camera that stops answering during login no longer blocks its snapshots and controls.
- **Account devices are named as such.** Adding a camera that is set up as a Reolink account device now says it has to be reset to a local device. A camera whose local login a firmware update locked says to add it again in the Reolink app. Both showed a plain login error before.
- **Battery PTZ cameras are no longer woken every minute.** The plugin read their saved positions each minute. It now reads them when the camera is awake anyway.
- **Sleeping cameras react to the first command.** A battery camera, also one behind a Home Hub, turns down the first command while it wakes up, so the siren, spotlight or PTZ did nothing. The plugin now tries again, and a snapshot gets the time the camera needs to wake.
- **Battery cameras end their motion when they go back to sleep.** Motion could stay on until the next reconnect, and a second press of a battery doorbell could go unreported.
- **No second full-size stream.** If a camera's sub stream is only a copy of its main stream, it is no longer added as a low-resolution source.
- **Smaller fixes.** A camera that refuses the continuous siren sounds it twice instead of staying silent, and the log says when camera.ui takes over a battery camera's push address from another app, such as Home Assistant.
- Bump camera.ui engine and SDK

## [1.2.26]

- Bump camera.ui engine and SDK

## [1.2.25]

- Update SDK

## [1.2.24]

- Update SDK

## [1.2.23]

- A camera added by IP no longer stays on the slow UID connection after a hiccup. If the direct connection failed once, the camera switched to its UID and kept using it for hours, with choppy video and dropped frames. When it reconnects, it now tries the direct connection again, at most every five minutes.

## [1.2.22]

- Updated camera.ui engine

## [1.2.21]

- Changing a camera between H.264 and H.265 no longer crashes the plugin. The stream now renegotiates with the new codec on the fly.

## [1.2.20]

- Minor bugfixes

## [1.2.19]

- Updated camera.ui engine and deps

## [1.2.18]

- Updated camera.ui engine and deps

## [1.2.17]

- Updated camera.ui engine and deps

## [1.2.16]

- Adding a slow-waking battery camera no longer gives up mid-attempt. The adoption allowed exactly as much time as the wake-up needs, so it could abort a moment before the camera answered

## [1.2.15]

- Battery-only cameras can now be added by IP address alone. The UID fallback needed the UID to be known, which it is not when a camera is typed in by hand; the camera is now asked for its UID over the same port the Reolink app uses, and the answer is saved with the camera
- Waking a sleeping camera gets the time it needs. A battery camera answers only after about ten seconds of knocking, and the connection attempt gave up just before that

## [1.2.14]

- Battery-only cameras can be added again. A camera that is asleep keeps no connection port open, so adopting one failed with "connection refused" even though the Reolink app reached it. The plugin now falls back to the camera's UID connection

## [1.2.13]

- Battery cameras and doorbells no longer lose their charge within a day. The plugin kept a connection to the camera open around the clock, which is what stops a battery model from sleeping. It now hands the camera a push address and lets the connection go; motion, doorbell presses and the battery level arrive on their own. Cameras whose firmware cannot push say so in the log and keep the old behavior
- The connection to a battery camera is only dropped once the camera has actually reached camera.ui with a push. If it cannot, the connection stays up and the log says so, so a camera in an odd network setup never ends up silent
- New camera setting "Permanently Powered" for battery models. A doorbell wired to its bell transformer has no reason to sleep, so it keeps a connection like a mains camera and reacts faster. It takes effect right away
- A camera you disabled is now really disabled. Disabling only stopped the recording and streaming side, the plugin stayed logged in to the camera and kept asking it for events. Enabling and disabling takes effect right away

## [1.2.12]

- Updated camera.ui engine and deps

## [1.2.11]

- Update camera.ui SDK

## [1.2.10]

- Bugfixes and improvements

## [1.2.9]

- Motion and AI detections from cameras whose firmware packs the events differently are recognized again. Some models wrap them in a list the plugin did not know, and every detection from those cameras was dropped
- A camera that reports its detections for a different channel than the one it was added as now says so in the log instead of looking like a camera that never detects anything

## [1.2.8]

- PTZ cameras show their saved positions. The presets you set up in the Reolink app appear in the PTZ controls and moving to one is a click; the list is re-read every minute, so renamed or newly added presets show up on their own

- Cameras no longer show up as offline over a shaky network. A busy camera answers the connection check late because its reply waits behind the video, and that was counted as a dead camera. Video arriving on the connection now counts as proof that the camera is there, and a camera gets 30 seconds to come back before it is reported offline
- One stuttering stream no longer drops the whole camera. A stream that goes quiet is restarted on its own, events and the other streams keep running
- A camera that cannot deliver its video in time no longer leaves the live view stuck seconds in the past. The stream skips the old pictures and continues at the next full frame, so the live view stays live. The new camera setting "Catch Up To Live" sets how many seconds the picture may trail before that happens and takes effect right away; skipped seconds are missing from recordings too, so set it to 0 to keep every frame and accept the delay

## [1.2.7]

- Live streams run close to realtime now. Every stream used to be delayed by a fixed buffer before it left the plugin; that buffer is gone and frames are passed on the moment the camera sends them
- A hiccup in the camera's clock no longer causes a frozen picture or a jump; the stream keeps its steady pace and audio stays in sync
- Dual-lens cameras (TrackMix, RLC-81MA) can stream their tele lens. Adopt the camera and the tele lens appears in the discovered list as its own camera, with credentials prefilled

## [1.2.5]

- No more corrupted video frames when the system is briefly overloaded. A lost piece of the camera stream was patched over with the wrong bytes and could show up as decoder errors and picture glitches; the stream now restarts cleanly instead
- When the video queue overflows under load, the picture now pauses briefly and resumes at the next keyframe instead of dropping random frames that left every viewer with a broken image. Audio keeps running through the pause

## [1.2.4]

- The event listener stays up as long as the connection does. It used to be torn down and rebuilt every five minutes, and a detection that landed in that moment was lost

## [1.2.3]

- Cameras on an NVR or Home Hub get their events again. The subscription was sent to the wrong channel, so the camera accepted it and then never reported motion or AI detections
- A camera that stays silent after subscribing now gets asked again every 30 seconds instead of every 5 minutes, and says so in the log if it never answers

## [1.2.2]

- Doorbells report a lingering visitor again. Some models describe the zone without saying what they saw, and those events were dropped instead of counting as motion

## [1.2.1]

- Bump camera.ui SDK

## [1.2.0]

- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.5]

- WiFi cameras no longer go missing when you search for cameras. Some models ignore the search for the first ten seconds, so they showed up only every other try. The plugin now keeps looking in the background, and a search finishes in two seconds instead of ten
- Sound and picture now share one clock. The camera sends its audio without any timing information, and the plugin was starting the audio clock from scratch instead of from the picture, which is why audio and video could not be lined up in recordings
- Two-way audio works again. The camera stayed silent because your voice arrived on a second connection that the plugin threw away; both connections now reach the camera
- The spotlight switch now follows the camera. When the camera turns its own light on, or you switch it in the Reolink app, camera.ui shows it instead of staying on the last state it set itself
- Cameras that listen for a baby crying now get their own audio detection sensor, instead of the sound showing up as if it had been seen in the picture. The sensor appears the first time the camera actually reports one

## [1.1.4]

- New cameras now get "Preload" turned on for every stream and "Hot mode" for the main and sub stream, so the live view opens without the long wait
- Streams are only started when someone actually watches; the connection to the camera stays open for events and snapshots
- Bugfixes and improvements

**Please check your existing cameras.** Cameras added before this update keep their old settings. Open the camera, go to Sources and turn on "Hot mode" and "Preload" for the main and sub stream. On battery cameras leave "Hot mode" off, it would keep the camera awake and drain the battery

## [1.1.3]

- Bugfixes and improvements

## [1.1.2]

- Fix NVR/Hub recognition when adopting: on cameras that negotiate AES encryption the login reply was decoded wrong, so an NVR was treated like a single camera instead of listing its channels
- Detections from both lenses of dual-lens cameras (TrackMix, RLC-81MA) are now recognized
- Zone-based smart detections (crossline, intrusion, linger) now trigger motion and object events; before, cameras set up with only smart zones stayed silent

## [1.1.1]

- Bump camera.ui engine and SDK

## [1.1.0]

- Add NVR/Hub support: adopting an NVR lists every occupied channel as its own camera, with per-channel capability detection (AI, siren, spotlight, PTZ) and shared credentials that are prefilled and survive restarts
- Add "Forget NVR" action to the plugin settings for removing a connected NVR and its channel entries
- Fix "bad credentials" when connecting to NVRs (e.g. RLN36): Baichuan commands now use the correct header channel semantics (host 250, channels 1-based) like the official clients
- Fix encryption negotiation: honor the mode the firmware negotiates (full-AES, BC, none) instead of always switching to AES after login
- Discovery now only lists devices the current scan actually sees; NVR channels are listed while their NVR is present, manually added devices are exempt

## [1.0.3]

- Cleanup

## [1.0.2]

- Bump camera.ui SDK

## [1.0.1]

- Bump camera.ui engine and SDK

## [1.0.0]

- Initial Release
