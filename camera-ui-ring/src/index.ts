import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { createHash, randomBytes } from 'node:crypto';

import { Camera } from './camera.js';
import { RingApi, RingRestClient } from './ring-client-api.js';

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
import type { RingCamera } from './ring-client-api.js';
import type { RingHome, StorageValues } from './types.js';

export default class RingPlugin extends BasePlugin<StorageValues> implements DiscoveryProvider {
  private ringCameras = new Map<string, Camera>();
  private discoveredRingCameras = new Map<string, RingCamera>();
  private existingCameras = new Map<string, CameraDevice>();

  private restClients = new Map<string, RingRestClient>();
  private ringConnections = new Map<string, RingApi>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'string',
        title: 'System ID',
        key: 'systemId',
        description: 'Generated unique ID for this system.',
        hidden: true,
        required: true,
        store: true,
        defaultValue: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
      {
        type: 'string',
        title: 'Control Center Display Name',
        key: 'controlCenterDisplayName',
        description: 'Name shown in the Ring Control Center.',
        hidden: true,
        required: true,
        store: true,
        defaultValue: 'camera.ui',
      },
      {
        type: 'string',
        key: 'name',
        title: 'Home Name',
        description: 'A name for this Ring home.',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'email',
        title: 'Login Email',
        description: 'Email of your Ring account.',
        format: 'email',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'password',
        title: 'Login Password',
        description: 'Password of your Ring account.',
        format: 'password',
        required: true,
        store: true,
      },
      {
        type: 'boolean',
        key: 'polling',
        title: 'Polling',
        description:
          'Regularly refresh device status (battery, light, siren, online state) from Ring. Motion and doorbell events arrive via push either way.',
        required: false,
        defaultValue: true,
        store: true,
        onSet: async (enabled: boolean) => {
          this.logger.log('Polling:', enabled);
          await this.connectHome(this.storage.values);
        },
      },
      {
        type: 'string',
        key: 'token',
        title: 'Refresh Token',
        description: 'Stored Ring authentication token.',
        hidden: true,
        store: true,
      },
      {
        type: 'array',
        key: 'locationIds',
        title: 'Location Ids',
        description: 'Ring locations to load cameras from.',
        store: true,
        opened: true,
        items: {
          type: 'string',
          title: 'Location Id',
          description: 'A single Ring location ID.',
        },
        required: false,
        defaultValue: [],
        onSet: async (locationIds: string[]) => {
          this.logger.log('Location Ids:', locationIds);
          await this.connectHome(this.storage.values);
        },
      },
      {
        type: 'submit',
        key: 'onLogin',
        title: 'Login',
        description: 'Sign in to your Ring account.',
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

    const ringCameraId = camera.nativeId;
    if (!ringCameraId) {
      this.logger.warn(`Camera ${camera.name} has no nativeId, skipping initialization`);
      return;
    }

    const ringCamera = this.discoveredRingCameras.get(ringCameraId);
    if (ringCamera) {
      await this.initializeCamera(ringCamera, camera);
    } else {
      this.logger.debug(`Ring camera ${ringCameraId} not yet discovered, will initialize when available`);
    }
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.existingCameras.get(cameraId);
    if (cameraDevice?.nativeId) {
      const cameraController = this.ringCameras.get(cameraDevice.nativeId);
      if (cameraController) {
        cameraController.ringCamera.disconnect();
        this.ringCameras.delete(cameraDevice.nativeId);
      }

      const ringCamera = this.discoveredRingCameras.get(cameraDevice.nativeId);
      if (ringCamera) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: `ring:${cameraDevice.nativeId}`,
            name: ringCamera.name,
            manufacturer: 'Ring',
            model: ringCamera.model ?? ringCamera.data.kind ?? undefined,
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

  public async onAdoptCamera(camera: DiscoveredCamera, _credentials: Record<string, unknown>): Promise<CameraConfig> {
    const ringCameraId = camera.id.replace('ring:', '');
    const ringCamera = this.discoveredRingCameras.get(ringCameraId);

    if (!ringCamera) {
      throw new Error(`Ring camera ${ringCameraId} not found`);
    }

    const config: CameraConfig = {
      name: ringCamera.name,
      nativeId: ringCamera.id.toString(),
      isCloud: true,
      info: {
        manufacturer: 'Ring',
        model: ringCamera.model ?? '',
        hardware: (ringCamera.data.kind as string) ?? '',
        serialNumber: ringCamera.data.device_id ?? '',
        firmwareVersion: ringCamera.data.health.firmware_version ?? '',
        supportUrl: 'https://support.ring.com/',
      },
      sources: [
        {
          name: 'P2P',
          role: 'high-resolution',
          useForSnapshot: false,
          hotMode: false,
          preload: false,
        },
        {
          name: 'Snapshot',
          role: 'snapshot',
          useForSnapshot: false,
          hotMode: false,
          preload: false,
        },
      ],
    };

    this.logger.log(`Adopted camera: ${ringCamera.name}`);

    return config;
  }

  private async start(): Promise<void> {
    if (this.storage.values.token) {
      try {
        await this.connectHome(this.storage.values);
      } catch (error: any) {
        this.logger.error(this.storage.values.name, 'An error occured during connecting to home:', error);
      }
    }
  }

  private stop(): void {
    this.discoveredRingCameras.clear();
    this.ringCameras.forEach((camera) => camera.ringCamera.disconnect());
    this.ringCameras.clear();
    this.ringConnections.forEach((ringApi) => ringApi.disconnect());
    this.restClients.clear();
    this.ringConnections.clear();
  }

  private async connectHome(home: RingHome): Promise<void> {
    try {
      if (home.token) {
        let api = this.ringConnections.get(home.name);

        if (api) {
          api.disconnect();
          this.ringConnections.delete(home.name);
        }

        const locationIds = home.locationIds?.filter((id) => id);
        const polling = home.polling ?? true;
        const statusPollingSeconds = 5;

        api = new RingApi({
          controlCenterDisplayName: this.storage.values.controlCenterDisplayName,
          refreshToken: home.token,
          ffmpegPath: await this.api.coreManager.getFFmpegPath(),
          locationIds: locationIds?.length ? locationIds : undefined,
          cameraStatusPollingSeconds: polling ? statusPollingSeconds : undefined,
          locationModePollingSeconds: polling ? statusPollingSeconds : undefined,
          avoidSnapshotBatteryDrain: true,
        });

        this.ringConnections.set(home.name, api);

        api.onRefreshTokenUpdated.subscribe(({ newRefreshToken, oldRefreshToken }) => {
          if (!oldRefreshToken) {
            return;
          }

          home.token = newRefreshToken;
          this.refreshConfig(home);
        });

        const ringCameras = await api.getCameras();
        await this.updateDiscoveredCameras(ringCameras);
      } else {
        throw new Error('No refresh token, please login again!');
      }
    } catch (error: any) {
      this.logger.error(home.name, error);
    }
  }

  private async updateDiscoveredCameras(ringCameras: RingCamera[]): Promise<void> {
    for (const ringCamera of ringCameras) {
      const ringCameraId = ringCamera.id.toString();
      this.discoveredRingCameras.set(ringCameraId, ringCamera);

      await this.initializeExistingCamera(ringCamera);
    }

    await this.pushDiscoveredCameras();
  }

  private async initializeExistingCamera(ringCamera: RingCamera): Promise<void> {
    const ringCameraId = ringCamera.id.toString();

    if (this.ringCameras.has(ringCameraId)) {
      return;
    }

    const cameraDevice = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === ringCameraId);

    if (cameraDevice) {
      await this.initializeCamera(ringCamera, cameraDevice);
    }
  }

  private async initializeCamera(ringCamera: RingCamera, cameraDevice: CameraDevice): Promise<void> {
    const ringCameraId = ringCamera.id.toString();

    if (this.ringCameras.has(ringCameraId)) {
      return;
    }

    const camera = new Camera(this.storage, ringCamera, cameraDevice);
    await camera.initialize();
    this.ringCameras.set(ringCameraId, camera);
    this.logger.debug(`Initialized camera: ${ringCamera.name}`);
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

    for (const [ringCameraId, ringCamera] of this.discoveredRingCameras) {
      const existingCamera = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === ringCameraId);
      if (existingCamera) {
        continue;
      }

      discovered.push({
        id: `ring:${ringCameraId}`,
        name: ringCamera.name,
        manufacturer: 'Ring',
        model: ringCamera.model ?? ringCamera.data.kind ?? undefined,
      });
    }

    return discovered;
  }

