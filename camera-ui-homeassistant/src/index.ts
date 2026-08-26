import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { commandToService } from './controls.js';
import { HaClient, resolveTarget } from './ha.js';
import { entityDisplayName } from './mapping.js';
import { HaNotifier } from './notifier.js';
import { applyEntityState, createImportedSensor, importableSensorType, isImportableEntity } from './sensors.js';

import type {
  DeviceStorage,
  DiscoveredSensor,
  JsonSchema,
  LoggerService,
  Notification,
  NotifierDevice,
  NotifierInterface,
  PluginAPI,
  SensorDiscoveryProvider,
} from '@camera.ui/sdk';
import type { ImportedSensor } from './sensors.js';
import type { HaState, StorageValues } from './types.js';

const OWN_ENTITIES_TEMPLATE = `
{%- set ns = namespace(ids=[]) -%}
{%- for s in states -%}
{%- set d = device_id(s.entity_id) -%}
{%- if d and device_attr(d, 'manufacturer') == 'camera.ui' -%}
{%- set ns.ids = ns.ids + [s.entity_id] -%}
{%- endif -%}
{%- endfor -%}
{{ ns.ids | tojson }}`;

const AREA_MAP_TEMPLATE = `
{%- set ns = namespace(m=[]) -%}
{%- for s in states -%}
{%- set a = area_name(s.entity_id) -%}
{%- if a -%}{%- set ns.m = ns.m + [[s.entity_id, a]] -%}{%- endif -%}
{%- endfor -%}
{{ ns.m | tojson }}`;

export default class HomeAssistant extends BasePlugin<StorageValues> implements NotifierInterface, SensorDiscoveryProvider {
  private client?: HaClient;
  private imported = new Map<string, ImportedSensor>();
  private skippedLogged = new Set<string>();
  private ownEntities = new Set<string>();
  private adopted = new Set<string>();
  private lastStates = new Map<string, HaState>();
  private guardLoaded = false;
  private syncLogged = false;
  private resyncTimer?: NodeJS.Timeout;
  private resyncInterval?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private notifier = new HaNotifier(this.storage, this.logger, () => this.client);

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
        key: 'excludeEntities',
        title: 'Excluded Entities',
        description: 'Comma-separated entity ids that should not be imported.',
        required: false,
        store: true,
        onSet: async () => this.reconnectSoon(),
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

  async configureCameras(): Promise<void> {}

  async onCameraAdded(): Promise<void> {}

  async onCameraReleased(): Promise<void> {}

  async onDiscoverSensors(): Promise<DiscoveredSensor[]> {
    const client = this.client;
    if (!client) return [];

    await this.loadOwnEntities(client);
    if (!this.guardLoaded) return [];
    const states = await client.fetchStates();
    const areas = await this.fetchAreaMap(client);

    const result: DiscoveredSensor[] = [];
    for (const state of states) {
      const entityId = state.entity_id;
      if (this.adopted.has(entityId) || this.imported.has(entityId)) continue;
      if (this.ownEntities.has(entityId) || this.isExcluded(entityId)) continue;
      const type = importableSensorType(state);
      if (!type) continue;
      this.lastStates.set(entityId, state);
      result.push({ id: entityId, name: entityDisplayName(state), type, room: areas.get(entityId) });
    }
    return result;
  }

  async onAdoptSensor(sensor: DiscoveredSensor): Promise<void> {
    this.adopted.add(sensor.id);
    await this.storage.setValue('adoptedEntities', [...this.adopted]);

    let state = this.lastStates.get(sensor.id);
    if (!state && this.client) {
      state = (await this.client.fetchStates()).find((s) => s.entity_id === sensor.id);
    }
    if (state) this.applyOrImport(state, false);
  }

  async onReleaseSensor(discoveredId: string): Promise<void> {
    this.adopted.delete(discoveredId);
    await this.storage.setValue('adoptedEntities', [...this.adopted]);

    const imported = this.imported.get(discoveredId);
    if (imported) {
      this.imported.delete(discoveredId);
      await this.api.sensorManager.removeSensor(imported.sensor);
    }
  }

  private async fetchAreaMap(client: HaClient): Promise<Map<string, string>> {
    try {
      const rendered = await client.renderTemplate(AREA_MAP_TEMPLATE);
      return new Map(JSON.parse(rendered) as [string, string][]);
    } catch {
      return new Map();
    }
  }

  private async start(): Promise<void> {
    this.adopted = new Set(this.storage.values.adoptedEntities ?? []);
    const target = resolveTarget({ host: this.storage.values.host, token: this.storage.values.token });
    if (!target) {
      this.logger.warn('Home Assistant URL and access token are not configured');
      return;
    }

    this.client = new HaClient(
      target,
      this.logger,
      (_entityId, state) => this.handleStateChanged(state),
      () => this.syncEntities(),
    );
    this.client.connect();
    this.resyncInterval = setInterval(() => this.syncEntities(), 15 * 60_000);
  }

