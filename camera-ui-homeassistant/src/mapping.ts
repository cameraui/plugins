import { SENSOR_META, SensorDomain, SensorType } from '@camera.ui/sdk';

import type { SensorMeta } from '@camera.ui/sdk';
import type { HaState } from './types.js';

// HA device_classes that mean the same thing as one of our catalog classes
const DEVICE_CLASS_ALIASES: Record<string, string> = {
  door: 'opening',
  window: 'opening',
  garage_door: 'opening',
  presence: 'occupancy',
  safety: 'problem',
};

// battery becomes a capability of the owning sensor, never a standalone import
const SKIPPED_DEVICE_CLASSES = new Set(['battery']);

export type EntityMapping = { kind: 'binary'; meta: SensorMeta } | { kind: 'measurement'; meta: SensorMeta } | { kind: 'motion' } | { kind: 'doorbell' };

const binaryMetas = new Map<string, SensorMeta>();
const measurementMetas = new Map<string, SensorMeta>();

for (const meta of SENSOR_META as readonly SensorMeta[]) {
  const semantics = meta.semantics;
  if (!semantics?.deviceClass || meta.type === SensorType.Battery) continue;
  if (semantics.domain === SensorDomain.Binary && meta.properties[semantics.stateProperty]?.type === 'boolean') {
    binaryMetas.set(semantics.deviceClass, meta);
  }
  if (semantics.domain === SensorDomain.Measurement && meta.properties[semantics.stateProperty]?.type === 'number') {
    measurementMetas.set(semantics.deviceClass, meta);
  }
}

export function mapEntity(state: HaState): EntityMapping | undefined {
  const domain = state.entity_id.split('.')[0];
  const rawClass = state.attributes.device_class ?? '';
  const deviceClass = DEVICE_CLASS_ALIASES[rawClass] ?? rawClass;

  if (SKIPPED_DEVICE_CLASSES.has(deviceClass)) return undefined;

  if (domain === 'binary_sensor') {
    // motion is a detection type without catalog semantics, mapped explicitly
    if (deviceClass === 'motion' || deviceClass === 'moving') return { kind: 'motion' };
    const meta = binaryMetas.get(deviceClass);
    return meta ? { kind: 'binary', meta } : undefined;
  }

  if (domain === 'sensor') {
    if (state.attributes.state_class !== 'measurement') return undefined;
    const meta = measurementMetas.get(deviceClass);
    return meta ? { kind: 'measurement', meta } : undefined;
  }

  if (domain === 'event' && deviceClass === 'doorbell') {
    return { kind: 'doorbell' };
  }

  return undefined;
}

export function entityDisplayName(state: HaState): string {
  const name = state.attributes.friendly_name?.trim();
  return name?.length ? name : state.entity_id;
}
