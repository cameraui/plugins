import { MOTION, domainOf, object } from './helpers.js';

import type { CameraIntegration } from './types.js';

const EVENT_TYPES = { human: object('person'), vehicle: object('vehicle'), pet: object('animal') };

export const hikvision: CameraIntegration = {
  entity(entry, state) {
    const domain = domainOf(entry);
    if (domain === 'event') return { kind: 'events', types: EVENT_TYPES, fallback: MOTION };
    if (domain !== 'binary_sensor') return undefined;
    // line crossing, field and face detection carry device class motion too, the plain sensor has no key
    return !entry.translation_key && state.attributes.device_class === 'motion' ? MOTION : 'ignore';
  },
};
