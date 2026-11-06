import { MOTION, domainOf, object, sound } from './helpers.js';

import type { CameraIntegration } from './types.js';

const MOTION_EVENTS = { camera_motion: MOTION, camera_person: object('person'), camera_sound: sound('') };

export const nest: CameraIntegration = {
  cloud: true,
  // HA answers camera_proxy of a WebRTC camera with a placeholder picture
  snapshotFromStream: true,

  entity(entry) {
    if (domainOf(entry) === 'event' && entry.translation_key === 'motion') return { kind: 'events', types: MOTION_EVENTS };
    return undefined;
  },
};
