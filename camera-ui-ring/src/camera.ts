import { RingBatteryInfo, RingDoorbellTrigger, RingLightControl, RingMotionSensor, RingSirenControl } from './sensors.js';

import type { CameraDevice, DeviceStorage, LoggerService, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { RingCamera } from './ring-client-api.js';
import type { StorageValues } from './types.js';

class CameraDeviceImplementations implements StreamingInterface, SnapshotInterface {
  constructor(
    private cameraDevice: CameraDevice,
    private ringCamera: RingCamera,
    private storage: DeviceStorage<StorageValues>,
    private logger: LoggerService,
  ) {}

  async streamUrl(sourceId: string): Promise<string> {
    const baseUrl = `ring:?camera_id=${this.ringCamera.id}&device_id=${this.ringCamera.data.device_id}&refresh_token=${this.storage.values.token}`;
    const source = this.cameraDevice.sources.find((s) => s._id === sourceId);
    if (source?.name.toLocaleLowerCase() === 'snapshot') {
      return `${baseUrl}&snapshot`;
    }

    return baseUrl;
  }

  async snapshot(_sourceId: string, _forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    try {
      const snapshotBuffer = await this.ringCamera.getSnapshot();
      if (snapshotBuffer.length) {
        return Uint8Array.from(snapshotBuffer).buffer;
      }
    } catch (error) {
      this.logger.error('Failed to get snapshot:', error);
    }
  }
}

export class Camera {
  public readonly cameraDevice: CameraDevice;
  public readonly ringCamera: RingCamera;

  private readonly storage: DeviceStorage<StorageValues>;
  private cameraLogger: LoggerService;

  constructor(storage: DeviceStorage<StorageValues>, ringCamera: RingCamera, cameraDevice: CameraDevice) {
    this.storage = storage;
    this.ringCamera = ringCamera;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;
  }

  public async initialize(): Promise<void> {
    await this.cameraDevice.implement(new CameraDeviceImplementations(this.cameraDevice, this.ringCamera, this.storage, this.cameraLogger));
    await this.initializeSensors();
    this.subscribeToConnectionState();
  }

  private async initializeSensors(): Promise<void> {
    const motionSensor = new RingMotionSensor(this.ringCamera);
    await this.cameraDevice.addSensor(motionSensor);

    if (this.ringCamera.hasBattery) {
      const batterySensor = new RingBatteryInfo(this.ringCamera);
      await this.cameraDevice.addSensor(batterySensor);
    }

    if (this.ringCamera.hasLight) {
      const lightControl = new RingLightControl(this.ringCamera);
      await this.cameraDevice.addSensor(lightControl);
    }

    if (this.ringCamera.hasSiren) {
      const sirenControl = new RingSirenControl(this.ringCamera);
      await this.cameraDevice.addSensor(sirenControl);
    }

    if (this.ringCamera.hasInHomeDoorbell) {
      const doorbellTrigger = new RingDoorbellTrigger(this.ringCamera);
      await this.cameraDevice.addSensor(doorbellTrigger);
    }
  }

  private subscribeToConnectionState(): void {
    // Note: onData fires immediately with initial state
    this.ringCamera.onData.subscribe((data) => {
      // Connection state - use alerts.connection if available, fallback to isOffline
      const isOffline = data.alerts?.connection === 'offline' || this.ringCamera.isOffline;

      if (isOffline && this.cameraDevice.connected) {
        this.cameraDevice.disconnect();
      } else if (!isOffline && !this.cameraDevice.connected) {
        this.cameraDevice.connect();
      }
    });
  }
}
