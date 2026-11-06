import type { CameraRole, ObjectDetectionLabel } from '@camera.ui/sdk';
import type { BatteryPart } from '../cameraSensors.js';
import type { HaRegistryEntry, HaState } from '../types.js';

export interface StreamVariant {
  lens: string;
  name: string;
  role: CameraRole;
}

export type Detection = { kind: 'motion' } | { kind: 'object'; label: ObjectDetectionLabel } | { kind: 'audio'; sound: string } | { kind: 'doorbell' };

export interface EventDetections {
  kind: 'events';
  types: Readonly<Record<string, Detection>>;
  fallback?: Detection;
}

export type CameraEntity = Detection | EventDetections | { kind: 'light' } | { kind: 'siren' } | { kind: 'battery'; part: BatteryPart };

export interface DeviceBusEvents {
  eventType: string;
  types: Readonly<Record<string, Detection>>;
}

export type Ignore = 'ignore';

export interface CameraIntegration {
  cloud?: boolean;
  snapshotFromStream?: boolean;
  busEvents?: DeviceBusEvents;
  stream?(entry: HaRegistryEntry): StreamVariant | Ignore | undefined;
  entity?(entry: HaRegistryEntry, state: HaState): CameraEntity | Ignore | undefined;
  entityLens?(entry: HaRegistryEntry, lenses: ReadonlySet<string>): string;
}
