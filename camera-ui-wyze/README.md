# Wyze

Integrates Wyze cameras into camera.ui, with device discovery, live streaming and motion events.

## Setup

1. Create an API key in the [Wyze developer console](https://developer-api-console.wyze.com/). Wyze explains the steps in [Creating an API Key](https://support.wyze.com/hc/en-us/articles/16129834216731).
2. In the plugin settings, enter the email and password of your Wyze account, the key's ID as API ID and the key itself as API Key, then press Login.

Two-step verification has to be off for the account, the plugin can't enter a code. The cameras are then offered under Discovered on the Cameras page. Log Out disconnects and forgets the login.

## Cameras

Live view runs directly between camera.ui and the camera in your network, each camera gets an HD and an SD stream. Motion events come from your Wyze account.

- The camera needs a firmware with DTLS. Update it in the Wyze app before adding it.
- Cameras on Wyze's Gwell platform don't stream yet: Wyze Cam Pan v4, Wyze Cam OG, OG Telephoto and OG (2025).
