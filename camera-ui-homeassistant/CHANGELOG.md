## [1.0.4]

**Requires camera.ui 2.1.3. If you use the camera.ui integration in Home Assistant, update it as well.**

- **Imported sensors no longer flood Home Assistant with camera.ui devices.** Imports now start unexported and are marked with their origin, so the camera.ui integration and the MQTT bridge never send them back to Home Assistant, even if you export them for other bridges like HomeKit. Existing imports are marked on the next plugin start; reload the camera.ui integration in Home Assistant once to drop the stray devices.

## [1.0.3]

- **Fixed an import loop with the camera.ui MQTT bridge.** Sensors camera.ui exported to Home Assistant could be imported right back, creating endless duplicates. New entities are now only picked up by a guarded sync that knows camera.ui's own exports, never straight from the live stream, and when that check cannot run, imports pause instead of running unguarded.
- Bugfixes

## [1.0.2]

- **Home Assistant notify services deliver camera.ui notifications.** Under Settings > Notifications the plugin now offers every notify service Home Assistant knows (companion app, TTS, Telegram, ...) as a target. Pick a service, and camera.ui alerts arrive on that channel with title, text and picture.

## [1.0.1]

- Minor fixes and improvements

## [1.0.0]

- Initial release
