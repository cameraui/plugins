## [1.1.9]

- Less log noise

## [1.1.8]

- Fixed cameras becoming unresponsive after the connection dropped mid-session: a failed event poll ("other side closed", "HTTP error! status: 400") retried without pause, flooding the camera until it stopped answering ONVIF requests entirely, including discovery and PTZ. Failed polls now back off before retrying, and a broken connection no longer discards a still-valid event subscription
- PTZ status polling no longer piles up requests while the camera is unresponsive; it pauses with increasing delays until the camera answers again
- Less log noise: repeated event errors log once instead of flooding the camera log, with a "recovered" line once polling works again, and the capability dump on connect is now a short summary

## [1.1.7]

- Cleanup

## [1.1.6]

- Remove debug logging

## [1.1.5]

- Sensors now show their details in the sensor settings: event sensors list the camera event topics that feed them, the PTZ sensor shows axes, supported move commands and discovered presets
- Bugfixes and improvements
- Bump camera.ui engine and SDK

## [1.1.4]

- Bump camera.ui engine and SDK

## [1.1.3]

- Device URLs entered without a scheme (`192.168.1.100` or `192.168.1.100:8080`) no longer fail with `Invalid URL`; a genuinely broken stored URL now logs the offending value instead of a bare TypeError

## [1.1.2]

- Fixed motion/detection events never arriving on cameras that report an internal or wrong address for their event subscription — event polling now always uses the configured host and port
- Debug logging for incoming ONVIF events (topic, parsed motion state, dropped events) — enable the camera's debug log level to trace event delivery

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