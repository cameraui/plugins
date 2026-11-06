# Home Assistant

Imports Home Assistant cameras and devices into camera.ui. Cameras that other integrations add to Home Assistant stream through it into camera.ui. Motion, occupancy, contact, doorbell, smoke, leak, gas, CO and other supported entities become camera.ui sensors that you can assign to cameras, use as detection triggers, or watch on the dashboard. Locks, garage doors, alarm panels, switches, lights and sirens come in as controls: switching them in camera.ui switches them in Home Assistant. Home Assistant notify services (companion app, TTS, Telegram, ...) can be added as notification targets under Settings > Notifications, so camera.ui alerts reach every channel Home Assistant knows.

## Setup

Create a long-lived access token in Home Assistant (Profile > Security) and enter it together with your Home Assistant URL in the plugin settings. When camera.ui runs as the Home Assistant add-on, no configuration is needed, the plugin connects through the supervisor automatically.

## What gets imported

Every entity with a supported device class is offered under Discovered in the Sensors view, nothing comes over until you adopt it. Unsupported device classes are skipped. Entities that camera.ui itself exports to Home Assistant are never offered. An entity you don't want can be hidden from the list there.

Sensors that belong to a camera come in as what they detect, a person sensor as object detection for example. Binary sensors with the device class `sound` come in as audio sensors. Home Assistant has no doorbell class for binary sensors, so a doorbell button exposed as one (for example by Tapo Camera Control) goes into the Doorbell Entities setting. It is then offered as a doorbell that rings when the sensor turns on.

Imported sensors show up in the Sensors view. Assigning one to a camera makes it a detection trigger for that camera, exactly like a native sensor.

## Cameras

Cameras that other integrations add to Home Assistant are offered under Discovered on the Cameras page, as long as Home Assistant can stream them over WebRTC. The stream comes through Home Assistant, live view, detection and recording run in camera.ui. Cameras that only deliver still images are not offered.

- The streams of one device become the sources of one camera. A stream that is disabled in Home Assistant comes along once you enable it there and adopt the camera again.
- The camera's own entities become sensors of the camera: motion, objects, sounds, doorbell, battery, light and siren. Its other entities, switches for example, stay under Discovered in the Sensors view.
- While Home Assistant restarts, the stream pauses. Cloud cameras end their streams after a few minutes and are not meant for continuous recording.
- If camera.ui has a plugin for the camera's brand, that plugin usually gives more.

### Two-way audio

Talking through Home Assistant works since Home Assistant 2026.11. Officially it needs the preview feature Two-way audio (Settings > System > Labs) and an integration that supports talking to the camera. camera.ui tries it either way and shows the microphone when Home Assistant's answer allows it. If it does not work for a camera, turn it off for the source with Disable two-way audio.
