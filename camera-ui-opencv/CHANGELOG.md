## [1.1.4]

- **The Threshold slider for the Background Substraction detector now works.** It never had any effect before, apart from the maximum position, which silently switched motion detection off completely. If you had it at maximum, detection starts working again. The slider resets to a value that matches the previous detection behaviour.
- **The Dilation setting on the Default detector now works.** It never had any effect before. It resets to a value that matches the previous detection behaviour, so nothing changes until you move it.
- **The Learning Rate setting now applies to the motion test panel and to motion automation nodes.** Both ignored it and ran a fixed value. Background Substraction results there will shift, and now match what the camera does live.

## [1.1.3]

- Bump camera.ui engine and SDK

## [1.1.2]

- Bugfixes and improvements

## [1.1.1]

- Run frame-difference, background-subtraction, and default motion detection off the event loop via the thread pool executor, keeping the async pipeline responsive
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