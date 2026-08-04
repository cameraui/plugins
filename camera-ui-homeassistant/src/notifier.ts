import type { DeviceStorage, JsonSchema, LoggerService, Notification, NotifierDevice } from '@camera.ui/sdk';
import type { HaClient } from './ha.js';
import type { StorageValues } from './types.js';

const DEVICE_PREFIX = 'notify:';

export class HaNotifier {
  private services: string[] = [];
  private lastOwnerUserId = '';

  constructor(
    private readonly storage: DeviceStorage<StorageValues>,
    private readonly logger: LoggerService,
    private readonly getClient: () => HaClient | undefined,
  ) {}

  public async refreshServices(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    try {
      const services = await client.fetchNotifyServices();
      if (services.length !== this.services.length) {
        this.logger.log(`Home Assistant notify targets available: ${services.join(', ') || 'none'}`);
      }
      this.services = services;
    } catch (error) {
      this.logger.debug('Could not list Home Assistant notify services:', error);
    }
  }

  public async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    const owner = ownerUserIds[0] ?? this.lastOwnerUserId;
    if (owner) this.lastOwnerUserId = owner;
    return this.services.map((service) => this.toDevice(service, owner));
  }

  public async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    const service = this.serviceForId(deviceId);
    return service ? this.toDevice(service, this.lastOwnerUserId) : null;
  }

  public async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const message = [n.subtitle, n.body].filter(Boolean).join('\n') || n.title;
    const data: Record<string, unknown> = {};
    if (n.imageUrl) data.image = n.imageUrl;

    for (const deviceId of deviceIds) {
      const service = this.serviceForId(deviceId);
      if (!service || this.isMuted(service)) continue;
      try {
        await client.callService('notify', service, { title: n.title, message, data });
      } catch (error) {
        this.logger.error(`Notify via ${service} failed:`, error);
      }
    }
  }

  public async registerDevice(): Promise<NotifierDevice> {
    throw new Error('Home Assistant notify targets are added automatically');
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    // the service exists as long as HA has it; revoking mutes it
    await this.setMuted(this.serviceForId(deviceId), true);
  }

  public async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const service = this.serviceForId(deviceId);
    if (!service || !this.services.includes(service)) return null;

    if (typeof patch.active === 'boolean') await this.setMuted(service, !patch.active);
    if (typeof patch.name === 'string' && patch.name.length > 0) {
      this.storage.values.notifyServiceNames = { ...this.storage.values.notifyServiceNames, [service]: patch.name };
      await this.storage.save();
    }
    return this.toDevice(service, this.lastOwnerUserId);
  }

  public async notificationSettings(): Promise<JsonSchema[] | undefined> {
    return undefined;
  }

  private serviceForId(deviceId: string): string | undefined {
    return deviceId.startsWith(DEVICE_PREFIX) ? deviceId.slice(DEVICE_PREFIX.length) : undefined;
  }

  private isMuted(service: string): boolean {
    return (this.storage.values.mutedNotifyServices ?? []).includes(service);
  }

  private async setMuted(service: string | undefined, muted: boolean): Promise<void> {
    if (!service) return;
    const current = new Set(this.storage.values.mutedNotifyServices ?? []);
    if (muted) current.add(service);
    else current.delete(service);
    this.storage.values.mutedNotifyServices = [...current];
    await this.storage.save();
  }

  private toDevice(service: string, owner: string): NotifierDevice {
    return {
      id: `${DEVICE_PREFIX}${service}`,
      ownerUserId: owner,
      name: this.storage.values.notifyServiceNames?.[service] ?? service,
      active: !this.isMuted(service),
      metadata: { service },
    };
  }
}
