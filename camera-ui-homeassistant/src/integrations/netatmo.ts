import { MOTION, object } from './helpers.js';

import type { CameraIntegration } from './types.js';

// Netatmo, Legrand and BTicino cameras report detections only as netatmo_event on the HA bus
export const netatmo: CameraIntegration = {
  busEvents: {
    eventType: 'netatmo_event',
    types: {
      human: object('person'),
      person: object('person'),
      animal: object('animal'),
      vehicle: object('vehicle'),
      movement: MOTION,
      outdoor: MOTION,
    },
  },
};
