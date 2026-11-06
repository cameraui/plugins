import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { cameraConfig, cameraGroups, discoveredCamera, groupNativeId, HaCamera } from './cameras.js';
import { commandToService } from './controls.js';
import { HaClient, resolveTarget } from './ha.js';
import { busEventTypes, entityDetection } from './integrations/index.js';
import { entityDisplayName } from './mapping.js';
import { HaNotifier } from './notifier.js';
import { applyEntityState, createImportedSensor, detectionSensorType, entityUnavailable, importableSensorType } from './sensors.js';

import type {
  AdoptedSensor,
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveredSensor,
  DiscoveryProvider,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  Notification,
  NotifierDevice,
  NotifierInterface,
  PluginAPI,
  Sensor,
  SensorDiscoveryProvider,
  SensorType,
} from '@camera.ui/sdk';
import type { CameraGroup, CameraHost } from './cameras.js';
import type { CommandFn, ControlKind } from './controls.js';
import type { HaConnectionTarget } from './ha.js';
import type { Detection } from './integrations/types.js';
import type { ImportedSensor } from './sensors.js';
import type { HaBusEvent, HaRegistryEntry, HaRegistryEvent, HaState, Registry, StorageValues } from './types.js';

const OWN_MANUFACTURER = 'camera.ui';
const OWN_PLATFORM = 'cameraui';
const OWN_ID_PREFIX = 'cameraui_';
const RESYNC_INTERVAL_MS = 15 * 60_000;
const REGISTRY_RESYNC_MS = 2_000;

type RuntimeSensor = Sensor<any, any, any>;

interface BoundSensor {
  nativeId: string;
  imported: ImportedSensor;
  entityId?: string;
}

type Resolution = 'connected' | 'unavailable' | 'removed' | 'legacy';

