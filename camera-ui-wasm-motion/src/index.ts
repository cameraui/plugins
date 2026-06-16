import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { WASMMotionSensor } from './sensor.js';

import type { CameraDevice, DeviceStorage, LoggerService, PluginAPI } from '@camera.ui/sdk';

export default class WASMMotion extends BasePlugin {
  private sensors = new Map<string, WASMMotionSensor>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<any>) {
    super(logger, api, storage);

    // this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      await this.addSensorToCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.addSensorToCamera(camera);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const sensor = this.sensors.get(cameraId);
    if (sensor) {
      this.sensors.delete(cameraId);
    }
  }

  private async stop(): Promise<void> {
    this.sensors.clear();
  }

  private async addSensorToCamera(camera: CameraDevice): Promise<void> {
    const sensor = new WASMMotionSensor();

    if (!sensor.isAvailable) {
      this.logger.error('WASM motion detector not available');
      return;
    }

    await camera.addSensor(sensor);
    this.sensors.set(camera.id, sensor);
  }
}
