import { AccessoryEventTypes, Bridge, Categories, Characteristic, Service, uuid } from '../hap.js';
import * as mac from '../utils/mac.js';
import { buildSensorAccessory } from './sensorAccessory.js';

import type { DeviceStorage, LoggerService, PluginAPI, SensorLike } from '@camera.ui/sdk';
import type { Accessory, MacAddress, MDNSAdvertiser, PublishInfo } from '../hap.js';
import type HomeKit from '../index.js';
import type { PluginStorageValues } from '../types.js';
import type { BridgedSensorAccessory } from './sensorAccessory.js';

export class SensorBridge {
  private api: PluginAPI;
  private logger: LoggerService;
  private storage: DeviceStorage<PluginStorageValues>;
  private publishedExternalAccessories: Map<MacAddress, Accessory>;

  private bridge?: Bridge;
  private bridgePort?: number;
  private started = false;
  private published = false;
  private publishing?: Promise<void>;

  private sensors = new Map<string, SensorLike>();
  private entries = new Map<string, BridgedSensorAccessory>();

  private get advertiser(): MDNSAdvertiser {
    return this.storage.values.bridgeAdvertiser.split(' (')[0] as MDNSAdvertiser;
  }

  constructor(platform: HomeKit) {
    this.api = platform.api;
    this.logger = platform.logger;
    this.storage = platform.storage;
    this.publishedExternalAccessories = platform.publishedExternalAccessories;
  }

  public get currentPort(): number | undefined {
    return this.bridgePort;
  }

  public setupURI(): string {
    return this.published ? (this.bridge?.setupURI() ?? '') : '';
  }

  public async start(): Promise<void> {
    this.started = true;
    await this.publishBridge();
  }

  public async addSensor(sensor: SensorLike): Promise<void> {
    if (this.sensors.has(sensor.id)) {
      return;
    }

    this.sensors.set(sensor.id, sensor);

    if (this.started) {
      await this.syncSensor(sensor.id);
    }
  }

  public async removeSensor(sensorId: string): Promise<void> {
    this.sensors.delete(sensorId);

    if (this.publishing) {
      await this.publishing;
    }

    const entry = this.entries.get(sensorId);
    if (entry) {
      entry.dispose();
      this.entries.delete(sensorId);
      this.bridge?.removeBridgedAccessory(entry.accessory);
      this.logger.debug(`Removed bridged accessory for sensor: ${sensorId}`);
    }
  }

  public async republish(reset?: boolean): Promise<void> {
    await this.teardown(reset);

    if (this.started) {
      await this.publishBridge(!reset);
    }
  }

  public async teardown(destroy?: boolean): Promise<void> {
    if (this.publishing) {
      await this.publishing.catch(() => {});
    }

    const wasPublished = this.published;
    this.published = false;

    if (this.bridge) {
      const bridge = this.bridge;
      try {
        if (destroy) {
          this.logger.log('Removing bridge...');
          await bridge.destroy();
        } else if (wasPublished) {
          this.logger.log('Stopping bridge...');
          await bridge.unpublish();
        }
      } finally {
        for (const entry of this.entries.values()) {
          entry.dispose();
        }
        this.entries.clear();

        bridge.removeAllListeners();
        this.bridge = undefined;
        if (destroy) {
          this.bridgePort = undefined;
        }

        const advertiseAddress = await this.storage.getValue<string>('bridgeAdvertiseAddress');
        if (this.publishedExternalAccessories.get(advertiseAddress!) === bridge) {
          this.publishedExternalAccessories.delete(advertiseAddress!);
        }
      }
    }
  }

  private async syncSensor(sensorId: string): Promise<void> {
    if (this.publishing) {
      await this.publishing;
    }

    if (!this.published) {
      await this.publishBridge();
      return;
    }

    if (this.entries.has(sensorId)) {
      return;
    }

    const sensor = this.sensors.get(sensorId);
    if (!sensor || !this.bridge) {
      return;
    }

    const built = buildSensorAccessory(sensor, this.storage.values.bridgeRepublishId, this.logger);
    if (!built) {
      return;
    }

    this.entries.set(sensorId, built);
    this.bridge.addBridgedAccessory(built.accessory);
    this.logger.debug(`Added bridged accessory for sensor: ${sensor.displayName}`);
  }

  private publishBridge(republish?: boolean): Promise<void> {
    this.publishing ??= this.runPublishBridge(republish).finally(() => {
      this.publishing = undefined;
    });
    return this.publishing;
  }

  private async runPublishBridge(republish?: boolean): Promise<void> {
    if (this.published) {
      return;
    }

    try {
      const bridgePin = await this.storage.getValue<string>('bridgePin');
      const advertiseAddress = await this.storage.getValue<string>('bridgeAdvertiseAddress');
      const portOverride = this.storage.values.bridgePortOverride;

      if (this.publishedExternalAccessories.has(advertiseAddress!)) {
        throw new Error('Bridge experienced an address collision.');
      }

      this.logger.log(`${republish ? 'Republishing' : 'Publishing'} bridge (${this.advertiser})`);

      this.setupBridge();

      this.bridge!.on(AccessoryEventTypes.LISTENING, (port: number) => {
        this.bridgePort = port;
        this.logger.debug(`Bridge is running on port ${port}`);
        this.logger.log(`Please add the bridge manually in Home app. Setup Code: ${bridgePin}`);
      });

      const addresses = await this.api.coreManager.getServerAddresses();
      const bind = addresses.length ? addresses : ['0.0.0.0'];

      const port = portOverride === 0 && this.bridgePort === undefined ? undefined : portOverride || this.bridgePort;

      const publishInfo: PublishInfo = {
        username: advertiseAddress!,
        pincode: bridgePin!,
        category: Categories.BRIDGE,
        port,
        bind,
        addIdentifyingMaterial: true,
        advertiser: this.advertiser,
      };

      await this.bridge!.publish(publishInfo);

      this.publishedExternalAccessories.set(advertiseAddress!, this.bridge!);
      this.published = true;
    } catch (error) {
      this.logger.error('Error publishing bridge', error);
      await this.teardown(true);
    }
  }

  private setupBridge(): void {
    const republishId = this.storage.values.bridgeRepublishId;
    const bridge = new Bridge('camera.ui Bridge', uuid.generate(`${republishId}-cameraui-bridge`));

    const accessoryInformation = bridge.getService(Service.AccessoryInformation);
    accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, 'camera.ui');
    accessoryInformation?.setCharacteristic(Characteristic.Model, 'camera.ui Bridge');

    for (const sensor of this.sensors.values()) {
      const built = buildSensorAccessory(sensor, republishId, this.logger);
      if (!built) {
        continue;
      }
      this.entries.set(sensor.id, built);
      bridge.addBridgedAccessory(built.accessory, true);
    }

    this.bridge = bridge;
  }
}

export function generateBridgeAddress(republishId: string): MacAddress {
  return mac.generate(`${republishId}-cameraui-bridge`);
}
