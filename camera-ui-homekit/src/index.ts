import './crypto.js';

import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { resolve } from 'node:path';
import { HAPStorage } from './hap.js';

import { CameraAccessory } from './camera/accessory.js';

import type { CameraDevice, DeviceStorage, LoggerService, PluginAPI } from '@camera.ui/sdk';
import type { Accessory, MacAddress } from './hap.js';

export default class HomeKit extends BasePlugin {
  public publishedExternalAccessories = new Map<MacAddress, Accessory>();

  private readonly cameras = new Map<string, CameraDevice>();
  private accessories = new Map<string, CameraAccessory>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<any>) {
    super(logger, api, storage);

    HAPStorage.setCustomStoragePath(resolve(this.api.storagePath, 'accessories'));

    // this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.configureCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.configureCamera(camera);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    await this.removeCamera(cameraId);
  }

  private async stop(): Promise<void> {
    await Promise.all(Array.from(this.accessories.values()).map((accessory) => accessory.teardown()));
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
}
