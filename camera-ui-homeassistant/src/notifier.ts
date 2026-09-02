import type { DeviceStorage, JsonSchema, LoggerService, Notification, NotifierDevice } from '@camera.ui/sdk';
import type { HaClient } from './ha.js';
import type { HaState, StorageValues } from './types.js';

const DEVICE_PREFIX = 'notify:';

function toHaImageUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return undefined;
  if (/^https?:\/\//.test(imageUrl)) return imageUrl;
  return `/api/cameraui/notify${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
}

export class HaNotifier {
  private services: string[] = [];
  private entities = new Map<string, string>();
  private lastOwnerUserId = '';
  private panelPath: string | undefined;

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
      states.filter((state) => state.entity_id.startsWith('notify.')).map((state) => [state.entity_id, state.attributes.friendly_name ?? state.entity_id]),
    );
    try {
      // 'notify' fans out to every mobile_app service and 'persistent_notification' is not a device,
      // both would duplicate what the concrete targets already deliver
      this.services = (await client.fetchNotifyServices()).filter((service) => service !== 'notify' && service !== 'persistent_notification');
    } catch (error) {
      this.logger.debug('Could not list Home Assistant notify services:', error);
    }

    try {
      const panels = await client.fetchPanels();
      const panel = Object.values(panels).find((p) => p.config?._panel_custom?.name === 'cameraui-panel');
      this.panelPath = panel ? `/${panel.url_path}` : undefined;
    } catch (error) {
      this.logger.debug('Could not list Home Assistant panels:', error);
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
    // silent replaces an existing banner in the apps; HA notify can only add a new audible one
    if (n.silent) return;

    const message = [n.subtitle, n.body].filter(Boolean).join('\n') || n.title;
    const data: Record<string, unknown> = {};
    const image = toHaImageUrl(n.imageUrl);
    if (image) data.image = image;
    if (n.tag) data.tag = n.tag;
    if (n.deepLink && this.panelPath) {
      const link = `${this.panelPath}${n.deepLink}`;
      data.url = link; // iOS
      data.clickAction = link; // Android
    }

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
    // mobile_app registers a notify entity next to its service for the same phone, keep the
    // service (it can carry a picture) and drop the entity twin
    const entityKeys = [...this.entities.keys()].filter((entity) => !this.services.includes(`mobile_app_${entity.split('.')[1]}`));
    return [...this.services, ...entityKeys];
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
