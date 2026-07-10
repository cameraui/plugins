import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { Camera } from './camera.js';
import { TuyaCloudApiClient } from './tuya/cloudApi.js';
import { TuyaSmartApiClient } from './tuya/smartApi.js';
import { AVAILABLE_REGIONS } from './tuya/types.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { Device } from './tuya/types.js';
import type { TuyaConfig } from './types.js';

export default class TuyaPlugin extends BasePlugin<TuyaConfig> implements DiscoveryProvider {
  private tuyaCameras = new Map<string, Camera>();

  private discoveredTuyaDevices = new Map<string, Device>();

  private existingCameras = new Map<string, CameraDevice>();

  private connectPromise: Promise<void> | null = null;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<TuyaConfig>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: 'email',
        title: 'Email',
        format: 'email',
        description: 'Email of your Tuya / Smart Life account.',
        required: true,
        store: true,
        group: 'Smart API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'password',
        title: 'Password',
        description: 'Password of your Tuya / Smart Life account.',
        format: 'password',
        required: true,
        store: true,
        group: 'Smart API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'clientId',
        title: 'Client ID',
        description: 'Client ID from your Tuya IoT cloud project.',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'clientSecret',
        title: 'Client Secret',
        description: 'Client secret from your Tuya IoT cloud project.',
        format: 'password',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'uid',
        title: 'User ID',
        description: 'Linked-app account UID from your cloud project.',
        required: true,
        store: true,
        group: 'Cloud API',
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'string',
        key: 'region',
        title: 'Region',
        description: 'Data center region of your Tuya account.',
        required: true,
        store: true,
        defaultValue: 'West America',
        enum: AVAILABLE_REGIONS.map((region) => region.description),
        onSet: this.scheduleConnect.bind(this),
      },
      {
        type: 'submit',
        key: 'onLogin',
        title: 'Login',
        description: 'Login to Tuya',
        onClick: this.onFormSubmit.bind(this, 'onLogin'),
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existingCameras.set(camera.id, camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existingCameras.set(camera.id, camera);

    const tuyaDeviceId = camera.nativeId;
    if (!tuyaDeviceId) {
      this.logger.warn(`Camera ${camera.name} has no nativeId, skipping initialization`);
      return;
    }

    const tuyaDevice = this.discoveredTuyaDevices.get(tuyaDeviceId);
    if (tuyaDevice) {
      await this.initializeCamera(tuyaDevice, camera);
    } else {
      this.logger.debug(`Tuya device ${tuyaDeviceId} not yet discovered, will initialize when available`);
    }
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.existingCameras.get(cameraId);
    if (cameraDevice?.nativeId) {
      const cameraController = this.tuyaCameras.get(cameraDevice.nativeId);
      if (cameraController) {
        this.tuyaCameras.delete(cameraDevice.nativeId);
      }

      const tuyaDevice = this.discoveredTuyaDevices.get(cameraDevice.nativeId);
      if (tuyaDevice) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: `tuya:${cameraDevice.nativeId}`,
            name: tuyaDevice.deviceName,
            manufacturer: 'Tuya',
            model: tuyaDevice.category ?? undefined,
          },
        ]);
      }
    }
    this.existingCameras.delete(cameraId);
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    return this.getDiscoveredCameras();
  }

  public async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const tuyaDeviceId = camera.id.replace('tuya:', '');
    const tuyaDevice = this.discoveredTuyaDevices.get(tuyaDeviceId);

    if (!tuyaDevice) {
      throw new Error(`Tuya device ${tuyaDeviceId} not found`);
    }

    const config: CameraConfig = {
      name: tuyaDevice.deviceName,
      nativeId: tuyaDeviceId,
      isCloud: true,
      info: {
        manufacturer: 'Tuya',
        model: tuyaDevice.category,
        serialNumber: tuyaDevice.uuid,
        supportUrl: 'https://support.tuya.com/en/help',
      },
      sources: [
        {
          name: 'P2P',
          role: 'high-resolution',
          useForSnapshot: true,
          hotMode: false,
          preload: false,
        },
      ],
    };

    this.logger.log(`Adopted camera: ${tuyaDevice.deviceName}`);

    return config;
  }

  private async start(): Promise<void> {
    const hasSmartApiCredentials = !!(this.storage.values.email && this.storage.values.password);
    const hasCloudApiCredentials = !!(this.storage.values.clientId && this.storage.values.clientSecret && this.storage.values.uid);
    const hasRegion = !!this.storage.values.region;

    if ((hasSmartApiCredentials || hasCloudApiCredentials) && hasRegion) {
      try {
        await this.scheduleConnect();
      } catch (error: any) {
        this.logger.error('An error occured during connecting:', error);
      }
    }
  }

  private stop(): void {
    this.discoveredTuyaDevices.clear();
    this.tuyaCameras.clear();
  }

  private async scheduleConnect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    try {
      const email = this.storage.values.email;
      const password = this.storage.values.password;
      const clientId = this.storage.values.clientId;
      const clientSecret = this.storage.values.clientSecret;
      const uid = this.storage.values.uid;
      const region = AVAILABLE_REGIONS.find((r) => r.description === this.storage.values.region);

      if (!region) {
        this.logger.error('Invalid region selected. Please select a valid region.');
        return;
      }

      const devices: Device[] = [];
      const useSmartApi = !!(email && password);
      const useCloudApi = !!(clientId && clientSecret && uid);

      if (!useSmartApi && !useCloudApi) {
        this.logger.error('No valid credentials provided. Please provide either Tuya Smart API or Tuya Cloud API credentials.');
        return;
      }

      if (useSmartApi) {
        const smartApi = new TuyaSmartApiClient(region.host, email, password);
        await smartApi.login();

        const devs = await smartApi.getDeviceList();
        for (const device of devs) {
          const deviceExist = devices.some((d) => d.deviceId === device.deviceId);
          if (!deviceExist) {
            devices.push(device);
          }
        }
      }

      if (useCloudApi) {
        const cloudApi = new TuyaCloudApiClient(region.cloudHost, uid, clientId, clientSecret);
        await cloudApi.login();

        const devs = await cloudApi.getDevices();
        for (const device of devs) {
          const deviceExist = devices.some((d) => d.deviceId === device.deviceId);
          if (!deviceExist) {
            devices.push(device);
          }
        }
      }

      await this.updateDiscoveredDevices(devices);
    } catch (error: any) {
      this.logger.error('An error occured during connecting:', error);
    }
  }

  private async onFormSubmit(actionId: string, values: TuyaConfig): Promise<FormSubmitResponse | void> {
    switch (actionId) {
      case 'onLogin':
        try {
          const email = values.email ?? this.storage.values.email;
          const password = values.password ?? this.storage.values.password;
          const clientId = values.clientId ?? this.storage.values.clientId;
          const clientSecret = values.clientSecret ?? this.storage.values.clientSecret;
          const uid = values.uid ?? this.storage.values.uid;
          const region = AVAILABLE_REGIONS.find((r) => r.description === (values.region ?? this.storage.values.region));

          if (!region) {
            return { toast: { message: 'Invalid region selected. Please select a valid region.', type: 'error' } };
          }

          const useSmartApi = !!(email && password);
          const useCloudApi = !!(clientId && clientSecret && uid);

          if (!useSmartApi && !useCloudApi) {
            return { toast: { message: 'Please provide either Tuya Smart API or Tuya Cloud API credentials.', type: 'error' } };
          }

          if (useSmartApi) {
            const smartApi = new TuyaSmartApiClient(region.host, email, password);
            await smartApi.login();
          }

          if (useCloudApi) {
            const cloudApi = new TuyaCloudApiClient(region.cloudHost, uid, clientId, clientSecret);
            await cloudApi.login();
          }

          await this.scheduleConnect();

          return { toast: { message: 'Successfully logged in to Tuya', type: 'success' } };
        } catch (error: any) {
          const message = `Failed to Authenticate. Reason: ${error.message}`;
          this.logger.error(message);

          return { toast: { message, type: 'error' } };
        }
    }
  }

  private async updateDiscoveredDevices(devices: Device[]): Promise<void> {
    for (const device of devices) {
      const tuyaDeviceId = device.deviceId;
      this.discoveredTuyaDevices.set(tuyaDeviceId, device);

      await this.initializeExistingCamera(device);
    }

    await this.pushDiscoveredCameras();
  }

  private async initializeExistingCamera(device: Device): Promise<void> {
    const tuyaDeviceId = device.deviceId;

    if (this.tuyaCameras.has(tuyaDeviceId)) {
      return;
    }

    const cameraDevice = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === tuyaDeviceId);

    if (cameraDevice) {
      await this.initializeCamera(device, cameraDevice);
    }
  }

  private async initializeCamera(device: Device, cameraDevice: CameraDevice): Promise<void> {
    const tuyaDeviceId = device.deviceId;

    if (this.tuyaCameras.has(tuyaDeviceId)) {
      return;
    }

    const camera = new Camera(this.storage, cameraDevice, device, this.api);
    await camera.initialize();

    this.tuyaCameras.set(tuyaDeviceId, camera);
    this.logger.debug(`Initialized camera: ${device.deviceName}`);
  }

  private async pushDiscoveredCameras(): Promise<void> {
    const discovered = this.getDiscoveredCameras();

    if (discovered.length > 0) {
      this.logger.debug(`Found ${discovered.length} new camera(s), pushing to discovery...`);
      await this.api.deviceManager.pushDiscoveredCameras(discovered);
    }
  }

  private getDiscoveredCameras(): DiscoveredCamera[] {
    const discovered: DiscoveredCamera[] = [];

    for (const [tuyaDeviceId, device] of this.discoveredTuyaDevices) {
      const existingCamera = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === tuyaDeviceId);
      if (existingCamera) {
        continue;
      }

      discovered.push({
        id: `tuya:${tuyaDeviceId}`,
        name: device.deviceName,
        manufacturer: 'Tuya',
        model: device.category.toUpperCase(),
      });
    }

    return discovered;
  }
}
