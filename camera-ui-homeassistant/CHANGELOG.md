## [1.0.3]

- **Fixed an import loop with the camera.ui MQTT bridge.** Sensors camera.ui exported to Home Assistant could be imported right back, creating endless duplicates. New entities are now only picked up by a guarded sync that knows camera.ui's own exports, never straight from the live stream, and when that check cannot run, imports pause instead of running unguarded.
- Bugfixes

## [1.0.2]

- **Home Assistant notify services deliver camera.ui notifications.** Under Settings > Notifications the plugin now offers every notify service Home Assistant knows (companion app, TTS, Telegram, ...) as a target. Pick a service, and camera.ui alerts arrive on that channel with title, text and picture.

## [1.0.1]

- Minor fixes and improvements

## [1.0.0]

- Initial release
