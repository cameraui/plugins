# Home Assistant

Imports Home Assistant devices into camera.ui. Motion, occupancy, contact, doorbell, smoke, leak, gas, CO and other supported entities become camera.ui sensors that you can assign to cameras, use as detection triggers, or watch on the dashboard. Locks, garage doors, alarm panels, switches, lights and sirens come in as controls: switching them in camera.ui switches them in Home Assistant. Home Assistant notify services (companion app, TTS, Telegram, ...) can be added as notification targets under Settings > Notifications, so camera.ui alerts reach every channel Home Assistant knows.

## Setup

Create a long-lived access token in Home Assistant (Profile > Security) and enter it together with your Home Assistant URL in the plugin settings. When camera.ui runs as the Home Assistant add-on, no configuration is needed, the plugin connects through the supervisor automatically.

## What gets imported

Entities with a supported device class are offered for adoption in the Sensors view. Unsupported device classes are skipped. Entities that camera.ui itself exports to Home Assistant are never re-imported.

Use **Included Entities** to offer only specific entities, for example `binary_sensor.hallway_motion`. Enter multiple entity IDs separated by commas. Leave it empty to offer all supported entities. IDs must match exactly; wildcards are not supported.

Use **Excluded Entities** to keep specific entities out. Exclusions take priority if an entity appears in both lists. Changes apply on the next discovery; neither list removes or disables already adopted sensors or filters notification targets.

Imported sensors show up in the Sensors view. Assigning one to a camera makes it a detection trigger for that camera, exactly like a native sensor.

## Sound sensors and binary doorbells

Home Assistant `binary_sensor` entities with device class `sound` are offered as audio sensors. For a binary sensor that represents a physical doorbell button (for example one supplied by Tapo Camera Control), add its exact entity ID to **Doorbell Entities** to offer it as a doorbell instead. Inclusion and exclusion filters still apply. This setting only changes the type offered during discovery; remove and re-adopt an already adopted sensor to change its type.

Binary doorbells ring only on a live `off` to `on` transition. Initial state, synchronization, repeated `on` updates, releasing the button, and recovery from an unknown or unavailable state do not ring. Existing `event` doorbells remain supported.
