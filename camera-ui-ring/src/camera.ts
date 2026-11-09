import { RingBatteryInfo, RingDoorbellTrigger, RingLightControl, RingMotionSensor, RingSirenControl } from './sensors.js';

import type { CameraDevice, LoggerService, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { RingCamera, RingRestClient } from './ring-client-api.js';

class CameraDeviceImplementations implements StreamingInterface, SnapshotInterface {
  constructor(
    private cameraDevice: CameraDevice,
    private ringCamera: RingCamera,
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
    const query = new URLSearchParams({
      camera_id: this.ringCamera.id.toString(),
      device_id: this.ringCamera.data.device_id,
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

  private readonly restClient: () => RingRestClient | undefined;
  private cameraLogger: LoggerService;

  constructor(restClient: () => RingRestClient | undefined, ringCamera: RingCamera, cameraDevice: CameraDevice) {
    this.restClient = restClient;
    this.ringCamera = ringCamera;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;
  }

  public async initialize(): Promise<void> {
    await this.cameraDevice.implement(new CameraDeviceImplementations(this.cameraDevice, this.ringCamera, this.restClient, this.cameraLogger));
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
    this.ringCamera.onData.subscribe((data) => {
      const isOffline = data.alerts?.connection === 'offline' || this.ringCamera.isOffline;

      if (isOffline && this.cameraDevice.connected) {
        this.cameraDevice.disconnect();
      } else if (!isOffline && !this.cameraDevice.connected) {
        this.cameraDevice.connect();
      }
    });
  }
}
