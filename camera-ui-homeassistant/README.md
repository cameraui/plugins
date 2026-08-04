# Home Assistant

Imports Home Assistant devices into camera.ui. Motion, occupancy, contact, doorbell, smoke, leak, gas, CO and other supported entities become camera.ui sensors that you can assign to cameras, use as detection triggers, or watch on the dashboard. Locks, garage doors, alarm panels, switches, lights and sirens come in as controls: switching them in camera.ui switches them in Home Assistant.

## Setup

Create a long-lived access token in Home Assistant (Profile > Security) and enter it together with your Home Assistant URL in the plugin settings. When camera.ui runs as the Home Assistant add-on, no configuration is needed, the plugin connects through the supervisor automatically.

## What gets imported

Every entity with a supported device class is imported automatically. Unsupported device classes are skipped. Entities that camera.ui itself exports to Home Assistant are never re-imported. Use the Excluded Entities setting to keep specific entities out.

Imported sensors show up in the Sensors view. Assigning one to a camera makes it a detection trigger for that camera, exactly like a native sensor.