  private async generateCode(homeName: string, email: string, password: string) {
    this.logger.log(homeName, `Logging in with email '${email}'`);

    const ringClient = new RingRestClient({
      email,
      password,
      controlCenterDisplayName: this.storage.values.controlCenterDisplayName,
      systemId: this.storage.values.systemId,
    });

    this.restClients.set(homeName, ringClient);

    try {
      const { refresh_token } = await ringClient.getCurrentAuth();
      return { refreshToken: refresh_token };
    } catch (error: any) {
      if (ringClient.promptFor2fa) {
        this.logger.log(homeName, ringClient.promptFor2fa);
        return { codePrompt: ringClient.promptFor2fa };
      }

      this.logger.error(homeName, error);
    }
  }

  private async generateToken(homeName: string, email: string, password: string, code: string): Promise<{ refreshToken: string } | undefined> {
    let restClients = this.restClients.get(homeName);

    if (!restClients) {
      restClients = new RingRestClient({
        email,
        password,
        controlCenterDisplayName: this.storage.values.controlCenterDisplayName,
        systemId: this.storage.values.systemId,
      });

      this.restClients.set(homeName, restClients);
    }

    this.logger.log(homeName, `Getting token for ${email} with code ${code}`);

    try {
      const authResponse = await restClients.getAuth(code);
      return { refreshToken: authResponse.refresh_token };
    } catch (error: any) {
      this.logger.error(homeName, 'Incorrect 2fa Code. Please check the code and try again', error);
    }
  }

