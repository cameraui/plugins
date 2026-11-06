import type { ObjectDetectionLabel } from '@camera.ui/sdk';
import type { HaRegistryEntry } from '../types.js';
import type { Detection } from './types.js';

export const MOTION: Detection = { kind: 'motion' };
export const DOORBELL: Detection = { kind: 'doorbell' };

export function object(label: ObjectDetectionLabel): Detection {
  return { kind: 'object', label };
}

export function sound(name: string): Detection {
  return { kind: 'audio', sound: name };
}

export function domainOf(entry: HaRegistryEntry): string {
  return entry.entity_id.split('.')[0];
}
