import './crypto.js';

import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { HAPStorage } from './hap.js';

import { generateBridgeAddress, SensorBridge } from './bridge/bridge.js';
import { CameraAccessory } from './camera/accessory.js';
import { baseAdvertiser } from './constants.js';
import * as mac from './utils/mac.js';
import { isBatteryInfo, isDoorbellTrigger, isLightControl, isMotionSensor, isSirenControl } from './utils/utils.js';

import type { CameraDevice, DeviceStorage, Disposable, JsonSchema, LoggerService, PluginAPI, SensorLike } from '@camera.ui/sdk';
import type { Accessory, MacAddress, MDNSAdvertiser } from './hap.js';
import type { PluginStorageValues } from './types.js';

export default class HomeKit extends BasePlugin<PluginStorageValues> {
  public publishedExternalAccessories = new Map<MacAddress, Accessory>();

  private readonly cameras = new Map<string, CameraDevice>();
  private accessories = new Map<string, CameraAccessory>();

  private sensorBridge = new SensorBridge(this);
  private consumedSensors = new Map<string, SensorLike>();
  private sensorRoutes = new Map<string, { target: 'bridge' | 'cameras'; cameraIds: string[] }>();
  private assignmentSubscriptions = new Map<string, Disposable>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginStorageValues>) {
    super(logger, api, storage);

    HAPStorage.setCustomStoragePath(resolve(this.api.storagePath, 'accessories'));

    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'bridgeQrCode',
        title: 'QR Code',
        description: 'Scan in the Home app to pair the bridge. Standalone sensors appear as accessories behind it.',
        format: 'qrCode',
        group: 'Bridge',
        readonly: true,
        onGet: async () => {
          return this.sensorBridge.setupURI();
        },
      },
      {
        type: 'string',
        key: 'bridgePin',
        title: 'PIN',
        description: 'Manual pairing code for the Home app.',
        group: 'Bridge',
        store: true,
        readonly: true,
        onGet: async () => {
          if (this.storage.values.bridgePin) {
            return this.storage.values.bridgePin;
          }

          return mac.randomPinCode();
        },
      },
      {
        type: 'number',
        key: 'bridgePort',
        title: 'Port',
        description: 'Network port the bridge currently uses.',
        group: 'Bridge',
        readonly: true,
        onGet: async () => {
          return this.sensorBridge.currentPort;
        },
      },
      {
        type: 'number',
        key: 'bridgePortOverride',
        title: 'Override Port',
        description: 'Force a fixed port (0 = automatic).',
        group: 'Bridge',
        store: true,
        required: false,
        defaultValue: 0,
        minimum: 0,
        maximum: 65535,
        onSet: async () => {
          await this.sensorBridge.republish();
        },
      },
      {
        type: 'string',
        key: 'bridgeAdvertiser',
        title: 'mDNS advertiser',
        description: 'Backend used to announce the bridge on the network.',
        group: 'Bridge',
        store: true,
        defaultValue: baseAdvertiser[0],
        enum: baseAdvertiser,
        onSet: async (newAdvertiser: any) => {
          const advertiser = newAdvertiser.split(' (')[0] as MDNSAdvertiser;
          this.logger.log('Changing bridge mDNS advertiser to:', advertiser);
          await this.sensorBridge.republish();
        },
      },
      {
        type: 'string',
        key: 'bridgeAdvertiseAddress',
        title: 'Bridge Username',
        description: 'Generated bridge MAC address.',
        readonly: true,
        hidden: true,
        onGet: async () => {
          return generateBridgeAddress(this.storage.values.bridgeRepublishId);
        },
      },
      {
        type: 'string',
        key: 'bridgeRepublishId',
        title: 'Bridge Republish ID',
        description: 'Internal ID used when republishing the bridge.',
        store: true,
        hidden: true,
        defaultValue: '',
      },
      {
        type: 'button',
        title: 'Reset Bridge Pairing',
        key: 'bridgeReset',
        group: 'Bridge',
        description: 'Unpair the bridge and generate a new pairing code.',
        color: 'danger',
        onSet: async () => {
          this.logger.log('Reset bridge pairing...');
          await this.storage.setValue('bridgeRepublishId', randomBytes(8).toString('hex'));
          await this.storage.setValue('bridgePin', mac.randomPinCode());
          await this.sensorBridge.republish(true);
        },
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.configureCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.configureCamera(camera);
    this.attachRoutedSensors(camera.id);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    await this.removeCamera(cameraId);
  }

  public async configureSensors(sensors: SensorLike[]): Promise<void> {
    for (const sensor of sensors) {
      await this.trackSensor(sensor);
    }
  }

  public async onSensorAdded(sensor: SensorLike): Promise<void> {
    await this.trackSensor(sensor);
  }

  public async onSensorReleased(sensorId: string): Promise<void> {
    this.assignmentSubscriptions.get(sensorId)?.dispose();
    this.assignmentSubscriptions.delete(sensorId);
    this.consumedSensors.delete(sensorId);
    await this.unrouteSensor(sensorId);
  }

  private async stop(): Promise<void> {
    for (const sub of this.assignmentSubscriptions.values()) {
      sub.dispose();
    }
    this.assignmentSubscriptions.clear();

    await Promise.all([this.sensorBridge.teardown(), ...Array.from(this.accessories.values()).map((accessory) => accessory.teardown())]);
  }

  private async configureCamera(cameraDevice: CameraDevice): Promise<void> {
    const cameraAccessory = new CameraAccessory(this, cameraDevice);
    this.cameras.set(cameraDevice.id, cameraDevice);
    this.accessories.set(cameraDevice.id, cameraAccessory);
  }

  private async removeCamera(cameraId: string) {
    const cameraDevice = this.cameras.get(cameraId);

    if (cameraDevice) {
      await this.accessories.get(cameraId)?.teardown(true);

      this.cameras.delete(cameraId);
      this.accessories.delete(cameraId);
    }
  }

  private async trackSensor(sensor: SensorLike): Promise<void> {
    if (this.consumedSensors.has(sensor.id)) {
      return;
    }

    this.consumedSensors.set(sensor.id, sensor);
    this.assignmentSubscriptions.set(
      sensor.id,
      sensor.onAssignmentChanged.subscribe(() => {
        void this.routeSensor(sensor);
      }),
    );

    await this.routeSensor(sensor);
  }

  private async routeSensor(sensor: SensorLike): Promise<void> {
    await this.unrouteSensor(sensor.id);

    const cameraHardware = (isLightControl(sensor) || isSirenControl(sensor)) && sensor.assignmentLocked;

    if (isBatteryInfo(sensor) || cameraHardware || (isDoorbellTrigger(sensor) && sensor.assignedCameraIds.length)) {
      const cameraIds = [...sensor.assignedCameraIds];
      for (const cameraId of cameraIds) {
        this.accessories.get(cameraId)?.attachSensor(sensor);
      }
      this.sensorRoutes.set(sensor.id, { target: 'cameras', cameraIds });
      return;
    }

    if (isMotionSensor(sensor) && sensor.assignedCameraIds.length) {
      return;
    }

    this.sensorRoutes.set(sensor.id, { target: 'bridge', cameraIds: [] });
    await this.sensorBridge.addSensor(sensor);
  }

  private async unrouteSensor(sensorId: string): Promise<void> {
    const route = this.sensorRoutes.get(sensorId);
    if (!route) {
      return;
    }

    this.sensorRoutes.delete(sensorId);

    if (route.target === 'bridge') {
      await this.sensorBridge.removeSensor(sensorId);
    } else {
      for (const cameraId of route.cameraIds) {
        this.accessories.get(cameraId)?.detachSensor(sensorId);
      }
    }
  }

  private attachRoutedSensors(cameraId: string): void {
    for (const [sensorId, route] of this.sensorRoutes) {
      if (route.target !== 'cameras' || !route.cameraIds.includes(cameraId)) {
        continue;
      }

      const sensor = this.consumedSensors.get(sensorId);
      if (sensor) {
        this.accessories.get(cameraId)?.attachSensor(sensor);
      }
    }
  }
}