export default class HomeAssistant extends BasePlugin<StorageValues> implements NotifierInterface, SensorDiscoveryProvider, DiscoveryProvider {
  private client?: HaClient;
  private target?: HaConnectionTarget;
  private cameras = new Map<string, HaCamera>();
  private cameraByEntity = new Map<string, HaCamera>();
  private groups = new Map<string, CameraGroup>();
  private registrySyncTimer?: NodeJS.Timeout;
  private lastDiscovered?: string;
  private bound = new Map<string, BoundSensor>();
  private byEntityId = new Map<string, BoundSensor>();
  private registry?: Registry;
  private lastStates = new Map<string, HaState>();
  private legacyLogged = false;
  private lastSummary?: string;
  private resyncInterval?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private notifier = new HaNotifier(this.storage, this.logger, () => this.client);
  private cameraHost: CameraHost = {
    client: () => this.client,
    target: () => this.target,
    group: (nativeId) => this.groups.get(nativeId),
    doorbellIds: () => this.doorbellIds(),
  };

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'boolean',
        key: 'debug',
        title: 'Debug',
        description: 'Enable debug mode',
        required: false,
        defaultValue: false,
        store: true,
      },
      {
        type: 'string',
        key: 'host',
        title: 'Home Assistant URL',
        description: 'For example http://homeassistant.local:8123. Leave empty when camera.ui runs as Home Assistant add-on.',
        required: false,
        store: true,
        onSet: async () => this.reconnectSoon(),
      },
      {
        type: 'string',
        key: 'token',
        title: 'Access Token',
        description: 'Long-lived access token from your Home Assistant profile. Leave empty when camera.ui runs as Home Assistant add-on.',
        format: 'password',
        required: false,
        store: true,
        onSet: async () => this.reconnectSoon(),
      },
      {
        type: 'string',
        key: 'doorbellEntities',
        title: 'Doorbell Entities',
        description: 'Comma-separated binary_sensor entity ids to offer as doorbells. The doorbell rings when the sensor turns on.',
        required: false,
        store: true,
      },
    ];
  }

  async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    return this.notifier.getDevices(ownerUserIds);
  }

  async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    return this.notifier.getDevice(deviceId);
  }

  async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    return this.notifier.sendNotification(deviceIds, n);
  }

  async registerDevice(): Promise<NotifierDevice> {
    return this.notifier.registerDevice();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    return this.notifier.revokeDevice(deviceId);
  }

  async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    return this.notifier.updateDevice(deviceId, patch);
  }

  async notificationSettings(): Promise<JsonSchema[] | undefined> {
    return this.notifier.notificationSettings();
  }

  async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.addCamera(camera);
  }

  async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.addCamera(camera);
    await this.syncEntities();
  }

  async onCameraReleased(cameraId: string): Promise<void> {
    this.cameras.delete(cameraId);
    this.indexCameraEntities();
    await this.pushDiscoveredCameras();
  }

  async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    const client = this.client;
    if (!client?.connected) return [];
    try {
      const [registry, states] = await Promise.all([this.loadRegistry(client), client.fetchStates()]);
      this.updateGroups(registry, states);
    } catch (error) {
      this.logger.warn('Could not load the Home Assistant cameras:', error);
      return [];
    }
    return this.discoverableCameras();
  }

  async onGetCameraSettings(): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  async onAdoptCamera(camera: DiscoveredCamera): Promise<CameraConfig> {
    const client = this.client;
    const group = this.groups.get(groupNativeId(camera));
    if (!client?.connected || !this.registry || !group) throw new Error(`${camera.name} is not available in Home Assistant`);

    const states = await client.fetchStates();
    this.logger.log(`Adopted camera ${group.name}`);
    return cameraConfig(group, this.registry, statesById(states), this.doorbellIds());
  }

  async onDiscoverSensors(): Promise<DiscoveredSensor[]> {
    const client = this.client;
    if (!client?.connected) return [];

    let registry: Registry;
    try {
      registry = await this.loadRegistry(client);
    } catch (error) {
      this.logger.warn('Could not load the Home Assistant registry, discovery is paused:', error);
      return [];
    }
    const states = await client.fetchStates();
    this.rememberStates(states);

    const result: DiscoveredSensor[] = [];
    const doorbells = this.doorbellIds();
    for (const state of states) {
      const entityId = state.entity_id;
      if (this.isOwnEntity(registry, entityId) || this.cameraByEntity.has(entityId)) continue;
      const type = this.importableType(state, doorbells);
      if (!type) continue;
      const entry = registry.byEntityId.get(entityId);
      result.push({ id: entry?.id ?? entityId, address: entityId, name: entityDisplayName(state), type, room: areaName(registry, entry) });
    }
    return result;
  }

  async configureAdoptedSensors(records: AdoptedSensor[]): Promise<RuntimeSensor[]> {
    const sensors: RuntimeSensor[] = [];
    for (const record of records) {
      const bound = this.bind(record);
      if (bound) sensors.push(bound.imported.sensor);
    }
    if (this.registry && this.client?.connected) this.resolveAll(this.registry);
    return sensors;
  }

  async onSensorAdopted(record: AdoptedSensor): Promise<RuntimeSensor> {
    const bound = this.bind(record);
    if (!bound) throw new Error(`No sensor type for "${record.name}" (${record.type})`);
    if (this.registry && this.client?.connected) this.resolve(bound, this.registry);
    return bound.imported.sensor;
  }

  async onSensorUnadopted(nativeId: string): Promise<void> {
    const bound = this.bound.get(nativeId);
    if (!bound) return;
    this.detach(bound);
    this.bound.delete(nativeId);
  }

  private bind(record: AdoptedSensor): BoundSensor | undefined {
    const imported = createImportedSensor({ type: record.type, name: record.name, nativeId: record.nativeId, address: record.address }, (kind) =>
      this.commandFor(record.nativeId, kind),
    );
    if (!imported) {
      this.logger.warn(`No sensor type for adopted "${record.name}" (${record.type}), it stays disconnected`);
      return undefined;
    }
    imported.sensor.setSourceState('unavailable');
    const bound: BoundSensor = { nativeId: record.nativeId, imported };
    this.bound.set(record.nativeId, bound);
    if (this.storage.values.debug) this.logger.log(`Adopted ${record.address ?? record.nativeId} as ${record.type} sensor`);
    return bound;
  }

  private commandFor(nativeId: string, kind: ControlKind): CommandFn {
    return async (property, value) => {
      const entityId = this.bound.get(nativeId)?.entityId;
      if (!entityId || !this.client) return;
      const call = commandToService(kind, entityId, property, value);
      if (!call) return;
      try {
        await this.client.callService(call.domain, call.service, call.data ?? {});
      } catch (error) {
        this.logger.error(`Command for ${entityId} failed:`, error);
      }
    };
  }

  private async start(): Promise<void> {
    const target = resolveTarget({ host: this.storage.values.host, token: this.storage.values.token });
    if (!target) {
      this.logger.warn('Home Assistant URL and access token are not configured');
      return;
    }
    this.target = target;

    this.client = new HaClient(
      target,
      this.logger,
      {
        onStateChanged: (entityId, state) => this.handleStateChanged(entityId, state),
        onRegistryUpdated: (event) => this.handleRegistryUpdated(event),
        onBusEvent: (eventType, event) => this.handleBusEvent(eventType, event),
        onConnected: () => this.syncEntities(),
        onDisconnected: () => this.markAllUnavailable(),
      },
      busEventTypes(),
    );
    this.client.connect();
    this.resyncInterval = setInterval(() => this.syncEntities(), RESYNC_INTERVAL_MS);
  }

  private async stop(): Promise<void> {
    if (this.resyncInterval) clearInterval(this.resyncInterval);
    this.resyncInterval = undefined;
    if (this.registrySyncTimer) clearTimeout(this.registrySyncTimer);
    this.registrySyncTimer = undefined;
    this.client?.stop();
    this.client = undefined;
  }

  private reconnectSoon(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.logger.log('Settings changed, reconnecting to Home Assistant');
      this.stop().then(() => this.start());
    }, 500);
  }

  private async syncEntities(): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;

    let states: HaState[];
    try {
      states = await client.fetchStates();
    } catch (error) {
      this.markAllUnavailable();
      this.logger.error('Home Assistant sync failed:', error);
      return;
    }
    await this.notifier.refreshTargets(states);

    let registry: Registry;
    try {
      registry = await this.loadRegistry(client);
    } catch (error) {
      this.markAllUnavailable();
      this.logger.warn('Could not load the Home Assistant entity registry, adopted entities stay unavailable until the next sync:', error);
      return;
    }
    this.rememberStates(states);
    this.resolveAll(registry);
    await this.refreshCameras(registry, states);
  }

  private async addCamera(camera: CameraDevice): Promise<void> {
    const haCamera = new HaCamera(camera, this.cameraHost);
    await haCamera.attach();
    this.cameras.set(camera.id, haCamera);
  }

  private updateGroups(registry: Registry, states: HaState[]): void {
    const groups = cameraGroups(registry, statesById(states), (entityId) => this.isOwnEntity(registry, entityId));
    this.groups = new Map(groups.map((group) => [group.nativeId, group]));
  }

  private async refreshCameras(registry: Registry, states: HaState[]): Promise<void> {
    this.updateGroups(registry, states);
    const byId = statesById(states);
    for (const camera of this.cameras.values()) {
      try {
        await camera.refresh(registry, byId);
      } catch (error) {
        this.logger.warn(`Could not refresh ${camera.cameraDevice.name}:`, error);
      }
    }
    this.indexCameraEntities();
    await this.pushDiscoveredCameras();
  }

  private indexCameraEntities(): void {
    this.cameraByEntity = new Map();
    for (const camera of this.cameras.values()) {
      for (const entityId of camera.entityIds) this.cameraByEntity.set(entityId, camera);
    }
  }

  private async discoverableCameras(): Promise<DiscoveredCamera[]> {
    const client = this.client;
    if (!client?.connected) return [];
    const adopted = new Set([...this.cameras.values()].map((camera) => camera.cameraDevice.nativeId));
    const candidates = [...this.groups.values()].filter((group) => !adopted.has(group.nativeId));
    const webrtc = await Promise.all(
      candidates.map((group) =>
        client
          .fetchCameraCapabilities(group.streams[0].entityId)
          .then((capabilities) => capabilities.frontend_stream_types.includes('web_rtc'))
          .catch(() => false),
      ),
    );
    return candidates.filter((_, index) => webrtc[index]).map(discoveredCamera);
  }

  private async pushDiscoveredCameras(): Promise<void> {
    const discovered = await this.discoverableCameras();
    const key = discovered.map((camera) => camera.id).join(',');
    if (discovered.length === 0 || key === this.lastDiscovered) return;
    this.lastDiscovered = key;
    await this.api.deviceManager.pushDiscoveredCameras(discovered);
  }

  private scheduleRegistrySync(): void {
    if (this.registrySyncTimer) clearTimeout(this.registrySyncTimer);
    this.registrySyncTimer = setTimeout(() => {
      this.registrySyncTimer = undefined;
      this.syncEntities();
    }, REGISTRY_RESYNC_MS);
  }

  private async loadRegistry(client: HaClient): Promise<Registry> {
    const [entries, areas, devices] = await Promise.all([client.fetchEntityRegistry(), client.fetchAreaRegistry(), client.fetchDeviceRegistry()]);
    const registry: Registry = {
      byId: new Map(entries.map((entry) => [entry.id, entry])),
      byEntityId: new Map(entries.map((entry) => [entry.entity_id, entry])),
      areas: new Map(areas.map((area) => [area.area_id, area.name])),
      devices: new Map(devices.map((device) => [device.id, device])),
      cameraDevices: new Set(entries.flatMap((entry) => (entry.device_id && entry.entity_id.startsWith('camera.') ? [entry.device_id] : []))),
    };
    this.registry = registry;
    return registry;
  }

  private resolveAll(registry: Registry): void {
    const counts: Record<Resolution, number> = { connected: 0, unavailable: 0, removed: 0, legacy: 0 };
    for (const bound of this.bound.values()) counts[this.resolve(bound, registry)]++;

    if (counts.legacy > 0 && !this.legacyLogged) {
      this.legacyLogged = true;
      // prettier-ignore
      this.logger.warn(
        `${counts.legacy} adopted entities still carry the identity from plugin 1.0.11 and are marked as removed. ` +
        'Delete them on the sensors page and adopt the entities again.',
      );
    }

    const summary = `${this.bound.size} adopted entities: ${counts.connected} connected, ${counts.unavailable} unavailable, ${counts.removed + counts.legacy} removed`;
    if (summary !== this.lastSummary) {
      this.lastSummary = summary;
      this.logger.log(`Home Assistant sync: ${summary}`);
    }
  }

  private resolve(bound: BoundSensor, registry: Registry): Resolution {
    const sensor = bound.imported.sensor;
    const entry = registry.byId.get(bound.nativeId);
    let entityId = entry?.entity_id;

    if (!entry && bound.nativeId.includes('.')) {
      if (registry.byEntityId.has(bound.nativeId)) {
        this.detach(bound);
        sensor.setSourceState('removed');
        return 'legacy';
      }
      if (this.lastStates.has(bound.nativeId)) entityId = bound.nativeId;
    }

    if (!entityId) {
      this.detach(bound);
      sensor.setSourceState('removed');
      return 'removed';
    }

    this.attach(bound, entityId);
    const state = this.lastStates.get(entityId);
    if (!state) {
      sensor.setSourceState('unavailable');
      return 'unavailable';
    }
    return this.applyState(bound, state, false);
  }

  private applyState(bound: BoundSensor, state: HaState, live: boolean): 'connected' | 'unavailable' {
    if (entityUnavailable(bound.imported, state)) {
      bound.imported.sensor.setSourceState('unavailable');
      return 'unavailable';
    }
    applyEntityState(bound.imported, state, live, this.cameraDetection(state, this.doorbellIds()));
    bound.imported.sensor.setSourceState('connected');
    return 'connected';
  }

  private attach(bound: BoundSensor, entityId: string): void {
    if (bound.entityId === entityId) return;
    this.detach(bound);
    bound.entityId = entityId;
    this.byEntityId.set(entityId, bound);
    bound.imported.sensor.setAddress(entityId);
  }

  private detach(bound: BoundSensor): void {
    if (bound.entityId && this.byEntityId.get(bound.entityId) === bound) this.byEntityId.delete(bound.entityId);
    bound.entityId = undefined;
  }

  private markAllUnavailable(): void {
    this.lastSummary = undefined;
    for (const bound of this.bound.values()) {
      if (bound.entityId) bound.imported.sensor.setSourceState('unavailable');
    }
    for (const camera of this.cameras.values()) camera.markUnavailable();
  }

  private handleBusEvent(eventType: string, event: HaBusEvent): void {
    if (typeof event.device_id !== 'string' || typeof event.type !== 'string') return;
    for (const camera of this.cameras.values()) camera.handleBusEvent(eventType, event.device_id, event.type);
  }

  private handleStateChanged(entityId: string, state: HaState | null): void {
    this.cameraByEntity.get(entityId)?.handleState(entityId, state);
    const bound = this.byEntityId.get(entityId);
    if (state && (bound || this.importableType(state, this.doorbellIds()))) {
      this.lastStates.set(entityId, state);
    } else if (!state) {
      this.lastStates.delete(entityId);
    }
    if (!bound) return;

    if (!state) {
      bound.imported.sensor.setSourceState('unavailable');
      return;
    }
    this.applyState(bound, state, true);
  }

  private handleRegistryUpdated(event: HaRegistryEvent): void {
    const registry = this.registry;
    this.scheduleRegistrySync();

    if (event.action === 'remove') {
      const entry = registry?.byEntityId.get(event.entity_id);
      if (registry && entry) {
        registry.byEntityId.delete(event.entity_id);
        registry.byId.delete(entry.id);
      }
      const bound = this.byEntityId.get(event.entity_id);
      if (!bound) return;
      this.detach(bound);
      bound.imported.sensor.setSourceState('removed');
      this.logger.log(`${event.entity_id} was removed in Home Assistant`);
      return;
    }

    if (event.action === 'update' && event.old_entity_id && event.old_entity_id !== event.entity_id) {
      const entry = registry?.byEntityId.get(event.old_entity_id);
      if (registry && entry) {
        registry.byEntityId.delete(event.old_entity_id);
        entry.entity_id = event.entity_id;
        registry.byEntityId.set(event.entity_id, entry);
      }
      const bound = this.byEntityId.get(event.old_entity_id);
      if (!bound) return;
      this.attach(bound, event.entity_id);
      const state = this.lastStates.get(event.entity_id);
      if (state) this.applyState(bound, state, false);
      this.logger.log(`${event.old_entity_id} was renamed to ${event.entity_id} in Home Assistant`);
    }
  }

  private rememberStates(states: HaState[]): void {
    const doorbells = this.doorbellIds();
    const relevant = states.filter((state) => this.byEntityId.has(state.entity_id) || this.importableType(state, doorbells));
    this.lastStates = new Map(relevant.map((state) => [state.entity_id, state]));
  }

  private importableType(state: HaState, doorbells: ReadonlySet<string>): SensorType | undefined {
    const detection = this.cameraDetection(state, doorbells);
    return detection ? detectionSensorType(detection) : importableSensorType(state, doorbells);
  }

  private cameraDetection(state: HaState, doorbells: ReadonlySet<string>): Detection | undefined {
    const entry = this.registry?.byEntityId.get(state.entity_id);
    // only a camera's own entities follow its integration's rules, a Matter button elsewhere is no doorbell
    if (!entry?.device_id || !this.registry?.cameraDevices.has(entry.device_id)) return undefined;
    return entityDetection(entry, state, doorbells);
  }

  private isOwnEntity(registry: Registry, entityId: string): boolean {
    const entry = registry.byEntityId.get(entityId);
    if (entry?.platform === OWN_PLATFORM) return true;
    const device = entry?.device_id ? registry.devices.get(entry.device_id) : undefined;
    if (!device) return false;
    if (device.manufacturer === OWN_MANUFACTURER) return true;
    return device.identifiers?.some(([domain, id]) => domain === OWN_PLATFORM || (typeof id === 'string' && id.startsWith(OWN_ID_PREFIX))) ?? false;
  }

  private doorbellIds(): Set<string> {
    const raw = this.storage.values.doorbellEntities ?? '';
    return new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
}

function statesById(states: HaState[]): Map<string, HaState> {
  return new Map(states.map((state) => [state.entity_id, state]));
}

function areaName(registry: Registry, entry: HaRegistryEntry | undefined): string | undefined {
  if (!entry) return undefined;
  const areaId = entry.area_id ?? (entry.device_id ? registry.devices.get(entry.device_id)?.area_id : undefined);
  return areaId ? registry.areas.get(areaId) : undefined;
}
