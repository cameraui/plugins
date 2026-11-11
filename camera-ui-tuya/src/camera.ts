import { AVAILABLE_REGIONS } from './tuya/types.js';

import type { CameraDevice, DeviceStorage, LoggerService, PluginAPI, StreamingInterface } from '@camera.ui/sdk';
import type { Device } from './tuya/types.js';
import type { TuyaConfig } from './types.js';

class CameraDeviceImplementations implements StreamingInterface {
  constructor(private camera: Camera) {}

  async streamUrl(_sourceId: string): Promise<string> {
    return this.camera.getStreamUrl();
  }
}

export class Camera {
  public readonly cameraDevice: CameraDevice;

  private readonly api: PluginAPI;
  private readonly storage: DeviceStorage<TuyaConfig>;
  private readonly tuyaCamera: Device;
  private cameraLogger: LoggerService;

  constructor(storage: DeviceStorage<TuyaConfig>, cameraDevice: CameraDevice, tuyaCamera: Device, api: PluginAPI) {
    this.cameraDevice = cameraDevice;
    this.api = api;
    this.storage = storage;
    this.tuyaCamera = tuyaCamera;
    this.cameraLogger = cameraDevice.logger;
  }

  public async initialize(): Promise<void> {
    await this.cameraDevice.implement(new CameraDeviceImplementations(this));
    this.cameraDevice.connect();
  }

  public async getStreamUrl(): Promise<string> {
    const region = AVAILABLE_REGIONS.find((r) => r.description === this.storage.values.region);
    if (!region) {
      throw new Error(`Invalid region: ${this.storage.values.region}`);
    }

    const { uid = '', clientId = '', clientSecret = '', email = '', password = '' } = this.storage.values;

    if (this.tuyaCamera.type === 'cloud') {
      const query = new URLSearchParams({ device_id: this.tuyaCamera.deviceId, uid, client_id: clientId, client_secret: clientSecret });
      return `tuya://${region.cloudHost}?${query}`;
    }

    const query = new URLSearchParams({ device_id: this.tuyaCamera.deviceId, email, password });
    return `tuya://${region.host}?${query}`;
  }
}
