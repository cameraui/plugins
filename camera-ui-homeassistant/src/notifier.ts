import { randomUUID } from 'node:crypto';

import type { DeviceStorage, JsonSchema, LoggerService, Notification, NotifierDevice } from '@camera.ui/sdk';
import type { HaClient } from './ha.js';
import type { StorageValues } from './types.js';

export interface StoredNotifierDevice {
  id: string;
  ownerUserId: string;
  name: string;
  active: boolean;
  service: string;
}

export class HaNotifier {
  private services: string[] = [];

  constructor(
    private readonly storage: DeviceStorage<StorageValues>,
    private readonly logger: LoggerService,
    private readonly getClient: () => HaClient | undefined,
  ) {}

  public async refreshServices(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    try {
      this.services = await client.fetchNotifyServices();
    } catch (error) {
      this.logger.debug('Could not list Home Assistant notify services:', error);
    }
  }

  public async getDevices(ownerUserIds: string[]): Promise<NotifierDevice[]> {
    return this.devices()
      .filter((device) => ownerUserIds.includes(device.ownerUserId))
      .map((device) => this.toDevice(device));
  }

  public async getDevice(deviceId: string): Promise<NotifierDevice | null> {
    const device = this.devices().find((entry) => entry.id === deviceId);
    return device ? this.toDevice(device) : null;
  }

  public async sendNotification(deviceIds: string[], n: Notification): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const message = [n.subtitle, n.body].filter(Boolean).join('\n') || n.title;
    const data: Record<string, unknown> = {};
    if (n.imageUrl) data.image = n.imageUrl;

    for (const device of this.devices()) {
      if (!deviceIds.includes(device.id) || !device.active) continue;
      try {
        await client.callService('notify', device.service, { title: n.title, message, data });
      } catch (error) {
        this.logger.error(`Notify via ${device.service} failed:`, error);
      }
    }
  }

  public async registerDevice(ownerUserId: string, input: Record<string, unknown>): Promise<NotifierDevice> {
    const service = typeof input.service === 'string' ? input.service : '';
    if (!service) throw new Error('A Home Assistant notify service is required');

    const name = typeof input.name === 'string' && input.name.length > 0 ? input.name : service;
    const device: StoredNotifierDevice = {
      id: randomUUID(),
      ownerUserId,
      name,
      active: true,
      service,
    };
    await this.saveDevices([...this.devices(), device]);
    return this.toDevice(device);
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    await this.saveDevices(this.devices().filter((device) => device.id !== deviceId));
  }

  public async updateDevice(deviceId: string, patch: Record<string, unknown>): Promise<NotifierDevice | null> {
    const devices = this.devices();
    const device = devices.find((entry) => entry.id === deviceId);
    if (!device) return null;

    if (typeof patch.name === 'string') device.name = patch.name;
    if (typeof patch.active === 'boolean') device.active = patch.active;
    await this.saveDevices(devices);
    return this.toDevice(device);
  }

  public async notificationSettings(): Promise<JsonSchema[] | undefined> {
    await this.refreshServices();
    return [
      {
        type: 'string',
        key: 'service',
        title: 'Notify Service',
        description: 'Home Assistant notify service this device delivers to.',
        required: true,
        enum: this.services,
      },
      {
        type: 'string',
        key: 'name',
        title: 'Name',
        description: 'Display name for this device.',
        required: false,
      },
    ];
  }

  private devices(): StoredNotifierDevice[] {
    return this.storage.values.notifierDevices ?? [];
  }

  private async saveDevices(devices: StoredNotifierDevice[]): Promise<void> {
    this.storage.values.notifierDevices = devices;
    await this.storage.save();
  }

  private toDevice(device: StoredNotifierDevice): NotifierDevice {
    return {
      id: device.id,
      ownerUserId: device.ownerUserId,
      name: device.name,
      active: device.active,
      metadata: { service: device.service },
    };
  }
}
