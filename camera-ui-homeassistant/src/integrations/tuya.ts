import { DOORBELL, domainOf } from './helpers.js';

import type { CameraIntegration } from './types.js';

export const tuya: CameraIntegration = {
  cloud: true,

  entity(entry) {
    if (domainOf(entry) !== 'event') return undefined;
    // the doorbell uploads its picture when someone rings, the message event carries texts and alarms
    return entry.translation_key === 'doorbell_picture' ? { kind: 'events', types: {}, fallback: DOORBELL } : 'ignore';
  },
};
