## [1.0.13]

- **Tapping a notification opens the event.** The Home Assistant app jumps to the camera.ui panel, straight to the camera's timeline at the moment of the detection. Needs the Home Assistant integration with the sidebar panel; without it the tap keeps opening just the app.

## [1.0.12]

**Needs camera.ui 2.1.13.**

- **Adopted entities stay adopted, across restarts of the plugin and of camera.ui.** camera.ui keeps the list now, the plugin cannot lose it anymore.
- **Renaming an entity in Home Assistant keeps the sensor**, with its camera assignments, automations and history.
- **Entities you delete in Home Assistant are marked as removed in camera.ui.** They stay, with everything assigned to them, until you delete them on the sensors page too.
- **Notification pictures show up on the phone.** Without remote access the picture URL only worked inside the LAN, so Home Assistant notifications usually arrived without an image. Pictures now load through Home Assistant itself. Needs the Home Assistant integration 0.4.0.
- **One push per phone.** The plugin offered Home Assistant's catch-all notify service, the phone's own service and the phone's notify entity as three separate targets, so a notification arrived up to three times. Only real device targets are listed now. Follow-up pushes of the same event replace the notification instead of stacking, and silent updates stay silent.
- Once after this update: entities adopted with 1.0.11 show up as discovered again and their old entries are marked as removed. Delete the old entries and adopt the entities once more.

## [1.0.11]

- Entities are imported by choice now. Instead of importing every entity it can map, the plugin lists them in the Discovered section of the sensors page, with name, type and room; you pick what comes over, and removing a sensor there stops its import for good. This also applies to entities imported by earlier versions: after the update they all show up as discovered again, so pick the ones you actually use; their old entries clean themselves up, so a re-added entity starts fresh, without earlier camera assignments. Needs camera.ui 2.1.11.

## [1.0.10]

- Updated camera.ui engine and deps

## [1.0.8]

- The "entities imported" sync log only appears at startup and when entities were actually added or removed, instead of repeating every few minutes.
- Updated camera.ui engine

## [1.0.7]

- **Fixed the connection inside the Home Assistant add-on.** The add-on was missing the Home Assistant API permission, so the automatic connection was always rejected with "rejected the access token". Update the camera.ui add-on to 0.1.7 and the connection works without any configuration again.
- **A manually entered URL and token now win over the add-on connection.** Before, the automatic add-on path always took priority, so entering your own credentials had no effect.
- Fix camera.ui engine

## [1.0.6]

- **Notify entities work as delivery targets.** Entity-based notify services now show up under Settings > Notifications and are called through notify.send_message. The bare send_message service no longer appears as a target, sending to it always failed with a 400 error. These targets carry title and text only, Home Assistant does not accept a picture there.

## [1.0.5]

**Requires camera.ui 2.1.3. If you use the camera.ui integration in Home Assistant, update it as well.**

- **Imported sensors no longer flood Home Assistant with camera.ui devices.** Imports now start unexported and are marked with their origin, so the camera.ui integration and the MQTT bridge never send them back to Home Assistant, even if you export them for other bridges like HomeKit. Existing imports are marked on the next plugin start; reload the camera.ui integration in Home Assistant once to drop the stray devices.

## [1.0.4]

- **Fixed an import loop with the camera.ui MQTT bridge.** Sensors camera.ui exported to Home Assistant could be imported right back, creating endless duplicates. New entities are now only picked up by a guarded sync that knows camera.ui's own exports, never straight from the live stream, and when that check cannot run, imports pause instead of running unguarded.

## [1.0.3]

- Bugfixes

## [1.0.2]

- **Home Assistant notify services deliver camera.ui notifications.** Under Settings > Notifications the plugin now offers every notify service Home Assistant knows (companion app, TTS, Telegram, ...) as a target. Pick a service, and camera.ui alerts arrive on that channel with title, text and picture.

## [1.0.1]

- Minor fixes and improvements

## [1.0.0]

- Initial release
