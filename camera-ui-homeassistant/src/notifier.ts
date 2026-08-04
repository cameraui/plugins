import type { DeviceStorage, JsonSchema, LoggerService, Notification, NotifierDevice } from '@camera.ui/sdk';
import type { HaClient } from './ha.js';
import type { HaState, StorageValues } from './types.js';

const DEVICE_PREFIX = 'notify:';

export class HaNotifier {
  private services: string[] = [];
  private entities = new Map<string, string>();
  private lastOwnerUserId = '';

  constructor(
    private readonly storage: DeviceStorage<StorageValues>,
    private readonly logger: LoggerService,
    private readonly getClient: () => HaClient | undefined,
  ) {}

  public async refreshTargets(states: HaState[]): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const previousCount = this.targetKeys().length;
    this.entities = new Map(
      states
        .filter((state) => state.entity_id.startsWith('notify.'))
        .map((state) => [state.entity_id, state.attributes.friendly_name ?? state.entity_id]),
    );
    try {
      this.services = await client.fetchNotifyServices();
    } catch (error) {
      this.logger.debug('Could not list Home Assistant notify services:', error);
    }

    const keys = this.targetKeys();
    if (keys.length !== previousCount) {
      this.logger.log(`Home Assistant notify targets available: ${keys.join(', ') || 'none'}`);
    }
  }

  public async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    const owner = ownerUserIds[0] ?? this.lastOwnerUserId;
    if (owner) this.lastOwnerUserId = owner;
    return this.targetKeys().map((key) => this.toDevice(key, owner));
  }

  public async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    const key = this.keyForId(deviceId);
    return key ? this.toDevice(key, this.lastOwnerUserId) : null;
  }

  public async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const message = [n.subtitle, n.body].filter(Boolean).join('\n') || n.title;
    const data: Record<string, unknown> = {};
    if (n.imageUrl) data.image = n.imageUrl;

    // before the first sync the target list is empty, send blind rather than drop
    const known = this.targetKeys();

    for (const deviceId of deviceIds) {
      const key = this.keyForId(deviceId);
      if (!key || this.isMuted(key)) continue;
      if (known.length > 0 && !known.includes(key)) {
        this.logger.debug(`Skipping notify target ${key}, Home Assistant no longer offers it`);
        continue;
      }
      try {
        if (this.isEntity(key)) {
          // notify.send_message only knows message and title, no picture
          await client.callService('notify', 'send_message', { entity_id: key, title: n.title, message });
        } else {
          await client.callService('notify', key, { title: n.title, message, data });
        }
      } catch (error) {
        this.logger.error(`Notify via ${key} failed:`, error);
      }
    }
  }

  public async registerDevice(): Promise<NotifierDevice> {
    throw new Error('Home Assistant notify targets are added automatically');
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    // the target exists as long as HA has it; revoking mutes it
    await this.setMuted(this.keyForId(deviceId), true);
  }

  public async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const key = this.keyForId(deviceId);
    if (!key || !this.targetKeys().includes(key)) return null;

    if (typeof patch.active === 'boolean') await this.setMuted(key, !patch.active);
    if (typeof patch.name === 'string' && patch.name.length > 0) {
      this.storage.values.notifyServiceNames = { ...this.storage.values.notifyServiceNames, [key]: patch.name };
      await this.storage.save();
    }
    return this.toDevice(key, this.lastOwnerUserId);
  }

  public async notificationSettings(): Promise<JsonSchema[] | undefined> {
    return undefined;
  }

  private targetKeys(): string[] {
    return [...this.services, ...this.entities.keys()];
  }

  private keyForId(deviceId: string): string | undefined {
    return deviceId.startsWith(DEVICE_PREFIX) ? deviceId.slice(DEVICE_PREFIX.length) : undefined;
  }

  private isEntity(key: string): boolean {
    return key.includes('.');
  }

  private isMuted(key: string): boolean {
    return (this.storage.values.mutedNotifyServices ?? []).includes(key);
  }

  private async setMuted(key: string | undefined, muted: boolean): Promise<void> {
    if (!key) return;
    const current = new Set(this.storage.values.mutedNotifyServices ?? []);
    if (muted) current.add(key);
    else current.delete(key);
    this.storage.values.mutedNotifyServices = [...current];
    await this.storage.save();
  }

  private toDevice(key: string, owner: string): NotifierDevice {
    return {
      id: `${DEVICE_PREFIX}${key}`,
      ownerUserId: owner,
      name: this.storage.values.notifyServiceNames?.[key] ?? this.entities.get(key) ?? key,
      active: !this.isMuted(key),
      metadata: this.isEntity(key) ? { entity: key } : { service: key },
    };
  }
}
