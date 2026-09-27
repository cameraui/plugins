# HomeKit

Exposes camera.ui cameras and sensors to Apple HomeKit. Cameras stream and record via HomeKit Secure Video, sensors appear as accessories in the Home app.


### Battery-powered cameras

Cameras exposing a battery sensor do not keep a continuous HomeKit recording
prebuffer, even when they report charging (doorbell wiring can only trickle-charge
an internal battery). Recording starts when HomeKit requests an event clip, stops
when its consumers finish, and is limited to 60 seconds. Automatic clips are
refused at 20% battery or below, on a low-battery alert, or when the reported level
is unavailable. A 30-second cooldown after failure or release avoids reconnect
storms. Explicit live viewing is unaffected.

Battery recordings have no guaranteed pre-event footage and can start later while
the camera wakes. HomeKit thumbnails reuse the last image while the camera is
idle; a fresh thumbnail is taken only from an already connected stream, at most
once per minute. Before the first live image a placeholder is shown. Other clients,
server-side snapshot settings and independent recording/detection plugins must
also be configured to avoid keeping a battery camera awake.