  private async refreshConfig(home: RingHome): Promise<void> {
    if ('twoFactorCode' in home) {
      delete home.twoFactorCode;
    }

    this.storage.values = home;
    await this.storage.save();
  }

  private async onFormSubmit(actionId: string, home: RingHome & { twoFactorCode?: string }): Promise<FormSubmitResponse | void> {
    switch (actionId) {
      case 'onLogin':
        if (home.twoFactorCode) {
          try {
            const response = await this.generateToken(home.name, home.email, home.password, home.twoFactorCode);

            if (response?.refreshToken) {
              this.restClients.delete(home.name);
              home.token = response.refreshToken;

              this.refreshConfig(home);
              this.connectHome(home);

              const formResponse: FormSubmitResponse = {
                toast: {
                  message: 'Logged in',
                  type: 'success',
                },
              };

              return formResponse;
            } else {
              throw new Error('Failed to Login');
            }
          } catch (error: any) {
            const message = `Failed to Link Account. Reason: ${error.message}. Trying to login again...`;
            this.logger.error(home.name, message);
          }
        }

        try {
          const response = await this.generateCode(home.name, home.email, home.password);

          if (!response) {
            throw new Error('Failed to get code');
          }

          if ('refreshToken' in response) {
            this.restClients.delete(home.name);
            home.token = response.refreshToken;

            this.refreshConfig(home);
            this.connectHome(home);

            const formResponse: FormSubmitResponse = {
              toast: {
                message: 'Logged in!',
                type: 'success',
              },
            };

            return formResponse;
          } else {
            const formResponse: FormSubmitResponse = {
              schema: [
                {
                  type: 'string',
                  key: 'twoFactorCode',
                  title: 'Two-Factor Code',
                  description: 'Code sent to your phone or email.',
                  required: true,
                },
              ],
              toast: {
                message: 'Two-Factor Authentication (2FA) Required!',
                type: 'warning',
              },
            };

            return formResponse;
          }
        } catch (error: any) {
          const message = `Failed to Link Account. Reason: ${error.message}`;
          this.logger.error(home.name, message);

          const formResponse: FormSubmitResponse = {
            toast: {
              message,
              type: 'error',
            },
          };

          return formResponse;
        }
    }
  }
}
