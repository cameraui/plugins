import { batteryEntity, genericEntity } from './generic.js';
import { DOORBELL } from './helpers.js';
import { hikvision } from './hikvision.js';
import { imou } from './imou.js';
import { matter } from './matter.js';
import { nest } from './nest.js';
import { netatmo } from './netatmo.js';
import { onvif } from './onvif.js';
import { reolink } from './reolink.js';
import { ring } from './ring.js';
import { shelly } from './shelly.js';
import { tuya } from './tuya.js';
import { unifiprotect } from './unifiprotect.js';
import { xthingsCloud } from './xthingsCloud.js';

import type { HaRegistryEntry, HaState } from '../types.js';
import type { CameraEntity, CameraIntegration, Detection, DeviceBusEvents, Ignore, StreamVariant } from './types.js';

const INTEGRATIONS: Readonly<Record<string, CameraIntegration>> = {
  hikvision,
  imou,
  matter,
  nest,
  netatmo,
  onvif,
  reolink,
  ring,
  shelly,
  tuya,
  unifiprotect,
  xthings_cloud: xthingsCloud,
};
const DETECTION_KINDS = new Set<CameraEntity['kind']>(['motion', 'object', 'audio', 'doorbell']);

export function streamVariant(entry: HaRegistryEntry): StreamVariant | Ignore | undefined {
  return integrationFor(entry.platform).stream?.(entry);
}

export function cameraEntity(entry: HaRegistryEntry, state: HaState, doorbellIds: ReadonlySet<string>): CameraEntity | undefined {
  if (doorbellIds.has(entry.entity_id)) return DOORBELL;
  const battery = batteryEntity(entry, state);
  if (battery) return battery;
  if (entry.entity_category) return undefined;
  const own = integrationFor(entry.platform).entity?.(entry, state);
  if (own === 'ignore') return undefined;
  return own ?? genericEntity(entry, state);
}

export function entityDetection(entry: HaRegistryEntry, state: HaState, doorbellIds: ReadonlySet<string>): Detection | undefined {
  const entity = cameraEntity(entry, state, doorbellIds);
  return entity && isDetection(entity) ? entity : undefined;
}

export function entityLens(entry: HaRegistryEntry, lenses: ReadonlySet<string>): string {
  return integrationFor(entry.platform).entityLens?.(entry, lenses) ?? '';
}

export function isCloudPlatform(platform: string | undefined): boolean {
  return integrationFor(platform).cloud ?? false;
}

export function snapshotFromStream(platform: string | undefined): boolean {
  return integrationFor(platform).snapshotFromStream ?? false;
}

export function deviceBusEvents(platform: string | undefined): DeviceBusEvents | undefined {
  return integrationFor(platform).busEvents;
}

export function busEventTypes(): string[] {
  return Object.values(INTEGRATIONS).flatMap((integration) => (integration.busEvents ? [integration.busEvents.eventType] : []));
}

function isDetection(entity: CameraEntity): entity is Detection {
  return DETECTION_KINDS.has(entity.kind);
}

function integrationFor(platform: string | undefined): CameraIntegration {
  return INTEGRATIONS[platform ?? ''] ?? {};
}
