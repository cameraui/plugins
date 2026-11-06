import { MOTION, domainOf, object, sound } from './helpers.js';

import type { CameraIntegration, Detection, StreamVariant } from './types.js';

// unique_id ends in the RTSPS channel, 3 is the package lens of the G4 Doorbell Pro
const CHANNELS: Readonly<Record<string, StreamVariant>> = {
  0: { lens: '', name: 'High', role: 'high-resolution' },
  1: { lens: '', name: 'Medium', role: 'mid-resolution' },
  2: { lens: '', name: 'Low', role: 'low-resolution' },
  3: { lens: 'package', name: 'Package', role: 'high-resolution' },
};
const DETECTIONS: Readonly<Record<string, Detection>> = {
  person_detected: object('person'),
  vehicle_detected: object('vehicle'),
  animal_detected: object('animal'),
  smoke_alarm_detected: sound('smoke_alarm'),
  co_alarm_detected: sound('alarm'),
  siren_detected: sound('siren'),
  baby_cry_detected: sound('baby_cry'),
  speaking_detected: sound('speaking'),
  barking_detected: sound('dog_bark'),
  car_alarm_detected: sound('car_alarm'),
  car_horn_detected: sound('car_horn'),
  glass_break_detected: sound('glass_break'),
};

export const unifiprotect: CameraIntegration = {
  stream(entry) {
    const channel = /_(\d)$/.exec(entry.unique_id ?? '')?.[1];
    return channel ? CHANNELS[channel] : undefined;
  },

  entity(entry, state) {
    const domain = domainOf(entry);
    // the binary sensors cover motion, objects and sounds, the events repeat them
    if (domain === 'event') return state.attributes.device_class === 'doorbell' ? undefined : 'ignore';
    if (domain !== 'binary_sensor') return undefined;
    const key = entry.translation_key;
    if (key) return DETECTIONS[key] ?? 'ignore';
    return state.attributes.device_class === 'motion' ? MOTION : 'ignore';
  },
};
