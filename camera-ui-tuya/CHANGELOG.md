## [1.2.9]

**Needs camera.ui 2.4.10.**

- Live view works again. Since camera.ui 2.2.5 the stream failed with a wrong password error
- Live view starts up to a second sooner, and the cameras of one account share one login
- A camera that misses the first connection attempt, like a battery camera that is still waking up, gets asked again instead of the live view hanging
- A camera that already streams to as many viewers as it allows is left alone for a while, so its running streams no longer freeze with every new attempt
- HD shows the main stream also on cameras that don't list their streams. Before, they got SD
- Cameras that stream H.265 bring their microphone audio along, at the right speed
- The region East Europe is now called Western Europe, like on the Tuya Developer Platform. A saved choice carries over
- Accounts in Tuya's Singapore data center can sign in, the region list now has Singapore
- Cameras stream when the password contains characters such as & or #
- The email field says which account works there
- The README explains both ways to sign in, step by step
- Save only keeps the settings, Log In connects. Before, every saved field started a new login

## [1.2.8]

- Cameras in Tuya's `cdsxj` category, such as the Konnek Stein QC21SE, show up for adoption

## [1.2.7]

- Bump camera.ui engine and SDK

## [1.2.6]

- Bump camera.ui engine and SDK

## [1.2.5]

- Updated camera.ui engine

## [1.2.4]

- Updated camera.ui engine

## [1.2.3]

- Updated camera.ui engine and deps

## [1.2.1]

- Updated camera.ui engine

## [1.2.0]

- Bump camera.ui SDK, requires camera.ui 2.0.23 or newer

## [1.1.3]

- Cleanup

## [1.1.2]

- Bump camera.ui engine and SDK

## [1.1.1]

- Bugfixes and improvements

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