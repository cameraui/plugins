# Home Assistant

Imports Home Assistant devices into camera.ui. Motion, occupancy, contact, doorbell, smoke, leak, gas, CO and other supported entities become camera.ui sensors that you can assign to cameras, use as detection triggers, or watch on the dashboard. Locks, garage doors, alarm panels, switches, lights and sirens come in as controls: switching them in camera.ui switches them in Home Assistant. Home Assistant notify services (companion app, TTS, Telegram, ...) can be added as notification targets under Settings > Notifications, so camera.ui alerts reach every channel Home Assistant knows.

## Setup

Create a long-lived access token in Home Assistant (Profile > Security) and enter it together with your Home Assistant URL in the plugin settings. When camera.ui runs as the Home Assistant add-on, no configuration is needed, the plugin connects through the supervisor automatically.

## What gets imported

Every entity with a supported device class is offered under Discovered in the Sensors view, nothing comes over until you adopt it. Unsupported device classes are skipped. Entities that camera.ui itself exports to Home Assistant are never offered. An entity you don't want can be hidden from the list there.

Binary sensors with the device class `sound` come in as audio sensors. Home Assistant has no doorbell class for binary sensors, so a doorbell button exposed as one (for example by Tapo Camera Control) goes into the Doorbell Entities setting. It is then offered as a doorbell that rings when the sensor turns on.

Imported sensors show up in the Sensors view. Assigning one to a camera makes it a detection trigger for that camera, exactly like a native sensor.
