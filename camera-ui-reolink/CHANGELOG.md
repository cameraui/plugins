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
