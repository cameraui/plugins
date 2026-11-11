# Tuya

Integrates Tuya / Smart Life cameras into camera.ui, with device discovery and live streaming through the Tuya platform.

## Setup

The plugin signs in to Tuya in one of two ways. Fill in one of them, choose the region of your account and press Login. The cameras are then offered under Discovered on the Cameras page. With both filled in, the plugin offers the cameras of both.

### Tuya Smart account

Enter the email and password of an account from the Tuya Smart app. Accounts from the Smart Life app don't work this way: use a cloud project instead, or remove the cameras from Smart Life and add them again in Tuya Smart.

### Tuya cloud project

This works with Tuya Smart and Smart Life accounts, but needs a free project on the [Tuya Developer Platform](https://iot.tuya.com/). [This guide](https://xzetsubou.github.io/hass-localtuya/cloud_api/) shows the steps with screenshots.

1. Create a cloud project with the development method Smart Home and the data center of the country your app account belongs to.
2. Under Devices > Link Tuya App Account, add your app account by scanning the QR code with the app (Me tab).
3. Under Service API, subscribe to IoT Video Live Stream and authorize it for the project. Without it there is no stream.
4. In the plugin, enter the project's Access ID as Client ID, its Access Secret as Client Secret and the UID from Link Tuya App Account as User ID. The region is the project's data center.

The free trial of the IoT Core service runs out after a while, the login then fails. Extend it under Cloud > Cloud Services > IoT Core > My Subscriptions.
