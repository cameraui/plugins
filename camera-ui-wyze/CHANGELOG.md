## [1.2.9]

**Cameras added before 1.2.9 still connect to the address they had when they were added.** Give them a fixed IP address in your router, or remove them and add them again.

- The stream follows the camera's IP address from your Wyze account. Before, a new address from the router broke the stream
- The API fields point to the Wyze developer console
- Log Out disconnects from Wyze and forgets the login
- The README explains the setup, including the API key

## [1.2.8]

- Bump camera.ui engine and SDK

## [1.2.7]

- Bump camera.ui engine and SDK

## [1.2.6]

- Updated camera.ui engine

## [1.2.5]

- Updated camera.ui engine

## [1.2.4]

- Updated camera.ui engine and deps

## [1.2.2]

- Updated camera.ui engine

## [1.2.1]

- Wyze cameras record again. The plugin never reported its cameras as online, so the NVR kept deferring the recording ("Camera not connected") and the frame worker stayed down

## [1.2.0]

- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.4]

- Cleanup

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Await asynchronous storage saves when persisting refreshed tokens and updated configuration (SDK async storage API)
- Update camera.ui SDK
- Bump camera.ui engine to v2.0.5

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