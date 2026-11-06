import { DoorbellTrigger } from '@camera.ui/sdk';

import { HaAudioSensor, HaBatteryInfo, HaMotionSensor, HaObjectSensor } from './cameraSensors.js';
import { applyControlState, commandToService, createControl } from './controls.js';
import { hassStreamSource } from './ha.js';
import { cameraEntity, deviceBusEvents, entityLens, isCloudPlatform, snapshotFromStream, streamVariant } from './integrations/index.js';
import { entityDisplayName } from './mapping.js';
import { importOptions } from './types.js';

import type { CameraConfig, CameraDevice, CameraRole, DiscoveredCamera, LoggerService, Sensor, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { CameraDetector } from './cameraSensors.js';
import type { HaControl } from './controls.js';
import type { HaClient, HaConnectionTarget } from './ha.js';
import type { CameraEntity, Detection } from './integrations/types.js';
import type { HaDevice, HaRegistryEntry, HaState, Registry } from './types.js';

const STREAM_FEATURE = 2;
const DISCOVERY_PREFIX = 'homeassistant:';
const ROLE_ORDER: readonly CameraRole[] = ['high-resolution', 'mid-resolution', 'low-resolution'];

type ControlEntityKind = 'light' | 'siren';

export interface CameraStream {
  entityId: string;
  name: string;
  role: CameraRole;
}

export interface CameraGroup {
  nativeId: string;
  name: string;
  platform?: string;
  device?: HaDevice;
  sensorLens?: string;
  streams: CameraStream[];
}

export interface CameraHost {
  client(): HaClient | undefined;
  target(): HaConnectionTarget | undefined;
  group(nativeId: string): CameraGroup | undefined;
  doorbellIds(): ReadonlySet<string>;
}

type Binding = (state: HaState | null, live: boolean) => void;

class HaCameraImplementations implements StreamingInterface, SnapshotInterface {
  constructor(private readonly camera: HaCamera) {}

  public async streamUrl(sourceId: string): Promise<string> {
    return this.camera.streamUrl(sourceId);
  }

  public async snapshot(sourceId: string): Promise<ArrayBuffer | undefined> {
    return this.camera.snapshot(sourceId);
  }
}

export class HaCamera {
  private readonly logger: LoggerService;
  private readonly controls = new Map<ControlEntityKind, { control: HaControl; entityId?: string }>();
  private motion?: HaMotionSensor;
  private objects?: HaObjectSensor;
  private audio?: HaAudioSensor;
  private doorbell?: DoorbellTrigger;
  private battery?: HaBatteryInfo;
  private bindings = new Map<string, Binding>();

  constructor(
    public readonly cameraDevice: CameraDevice,
    private readonly host: CameraHost,
  ) {
    this.logger = cameraDevice.logger;
  }

  get entityIds(): Iterable<string> {
    return this.bindings.keys();
  }

  public async attach(): Promise<void> {
    await this.cameraDevice.implement(new HaCameraImplementations(this));
  }

  public async refresh(registry: Registry, states: ReadonlyMap<string, HaState>): Promise<void> {
    const group = this.host.group(this.nativeId);
    this.bindings = new Map();
    for (const entry of this.controls.values()) entry.entityId = undefined;

    if (!group) {
      await this.setOnline(false);
      return;
    }

    this.bindings.set(group.streams[0].entityId, (state) => {
      this.setOnline(!!state && state.state !== 'unavailable');
    });

    const entities = deviceEntities(registry, states, group, this.host.doorbellIds());
    await this.createSensors([...entities.values()], detectionKinds(group, [...entities.values()]));
    for (const [entityId, entity] of entities) this.bind(entityId, entity);

    for (const [entityId, apply] of this.bindings) apply(states.get(entityId) ?? null, false);
  }

  public handleState(entityId: string, state: HaState | null): void {
    this.bindings.get(entityId)?.(state, true);
  }

  public handleBusEvent(eventType: string, deviceId: string, type: string): void {
    const group = this.host.group(this.nativeId);
    const events = deviceBusEvents(group?.platform);
    if (group?.sensorLens === undefined || group.device?.id !== deviceId || events?.eventType !== eventType) return;
    const detection = events.types[type];
    if (detection) this.signal(detection, `${eventType}:${type}`, 'pulse');
  }

  public async markUnavailable(): Promise<void> {
    for (const sensor of this.sensors()) sensor.setSourceState('unavailable');
    await this.setOnline(false);
  }

  public async streamUrl(sourceId: string): Promise<string> {
    const target = this.host.target();
    const entityId = this.entityFor(sourceId);
    if (!target || !entityId) throw new Error(`${this.cameraDevice.name} is not available in Home Assistant`);
    return hassStreamSource(target, entityId);
  }

  public async snapshot(sourceId: string): Promise<ArrayBuffer | undefined> {
    const client = this.host.client();
    const entityId = this.entityFor(sourceId);
    if (!client?.connected || !entityId || snapshotFromStream(this.host.group(this.nativeId)?.platform)) return undefined;
    try {
      return await client.fetchSnapshot(entityId);
    } catch (error) {
      this.logger.debug(`No snapshot from ${entityId}:`, error);
      return undefined;
    }
  }

  private get nativeId(): string {
    return this.cameraDevice.nativeId ?? '';
  }

  private entityFor(sourceId: string): string | undefined {
    const group = this.host.group(this.nativeId);
    const source = this.cameraDevice.sources.find((item) => item._id === sourceId);
    if (!group || !source) return undefined;
    const stream = group.streams.find((item) => item.name === source.name) ?? group.streams.find((item) => item.role === source.role) ?? group.streams[0];
    return stream.entityId;
  }

  private sensors(): Sensor<any, any, any>[] {
    const controls = [...this.controls.values()].map((entry) => entry.control);
    return [this.motion, this.objects, this.audio, this.doorbell, this.battery, ...controls].filter((sensor) => !!sensor);
  }

  private async createSensors(entities: CameraEntity[], kinds: ReadonlySet<string>): Promise<void> {
    const id = (kind: string): string => `${this.nativeId}:${kind}`;

    if (kinds.has('motion')) this.motion ??= await this.add(new HaMotionSensor(id('motion')));
    if (kinds.has('object')) this.objects ??= await this.add(new HaObjectSensor(id('object')));
    if (kinds.has('audio')) this.audio ??= await this.add(new HaAudioSensor(id('audio')));
    if (kinds.has('doorbell')) this.doorbell ??= await this.add(new DoorbellTrigger('Home Assistant Doorbell', importOptions(id('doorbell'))));

    const parts = new Set(entities.flatMap((entity) => (entity.kind === 'battery' ? [entity.part] : [])));
    if (parts.size) this.battery ??= await this.add(new HaBatteryInfo(id('battery'), parts));

    for (const kind of ['light', 'siren'] as const) {
      if (!kinds.has(kind) || this.controls.has(kind)) continue;
      const name = kind === 'light' ? 'Home Assistant Light' : 'Home Assistant Siren';
      const control = createControl(kind, name, id(kind), (property, value) => this.command(kind, property, value));
      this.controls.set(kind, { control: await this.add(control) });
    }
  }

  private async add<T extends Sensor<any, any, any>>(sensor: T): Promise<T> {
    await this.cameraDevice.addSensor(sensor);
    return sensor;
  }

  private bind(entityId: string, entity: CameraEntity): void {
    if (entity.kind === 'light' || entity.kind === 'siren') {
      const control = this.controls.get(entity.kind);
      if (!control || control.entityId) return;
      control.entityId = entityId;
    }
    const sensor = this.sourceSensor(entity);
    let last: string | undefined;

    this.bindings.set(entityId, (state, live) => {
      const previous = last;
      last = state?.state;
      if (!state || state.state === 'unavailable') {
        sensor?.setSourceState('unavailable');
        return;
      }
      sensor?.setSourceState('connected');
      if (state.state === 'unknown') return;

      switch (entity.kind) {
        case 'events': {
          // an event entity's state is its last trigger time, only a live change is a new event
          if (!live || previous === undefined || previous === state.state) return;
          const type = typeof state.attributes.event_type === 'string' ? state.attributes.event_type : '';
          const detection = entity.types[type] ?? entity.fallback;
          if (detection) this.signal(detection, `${entityId}:${type}`, 'pulse');
          return;
        }
        case 'doorbell':
          if (live && previous === 'off' && state.state === 'on') this.doorbell?.trigger();
          return;
        case 'light':
        case 'siren': {
          const control = this.controls.get(entity.kind)?.control;
          if (control) applyControlState(entity.kind, control, state);
          return;
        }
        case 'battery':
          this.battery?.apply(entity.part, state.state);
          return;
        default:
          this.signal(entity, entityId, state.state === 'on');
      }
    });
  }

  private sourceSensor(entity: CameraEntity): Sensor<any, any, any> | undefined {
    switch (entity.kind) {
      case 'motion':
        return this.motion;
      case 'object':
        return this.objects;
      case 'audio':
        return this.audio;
      case 'doorbell':
        return this.doorbell;
      case 'battery':
        return this.battery;
      case 'light':
      case 'siren':
        return this.controls.get(entity.kind)?.control;
      default:
        return undefined;
    }
  }

  private signal(detection: Detection, key: string, on: boolean | 'pulse'): void {
    if (detection.kind === 'doorbell') {
      if (on) this.doorbell?.trigger();
      return;
    }
    if (detection.kind === 'motion') signal(this.motion, key, true, on);
    else if (detection.kind === 'object') signal(this.objects, key, detection.label, on);
    else signal(this.audio, key, detection.sound, on);
  }

  private async command(kind: ControlEntityKind, property: string, value: unknown): Promise<void> {
    const entityId = this.controls.get(kind)?.entityId;
    const client = this.host.client();
    const call = entityId ? commandToService(kind, entityId, property, value) : undefined;
    if (!call || !client) return;
    try {
      await client.callService(call.domain, call.service, call.data ?? {});
    } catch (error) {
      this.logger.error(`Command for ${entityId} failed:`, error);
    }
  }

  private async setOnline(online: boolean): Promise<void> {
    if (online === this.cameraDevice.connected) return;
    await (online ? this.cameraDevice.connect() : this.cameraDevice.disconnect());
  }
}

export function cameraGroups(registry: Registry, states: ReadonlyMap<string, HaState>, isOwn: (entityId: string) => boolean): CameraGroup[] {
  const groups = new Map<string, CameraGroup & { lens?: string }>();
  const claimed = new Set<string>();
  const perDevice = new Map<string, number>();

  for (const entry of registry.byId.values()) {
    if (!entry.entity_id.startsWith('camera.') || entry.disabled_by || isOwn(entry.entity_id)) continue;
    const state = states.get(entry.entity_id);
    if (!state || !((state.attributes.supported_features ?? 0) & STREAM_FEATURE)) continue;
    const variant = streamVariant(entry);
    if (variant === 'ignore') continue;

    const device = entry.device_id ? registry.devices.get(entry.device_id) : undefined;
    const lens = device ? variant?.lens : undefined;
    const nativeId = device && lens !== undefined ? [device.id, lens].filter(Boolean).join(':') : entry.id;

    let group = groups.get(nativeId);
    if (!group) {
      const sensorKey = device ? `${device.id}:${lens ?? ''}` : undefined;
      const sensorLens = sensorKey && !claimed.has(sensorKey) ? (lens ?? '') : undefined;
      if (sensorKey) claimed.add(sensorKey);
      if (device) perDevice.set(device.id, (perDevice.get(device.id) ?? 0) + 1);
      group = { nativeId, name: entityDisplayName(state), platform: entry.platform, device, lens, sensorLens, streams: [] };
      groups.set(nativeId, group);
    }
    group.streams.push({ entityId: entry.entity_id, name: variant?.name ?? 'Stream', role: variant?.role ?? 'high-resolution' });
  }

  return [...groups.values()].map(({ lens, ...group }) => {
    if (group.device && (lens !== undefined || perDevice.get(group.device.id) === 1)) group.name = lensName(group.device, lens ?? '');
    if (group.streams.length === 1) group.streams[0].role = 'high-resolution';
    group.streams.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    return group;
  });
}

export function discoveredCamera(group: CameraGroup): DiscoveredCamera {
  return {
    id: DISCOVERY_PREFIX + group.nativeId,
    name: group.name,
    manufacturer: group.device?.manufacturer ?? undefined,
    model: group.device?.model ?? undefined,
  };
}

export function groupNativeId(camera: DiscoveredCamera): string {
  return camera.id.slice(DISCOVERY_PREFIX.length);
}

export function cameraConfig(group: CameraGroup, registry: Registry, states: ReadonlyMap<string, HaState>, doorbellIds: ReadonlySet<string>): CameraConfig {
  const device = group.device;
  const entities = [...deviceEntities(registry, states, group, doorbellIds).values()];
  const kinds = detectionKinds(group, entities);
  return {
    name: group.name,
    nativeId: group.nativeId,
    type: kinds.has('doorbell') ? 'doorbell' : 'camera',
    isCloud: isCloudPlatform(group.platform),
    info: {
      manufacturer: device?.manufacturer ?? undefined,
      model: device?.model ?? undefined,
      hardware: device?.hw_version ?? undefined,
      serialNumber: device?.serial_number ?? undefined,
      firmwareVersion: device?.sw_version ?? undefined,
      power: isBatteryPowered(registry, states, device?.id, doorbellIds) ? 'battery' : 'mains',
    },
    sources: group.streams.map((stream, index) => ({
      name: stream.name,
      role: stream.role,
      useForSnapshot: index === 0,
      hotMode: false,
      preload: false,
    })),
  };
}

function deviceEntities(registry: Registry, states: ReadonlyMap<string, HaState>, group: CameraGroup, doorbellIds: ReadonlySet<string>): Map<string, CameraEntity> {
  const entities = new Map<string, CameraEntity>();
  if (group.sensorLens === undefined) return entities;

  const deviceEntries = activeDeviceEntries(registry, group.device?.id);
  const lenses = new Set(deviceEntries.map(streamVariant).flatMap((variant) => (typeof variant === 'object' ? [variant.lens] : [])));

  for (const entry of deviceEntries) {
    if (entry.entity_id.startsWith('camera.') || entityLens(entry, lenses) !== group.sensorLens) continue;
    const state = states.get(entry.entity_id);
    const entity = state ? cameraEntity(entry, state, doorbellIds) : undefined;
    if (entity) entities.set(entry.entity_id, entity);
  }
  return entities;
}

function isBatteryPowered(registry: Registry, states: ReadonlyMap<string, HaState>, deviceId: string | undefined, doorbellIds: ReadonlySet<string>): boolean {
  return activeDeviceEntries(registry, deviceId).some((entry) => {
    const state = states.get(entry.entity_id);
    return state !== undefined && cameraEntity(entry, state, doorbellIds)?.kind === 'battery';
  });
}

function activeDeviceEntries(registry: Registry, deviceId: string | undefined): HaRegistryEntry[] {
  if (!deviceId) return [];
  return [...registry.byId.values()].filter((entry) => entry.device_id === deviceId && !entry.disabled_by);
}

function detectionKinds(group: CameraGroup, entities: CameraEntity[]): Set<string> {
  const kinds = new Set<string>();
  const add = (detections: Detection[]): void => {
    for (const detection of detections) kinds.add(detection.kind);
  };
  for (const entity of entities) {
    if (entity.kind !== 'events') kinds.add(entity.kind);
    else add([...Object.values(entity.types), ...(entity.fallback ? [entity.fallback] : [])]);
  }
  const busEvents = group.sensorLens === undefined ? undefined : deviceBusEvents(group.platform);
  if (busEvents) add(Object.values(busEvents.types));
  return kinds;
}

function signal<T>(detector: CameraDetector<T> | undefined, key: string, value: T, on: boolean | 'pulse'): void {
  if (on === 'pulse') detector?.pulse(key, value);
  else detector?.set(key, value, on);
}

function lensName(device: HaDevice, lens: string): string {
  const name = device.name_by_user ?? device.name ?? device.id;
  if (!lens) return name;
  return `${name} ${lens.charAt(0).toUpperCase()}${lens.slice(1).replaceAll('_', ' ')}`;
}
