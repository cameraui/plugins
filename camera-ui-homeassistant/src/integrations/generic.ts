import { DOORBELL, MOTION, domainOf, object, sound } from './helpers.js';

import type { ObjectDetectionLabel } from '@camera.ui/sdk';
import type { HaRegistryEntry, HaState } from '../types.js';
import type { CameraEntity } from './types.js';

const OBJECT_KEYS: Readonly<Record<string, ObjectDetectionLabel>> = { person: 'person', vehicle: 'vehicle', animal: 'animal', pet: 'animal' };
const DOORBELL_KEYS = new Set(['visitor', 'doorbell']);

export function batteryEntity(entry: HaRegistryEntry, state: HaState): CameraEntity | undefined {
  const domain = domainOf(entry);
  const deviceClass = state.attributes.device_class;
  if (domain === 'sensor' && deviceClass === 'battery') return { kind: 'battery', part: 'level' };
  if (domain === 'binary_sensor' && deviceClass === 'battery') return { kind: 'battery', part: 'low' };
  if (domain === 'binary_sensor' && deviceClass === 'battery_charging') return { kind: 'battery', part: 'charging' };
  return undefined;
}

export function genericEntity(entry: HaRegistryEntry, state: HaState): CameraEntity | undefined {
  const domain = domainOf(entry);
  const deviceClass = state.attributes.device_class;

  if (domain === 'light') return { kind: 'light' };
  if (domain === 'siren') return { kind: 'siren' };
  if (domain === 'event' && deviceClass === 'doorbell') return { kind: 'events', types: {}, fallback: DOORBELL };
  if (domain === 'event' && deviceClass === 'motion') return { kind: 'events', types: {}, fallback: MOTION };
  if (domain !== 'binary_sensor') return undefined;

  const key = entry.translation_key ?? '';
  if (DOORBELL_KEYS.has(key)) return DOORBELL;
  if (OBJECT_KEYS[key]) return object(OBJECT_KEYS[key]);
  if (deviceClass === 'motion' || deviceClass === 'moving') return MOTION;
  if (deviceClass === 'sound') return sound('');
  return undefined;
}
