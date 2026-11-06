import { DOORBELL, MOTION, domainOf } from './helpers.js';

import type { CameraIntegration } from './types.js';

export const matter: CameraIntegration = {
  entity(entry, state) {
    const domain = domainOf(entry);
    const deviceClass = state.attributes.device_class;
    if (domain === 'binary_sensor' && deviceClass === 'occupancy') return MOTION;
    // a Matter doorbell is a generic switch, a press starts with initial_press
    if (domain === 'event' && deviceClass === 'button') return { kind: 'events', types: { initial_press: DOORBELL } };
    return undefined;
  },
};
