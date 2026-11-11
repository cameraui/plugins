import { RingBatteryInfo, RingDoorbellTrigger, RingLightControl, RingMotionSensor, RingSirenControl } from './sensors.js';

import type { CameraDevice, LoggerService, Sensor, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { RingCamera, RingRestClient } from './ring-client-api.js';

class CameraDeviceImplementations implements StreamingInterface, SnapshotInterface {
  constructor(
    private cameraDevice: CameraDevice,
    private ringCamera: () => RingCamera,
    private restClient: () => RingRestClient | undefined,
    private logger: LoggerService,
  ) {}

  async streamUrl(sourceId: string): Promise<string> {
    const restClient = this.restClient();
    if (!restClient) {
      throw new Error('Not connected to Ring');
    }

    // go2rtc only gets the access token: a session of its own would replace ours and stop the push notifications
    const { access_token } = await restClient.getCurrentAuth();
    const { hid } = JSON.parse(Buffer.from(restClient.refreshToken!, 'base64').toString()) as { hid: string };
    const ringCamera = this.ringCamera();
    const query = new URLSearchParams({
      camera_id: ringCamera.id.toString(),
      device_id: ringCamera.data.device_id,
      access_token,
      hardware_id: hid,
    });

    const source = this.cameraDevice.sources.find((s) => s._id === sourceId);
    if (source?.name.toLocaleLowerCase() === 'snapshot') {
      query.set('snapshot', '');
    }

    return `ring:?${query}`;
  }

  async snapshot(_sourceId: string, _forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    try {
      const snapshotBuffer = await this.ringCamera().getSnapshot();
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
  public ringCamera: RingCamera;

  private readonly restClient: () => RingRestClient | undefined;
  private cameraLogger: LoggerService;
  private sensorIds: string[] = [];
  private dataSubscription?: { unsubscribe(): void };

  constructor(restClient: () => RingRestClient | undefined, ringCamera: RingCamera, cameraDevice: CameraDevice) {
    this.restClient = restClient;
    this.ringCamera = ringCamera;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;
  }

  public async initialize(): Promise<void> {
    await this.cameraDevice.implement(new CameraDeviceImplementations(this.cameraDevice, () => this.ringCamera, this.restClient, this.cameraLogger));
    await this.attach();
  }

  public async bind(ringCamera: RingCamera): Promise<void> {
    await this.unbind();
    this.ringCamera = ringCamera;
    await this.attach();
  }

  public async unbind(): Promise<void> {
    this.dataSubscription?.unsubscribe();
    this.dataSubscription = undefined;
    this.ringCamera.disconnect();

    await Promise.all(this.sensorIds.map((sensorId) => this.cameraDevice.removeSensor(sensorId)));
    this.sensorIds = [];
    await this.cameraDevice.disconnect();
  }

  private async attach(): Promise<void> {
    await this.initializeSensors();
    this.subscribeToConnectionState();
  }

  private async initializeSensors(): Promise<void> {
    await this.addSensor(new RingMotionSensor(this.ringCamera));
    if (this.ringCamera.hasBattery) await this.addSensor(new RingBatteryInfo(this.ringCamera));
    if (this.ringCamera.hasLight) await this.addSensor(new RingLightControl(this.ringCamera));
    if (this.ringCamera.hasSiren) await this.addSensor(new RingSirenControl(this.ringCamera));
    if (this.ringCamera.hasInHomeDoorbell) await this.addSensor(new RingDoorbellTrigger(this.ringCamera));
  }

  private async addSensor<T extends object>(sensor: Sensor<T>): Promise<void> {
    await this.cameraDevice.addSensor(sensor);
    this.sensorIds.push(sensor.id);
  }

  private subscribeToConnectionState(): void {
    this.dataSubscription = this.ringCamera.onData.subscribe((data) => {
      const isOffline = data.alerts?.connection === 'offline' || this.ringCamera.isOffline;

      if (isOffline && this.cameraDevice.connected) {
        this.cameraDevice.disconnect();
      } else if (!isOffline && !this.cameraDevice.connected) {
        this.cameraDevice.connect();
      }
    });
  }
}
