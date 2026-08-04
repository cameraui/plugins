import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { commandToService } from './controls.js';
import { HaClient, resolveTarget } from './ha.js';
import { applyEntityState, createImportedSensor } from './sensors.js';

import type { DeviceStorage, JsonSchema, LoggerService, PluginAPI } from '@camera.ui/sdk';
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

export default class HomeAssistant extends BasePlugin<StorageValues> {
  private client?: HaClient;
  private imported = new Map<string, ImportedSensor>();
  private skippedLogged = new Set<string>();
  private ownEntities = new Set<string>();

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
      },
      {
        type: 'string',
        key: 'token',
        title: 'Access Token',
        description: 'Long-lived access token from your Home Assistant profile. Leave empty when camera.ui runs as Home Assistant add-on.',
        format: 'password',
        required: false,
        store: true,
      },
      {
        type: 'string',
        key: 'excludeEntities',
        title: 'Excluded Entities',
        description: 'Comma-separated entity ids that should not be imported.',
        required: false,
        store: true,
      },
    ];
  }

  async configureCameras(): Promise<void> {}

  async onCameraAdded(): Promise<void> {}

  async onCameraReleased(): Promise<void> {}

  private async start(): Promise<void> {
    const target = resolveTarget({ host: this.storage.values.host, token: this.storage.values.token });
    if (!target) {
      this.logger.warn('Home Assistant URL and access token are not configured');
      return;
    }

    this.client = new HaClient(
      target,
      this.logger,
      (_entityId, state) => this.handleStateChanged(state),
      () => void this.syncEntities(),
    );
    this.client.connect();
  }

  private async stop(): Promise<void> {
    this.client?.stop();
    this.client = undefined;
  }

  private async syncEntities(): Promise<void> {
    const client = this.client;
    if (!client) return;

    try {
      await this.loadOwnEntities(client);
      const states = await client.fetchStates();

      let importedCount = 0;
      for (const state of states) {
        if (this.applyOrImport(state, false)) importedCount++;
      }
      this.logger.log(`Home Assistant sync: ${importedCount} entities imported as sensors`);
    } catch (error) {
      this.logger.error('Home Assistant sync failed:', error);
    }
  }

  private async loadOwnEntities(client: HaClient): Promise<void> {
    try {
      const rendered = await client.renderTemplate(OWN_ENTITIES_TEMPLATE);
      this.ownEntities = new Set(JSON.parse(rendered) as string[]);
    } catch (error) {
      this.logger.debug('Could not resolve camera.ui-owned entities:', error);
    }
  }

  private handleStateChanged(state: HaState | null): void {
    if (!state) return;
    this.applyOrImport(state, true);
  }

  private applyOrImport(state: HaState, live: boolean): boolean {
    const entityId = state.entity_id;
    if (this.ownEntities.has(entityId) || this.isExcluded(entityId)) return false;

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
    void this.registerImported(entityId, imported, state);
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
