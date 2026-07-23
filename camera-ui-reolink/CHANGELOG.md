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