  private async stop(): Promise<void> {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    if (this.resyncInterval) clearInterval(this.resyncInterval);
    this.resyncInterval = undefined;
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
    if (!client) return;

    try {
      await this.loadOwnEntities(client);
      const states = await client.fetchStates();
      await this.notifier.refreshTargets(states);

      const before = new Set(this.imported.keys());

      for (const [entityId, imported] of this.imported) {
        if (this.ownEntities.has(entityId) || this.isExcluded(entityId) || !this.adopted.has(entityId)) {
          this.imported.delete(entityId);
          this.api.sensorManager.removeSensor(imported.sensor);
        }
      }

      for (const state of states) {
        if (!this.guardLoaded && !this.imported.has(state.entity_id)) continue;
        this.applyOrImport(state, false);
      }

      const added = [...this.imported.keys()].filter((entityId) => !before.has(entityId)).length;
      const removed = [...before].filter((entityId) => !this.imported.has(entityId)).length;
      if (!this.syncLogged || added > 0 || removed > 0) {
        this.syncLogged = true;
        const changes = [added > 0 ? `${added} added` : '', removed > 0 ? `${removed} removed` : ''].filter(Boolean).join(', ');
        this.logger.log(`Home Assistant sync: ${this.imported.size} entities imported as sensors${changes ? ` (${changes})` : ''}`);
      }
    } catch (error) {
      this.logger.error('Home Assistant sync failed:', error);
    }
  }

  private async loadOwnEntities(client: HaClient): Promise<void> {
    try {
      const rendered = await client.renderTemplate(OWN_ENTITIES_TEMPLATE);
      this.ownEntities = new Set(JSON.parse(rendered) as string[]);
      this.guardLoaded = true;
    } catch (error) {
      this.guardLoaded = false;
      this.logger.warn('Could not resolve camera.ui-owned entities, imports are paused:', error);
    }
  }

  private handleStateChanged(state: HaState | null): void {
    if (!state) return;
    const existing = this.imported.get(state.entity_id);
    if (existing) {
      if (!this.ownEntities.has(state.entity_id) && !this.isExcluded(state.entity_id)) {
        applyEntityState(existing, state, true);
      }
      return;
    }

    if (this.ownEntities.has(state.entity_id) || this.isExcluded(state.entity_id)) return;
    if (this.guardLoaded && !isImportableEntity(state)) return;
    this.scheduleResync();
  }

  private scheduleResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined;
      void this.syncEntities();
    }, 5000);
  }

  private applyOrImport(state: HaState, live: boolean): boolean {
    const entityId = state.entity_id;
    if (this.ownEntities.has(entityId) || this.isExcluded(entityId)) return false;
    if (!this.adopted.has(entityId)) return false;

    const existing = this.imported.get(entityId);
    if (existing) {
      applyEntityState(existing, state, live);
      return true;
    }

    const imported = createImportedSensor(state, (kind) => async (property, value) => {
      const call = commandToService(kind, entityId, property, value);
      if (!call || !this.client) return;
      try {
        await this.client.callService(call.domain, call.service, call.data ?? {});
      } catch (error) {
        this.logger.error(`Command for ${entityId} failed:`, error);
      }
    });
    if (!imported) {
      const deviceClass = state.attributes.device_class;
      const domain = entityId.split('.')[0];
      if (deviceClass && (domain === 'binary_sensor' || domain === 'sensor') && !this.skippedLogged.has(deviceClass)) {
        this.skippedLogged.add(deviceClass);
        this.logger.debug(`No sensor type for device_class '${deviceClass}', skipping such entities`);
      }
      return false;
    }

    this.imported.set(entityId, imported);
    this.registerImported(entityId, imported, state);
    return true;
  }

  private async registerImported(entityId: string, imported: ImportedSensor, state: HaState): Promise<void> {
    try {
      await this.api.sensorManager.addSensor(imported.sensor);
      if (this.storage.values.debug) {
        this.logger.log(`Imported ${entityId} as ${imported.sensor.type} sensor`);
      }
      applyEntityState(imported, state, false);
    } catch (error) {
      this.imported.delete(entityId);
      this.logger.error(`Failed to register sensor for ${entityId}:`, error);
    }
  }

  private isExcluded(entityId: string): boolean {
    const raw = this.storage.values.excludeEntities;
    if (!raw) return false;
    return raw
      .split(',')
      .map((item) => item.trim())
      .includes(entityId);
  }
}
