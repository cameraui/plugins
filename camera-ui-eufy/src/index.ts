import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { installNativeLogging } from '@seydx/rtsp';
import { Device, EufySecurity, P2PConnectionType } from 'eufy-security-client';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Camera } from './camera.js';
import { COUNTRIES, getCountryCode, PromiseTimeout } from './utils.js';

import type { NativeLoggingHandle } from '@seydx/rtsp';

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
import type { Camera as EufyCamera, EufySecurityConfig, Logger, LoginOptions } from 'eufy-security-client';
import type { DeviceContainer, EufyConnectionResponse, EufyHome, StorageValues } from './types.js';

export default class Eufy extends BasePlugin<StorageValues> implements DiscoveryProvider {
  /** Cameras already added to camera.ui (cameraDeviceId -> CameraDevice) */
  private existingCameras = new Map<string, CameraDevice>();

  /** Eufy camera controllers (eufyCameraId -> Camera) */
  private eufyCameras = new Map<string, Camera>();

  /** Eufy devices discovered from Eufy API (eufyCameraId -> EufyCamera) */
  private discoveredEufyDevices = new Map<string, EufyCamera>();

  /** Eufy client connections */
  private eufyClients = new Map<string, EufySecurity>();

  /** Tracks cameras being initialized (race condition guard) */
  private pendingCameras = new Set<string>();

  /** Bridges FFmpeg/node-av logs (in this plugin's own process) into our logger. */
  private nativeLogging?: NativeLoggingHandle;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);

    this.nativeLogging = installNativeLogging(this.logger);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'boolean',
        key: 'debug',
        title: 'Debug',
        description: 'Enable debug mode',
        required: false,
        defaultValue: false,
        store: true,
      },
      {
        type: 'string',
        key: 'name',
        title: 'Home Name',
        description: 'Name of the home',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'username',
        title: 'Login Email',
        description: 'Email for the login',
        format: 'email',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'password',
        title: 'Login Password',
        description: 'Password for the login',
        format: 'password',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'country',
        title: 'Country',
        description: 'Country for the login',
        required: true,
        store: true,
        defaultValue: 'United States',
        enum: Object.values(COUNTRIES),
      },
      {
        type: 'string',
        key: 'deviceName',
        title: 'Device Name',
        description: 'Name of the device',
        required: false,
        defaultValue: 'camera.ui',
        store: true,
      },
      {
        type: 'number',
        key: 'maxLiveStreamDuration',
        title: 'Max Live Stream Duration',
        description: 'Max duration of live stream in seconds',
        required: false,
        defaultValue: 86400,
        minimum: 60,
        maximum: 86400,
        store: true,
      },
      {
        type: 'array',
        key: 'ignoreDevices',
        title: 'Ignore Devices',
        description: 'List of devices to ignore',
        required: false,
        items: {
          type: 'string',
          title: 'Device',
          description: 'Device to ignore',
        },
        defaultValue: [],
        store: true,
      },
      {
        type: 'submit',
        key: 'onLogin',
        title: 'Login',
        description: 'Login to Eufy',
        color: 'success',
        onClick: this.onFormSubmit.bind(this, 'onLogin'),
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.existingCameras.set(camera.id, camera);
      // Note: onCameraAdded will be called when Eufy API connects and device is available
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.existingCameras.set(camera.id, camera);

    // Find the corresponding Eufy device by nativeId
    const eufyCameraId = camera.nativeId;
    if (!eufyCameraId) {
      this.logger.warn(`Camera ${camera.name} has no nativeId, skipping initialization`);
      return;
    }

    const eufyDevice = this.discoveredEufyDevices.get(eufyCameraId);
    if (eufyDevice) {
      // Eufy device is available, initialize it
      await this.initializeCamera(eufyDevice, camera);
    } else {
      this.logger.debug(`Eufy device ${eufyCameraId} not yet discovered, will initialize when available`);
    }
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.existingCameras.get(cameraId);
    if (cameraDevice?.nativeId) {
      const cameraController = this.eufyCameras.get(cameraDevice.nativeId);
      if (cameraController) {
        try {
          cameraController.eufyDevice.destroy();
        } catch {
          // ignore
        }
        this.eufyCameras.delete(cameraDevice.nativeId);
      }

      // Push the camera back as discovered immediately
      const eufyDevice = this.discoveredEufyDevices.get(cameraDevice.nativeId);
      if (eufyDevice) {
        await this.api.deviceManager.pushDiscoveredCameras([
          {
            id: `eufy:${cameraDevice.nativeId}`,
            name: eufyDevice.getName(),
            manufacturer: 'Eufy',
            model: eufyDevice.getModel(),
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
    // No additional credentials needed - already logged in via plugin config
    return [];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, _credentials: Record<string, unknown>): Promise<CameraConfig> {
    // Extract eufy camera ID from discovery ID (eufy:SERIAL -> SERIAL)
    const eufyCameraId = camera.id.replace('eufy:', '');
    const eufyDevice = this.discoveredEufyDevices.get(eufyCameraId);

    if (!eufyDevice) {
      throw new Error(`Eufy camera ${eufyCameraId} not found`);
    }

    // Return camera config - backend will create the camera
    const config: CameraConfig = {
      name: eufyDevice.getName(),
      nativeId: eufyDevice.getSerial(),
      isCloud: true,
      info: {
        manufacturer: 'Eufy',
        model: eufyDevice.getModel(),
        hardware: eufyDevice.getHardwareVersion(),
        serialNumber: eufyDevice.getSerial(),
        firmwareVersion: eufyDevice.getSoftwareVersion(),
        supportUrl: 'https://support.eufy.com/',
      },
      sources: [
        {
          name: 'P2P',
          role: 'high-resolution',
          useForSnapshot: true,
          hotMode: false,
          preload: false,
          prebuffer: false,
        },
      ],
    };

    this.logger.log(`Adopted camera: ${eufyDevice.getName()}`);

    return config;
  }

  private async start(): Promise<void> {
    if (this.storage.values.username && this.storage.values.password && this.storage.values.country && this.storage.values.deviceName) {
      try {
        await this.connectHome(this.storage.values);
      } catch (error: any) {
        this.logger.error(this.storage.values.name, 'An error occured during connecting to home:', error);
      }
    }
  }

  private stop(): void {
    this.eufyClients.forEach((eufyClient) => {
      try {
        if (eufyClient.isConnected()) {
          eufyClient.close();
        }
      } catch {
        //
      }
    });

    this.discoveredEufyDevices.forEach((eufyDevice) => {
      try {
        eufyDevice.destroy();
      } catch {
        //
      }
    });

    this.eufyClients.clear();
    this.discoveredEufyDevices.clear();
    this.eufyCameras.clear();

    this.nativeLogging?.dispose();
    this.nativeLogging = undefined;
  }

  private closeClient(home: EufyHome): void {
    const eufyClient = this.eufyClients.get(home.name);

    if (eufyClient) {
      try {
        if (eufyClient.isConnected()) {
          eufyClient.close();
        }
      } catch {
        // ignore
      } finally {
        this.eufyClients.delete(home.name);
      }
    }
  }

  private async connectHome(home: EufyHome): Promise<void> {
    let eufyClient: EufySecurity | undefined;

    const connectPromise = () =>
      new Promise<void>((resolve, reject) => {
        if (!eufyClient) {
          reject(new Error('No client'));
          return;
        }

        if (eufyClient.isConnected()) {
          resolve();
          return;
        }

        eufyClient.once('connect', () => {
          resolve();
        });

        eufyClient.once('connection error', (error: Error) => {
          reject(error);
        });

        eufyClient.once('close', () => {
          reject(new Error('Connection closed'));
        });
      });

    try {
      eufyClient = await this.getClient(home);
      this.eufyClients.set(home.name, eufyClient);

      eufyClient.on('device added', this.deviceAdded.bind(this, home, eufyClient));
      eufyClient.on('device removed', this.deviceRemoved.bind(this, home));

      eufyClient.on('push connect', () => {
        this.logger.debug(home.name, 'Push Connected!');
      });

      eufyClient.on('push close', () => {
        this.logger.debug(home.name, 'Push Closed!');
      });

      eufyClient.on('connect', () => {
        this.logger.debug(home.name, 'Connected!');
      });

      eufyClient.on('close', () => {
        this.logger.debug(home.name, 'Closed!');
      });

      eufyClient.on('connection error', async (error: Error) => {
        this.logger.debug(home.name, `Error: ${error}`);
        this.closeClient(home);
      });

      eufyClient.once('captcha request', async () => {
        this.logger.error(home.name, 'CAPTCHA Required! Please re-authenticate via UI and restart Plugin!');
        this.closeClient(home);
      });

      eufyClient.on('tfa request', async () => {
        this.logger.error(home.name, 'Two-Factor Authentication (2FA) Requested! Please re-authenticate via UI and restart Plugin!');
        this.closeClient(home);
      });
    } catch (error: any) {
      this.logger.error(home.name, 'Error while setup:', error);
      this.logger.error(home.name, 'Not connected cant continue!');
      return;
    }

    try {
      if (!eufyClient.isConnected()) {
        await eufyClient.connect();
      }
    } catch (e) {
      this.logger.error(home.name, 'Error authenticating Eufy:', e);
      return;
    }

    try {
      await PromiseTimeout(connectPromise.bind(this), 5000, undefined, 'Connection timed out');

      const devices = await eufyClient.getDevices();
      for (const device of devices) {
        await this.deviceAdded(home, eufyClient, device);
      }
    } catch (error: any) {
      this.logger.error(home.name, 'Error while connecting:', error);
      return;
    }

    home.maxLiveStreamDuration = home.maxLiveStreamDuration ?? 86400;
    if (home.maxLiveStreamDuration > 86400) {
      home.maxLiveStreamDuration = 86400;
      this.logger.warn(home.name, 'Your maximum livestream duration value is too large. Since this can cause problems it was reset to 86400 seconds (1 day maximum).');
    } else if (home.maxLiveStreamDuration < 10) {
      home.maxLiveStreamDuration = 10;
      this.logger.warn(home.name, 'Your maximum livestream duration value is too small. Since this can cause problems it was reset to 10 seconds (10 seconds minimum).');
    }

    eufyClient.setCameraMaxLivestreamDuration(home.maxLiveStreamDuration);
    this.logger.debug(home.name, `maxLiveStreamDuration: ${eufyClient.getCameraMaxLivestreamDuration()}`);
  }

  private async deviceAdded(home: EufyHome, eufyClient: EufySecurity, device: Device) {
    try {
      if ((home.ignoreDevices ?? []).includes(device.getSerial())) {
        this.logger.debug(home.name, `${device.getName()}: Device ignored`);
        return;
      }

      const deviceContainer: DeviceContainer = {
        deviceIdentifier: {
          uniqueId: device.getSerial(),
          displayName: 'DEVICE_' + device.getName(),
          type: device.getDeviceType(),
        },
        eufyDevice: device,
      };

      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.processDiscoveredDevice(home, eufyClient, deviceContainer);
    } catch (error: any) {
      this.logger.error(home.name, 'Failed to process device:', error);
    }
  }

  private async processDiscoveredDevice(home: EufyHome, eufyClient: EufySecurity, deviceContainer: DeviceContainer) {
    const isCamera: boolean = deviceContainer.eufyDevice instanceof Device ? deviceContainer.eufyDevice.isCamera() : false;

    if (!isCamera) {
      this.logger.debug(home.name, `Device ${deviceContainer.deviceIdentifier.displayName} is not a camera, skipping...`);
      return;
    }

    const eufyDevice = deviceContainer.eufyDevice as EufyCamera;
    const eufyCameraId = eufyDevice.getSerial();

    // Skip if already discovered OR currently being processed (race condition guard)
    if (this.discoveredEufyDevices.has(eufyCameraId) || this.pendingCameras.has(eufyCameraId)) {
      this.logger.debug(home.name, `Camera ${eufyDevice.getName()} already discovered or pending, skipping...`);
      return;
    }

    // Mark as pending BEFORE any async operation
    this.pendingCameras.add(eufyCameraId);

    try {
      // Store discovered device
      this.discoveredEufyDevices.set(eufyCameraId, eufyDevice);

      // Try to initialize if camera already exists in camera.ui
      const cameraDevice = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === eufyCameraId);

      if (cameraDevice) {
        await this.initializeCamera(eufyDevice, cameraDevice, home, eufyClient);
      }

      // Push to discovery manager for new cameras
      await this.pushDiscoveredCameras();
    } catch (error: any) {
      this.logger.error(home.name, 'Error in processDiscoveredDevice', error);
    } finally {
      // Always remove from pending, even on error
      this.pendingCameras.delete(eufyCameraId);
    }
  }

  private async initializeCamera(eufyDevice: EufyCamera, cameraDevice: CameraDevice, home?: EufyHome, eufyClient?: EufySecurity): Promise<void> {
    const eufyCameraId = eufyDevice.getSerial();

    // Skip if already initialized
    if (this.eufyCameras.has(eufyCameraId)) {
      return;
    }

    // We need home and eufyClient for full initialization
    if (!home || !eufyClient) {
      // Try to get from storage
      home = this.storage.values;
      eufyClient = this.eufyClients.get(home.name);
    }

    if (!eufyClient) {
      this.logger.warn(`Cannot initialize camera ${cameraDevice.name}: Eufy client not available`);
      return;
    }

    const camera = new Camera(this, home, eufyClient, eufyDevice, cameraDevice);
    await camera.initialize();

    this.eufyCameras.set(eufyCameraId, camera);
    this.logger.debug(`Initialized camera: ${eufyDevice.getName()}`);
  }

  private async deviceRemoved(home: EufyHome, device: Device) {
    const serial = device.getSerial();
    this.logger.debug(home.name, `A device has been removed: ${device.getName()}`);

    // Clean up internal state
    this.discoveredEufyDevices.delete(serial);
    this.eufyCameras.delete(serial);

    // Note: We no longer call deviceManager.removeCamera()
    // The camera should be removed via the UI if needed
  }

  private async pushDiscoveredCameras(): Promise<void> {
    const discovered = this.getDiscoveredCameras();

    if (discovered.length > 0) {
      this.logger.debug(`Found ${discovered.length} new camera(s), pushing to discovery...`);
      await this.api.deviceManager.pushDiscoveredCameras(discovered);
    }
  }

  /**
   * Get discovered cameras (not yet added to camera.ui)
   */
  private getDiscoveredCameras(): DiscoveredCamera[] {
    const discovered: DiscoveredCamera[] = [];

    for (const [eufyCameraId, eufyDevice] of this.discoveredEufyDevices) {
      // Skip cameras that are already added to camera.ui
      const existingCamera = Array.from(this.existingCameras.values()).find((camera) => camera.nativeId === eufyCameraId);
      if (existingCamera) {
        continue;
      }

      discovered.push({
        id: `eufy:${eufyCameraId}`,
        name: eufyDevice.getName(),
        manufacturer: 'Eufy',
        model: eufyDevice.getModel() ?? undefined,
      });
    }

    return discovered;
  }

  private tryLogin(home: EufyHome & { twoFactorCode?: string } & { captchaCode?: string; captchaId: string }): Promise<EufyConnectionResponse> {
    return new Promise(async (resolve, reject) => {
      try {
        let connected = false;

        // Close existing client to ensure fresh login with new credentials
        this.closeClient(home);

        const eufyClient = await this.getClient(home);

        eufyClient.once('connect', () => {
          this.logger.debug(home.name, 'Connected!');

          connected = true;
          resolve({ connected: true });
        });

        eufyClient.once('close', () => {
          this.logger.debug(home.name, 'Closed!');

          if (!connected) {
            return reject(new Error('Connection failed'));
          }

          resolve({ connected: true });
        });

        eufyClient.once('connection error', async (error: Error) => {
          this.logger.debug(home.name, 'Connection Error:', error);

          reject(error);
        });

        eufyClient.once('captcha request', async (id: string, captcha: string) => {
          this.logger.debug(home.name, 'CAPTCHA Required!', id, captcha);

          resolve({ connected: false, isCaptcha: { id, captcha } });
        });

        eufyClient.once('tfa request', async () => {
          this.logger.debug(home.name, 'Two-Factor Authentication (2FA) Requested!');

          resolve({ connected: false, is2FA: true });
        });

        const loginOptions: LoginOptions | undefined =
          (home.captchaCode && home.captchaId) || home.twoFactorCode
            ? {
                force: true,
                verifyCode: home.twoFactorCode,
                captcha: home.captchaCode && home.captchaId ? { captchaId: home.captchaId, captchaCode: home.captchaCode } : undefined,
              }
            : undefined;

        if (loginOptions) {
          this.logger.debug(home.name, 'Trying to connect with options:', loginOptions);
        }

        await eufyClient.connect(loginOptions);
      } catch (error: any) {
        reject(error);
      }
    });
  }

  private async getClient(home: EufyHome): Promise<EufySecurity> {
    let eufyClient = this.eufyClients.get(home.name);

    if (!eufyClient) {
      const logger: Logger = {
        info: (message: any, ...args: any[]) => {
          this.logger.log(home.name, message, ...args);
        },
        warn: (message: any, ...args: any[]) => {
          this.logger.warn(home.name, message, ...args);
        },
        error: (message: any, ...args: any[]) => {
          this.logger.error(home.name, message, ...args);
        },
        fatal: (message: any, ...args: any[]) => {
          this.logger.error(home.name, message, ...args);
        },
        debug: (message: any, ...args: any[]) => {
          if (home.debug) {
            this.logger.debug(home.name, message, ...args);
          }
        },
        trace: (message: any, ...args: any[]) => {
          if (home.debug) {
            this.logger.debug(home.name, message, ...args);
          }
        },
      };

      const homeKey = home.name?.replace(/[^\w.-]/g, '_') || 'default';
      const persistentDir = resolve(this.api.storagePath, homeKey);
      mkdirSync(persistentDir, { recursive: true });

      const eufyConfig: EufySecurityConfig = {
        username: home.username,
        password: home.password,
        country: getCountryCode(home.country),
        trustedDeviceName: home.deviceName,
        language: 'en',
        persistentDir,
        p2pConnectionSetup: P2PConnectionType.QUICKEST,
        pollingIntervalMinutes: 10,
        eventDurationSeconds: 10,
      };

      eufyClient = await EufySecurity.initialize(eufyConfig, logger);
      this.eufyClients.set(home.name, eufyClient);
    }

    return eufyClient;
  }

  private async refreshConfig(home: EufyHome): Promise<void> {
    if ('twoFactorCode' in home) {
      delete home.twoFactorCode;
    }

    if ('captcha' in home) {
      delete home.captcha;
    }

    if ('captchaCode' in home) {
      delete home.captchaCode;
    }

    if ('captchaId' in home) {
      delete home.captchaId;
    }

    this.storage.values = home;

    await this.storage.save();
  }

  private async onFormSubmit(
    actionId: string,
    home: EufyHome & { twoFactorCode?: string } & { captchaCode?: string; captchaId: string },
  ): Promise<FormSubmitResponse | undefined> {
    switch (actionId) {
      case 'onLogin':
        try {
          const connectionResponse = await this.tryLogin(home);

          const eufyClient = this.eufyClients.get(home.name);
          eufyClient?.removeAllListeners();

          if (connectionResponse.connected) {
            this.refreshConfig(home);
            this.connectHome(home);
          }

          const formResponse = this.createFormResponse(connectionResponse);

          return formResponse;
        } catch (error: any) {
          const message = `Failed to Authenticate. Reason: ${error.message}`;
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

  private createFormResponse(connectionResponse: EufyConnectionResponse): FormSubmitResponse {
    const formResponse: FormSubmitResponse = {
      toast: {
        type: 'success',
        message: 'Logged in!',
      },
    };

    if (connectionResponse.is2FA) {
      formResponse.schema = [
        {
          type: 'string',
          key: 'twoFactorCode',
          title: 'Two-Factor Code',
          description: 'Enter the two-factor code',
          required: true,
        },
      ];

      formResponse.toast = {
        message: 'Two-Factor Authentication (2FA) Required!',
        type: 'warning',
      };
    } else if (connectionResponse.isCaptcha) {
      formResponse.schema = [
        {
          type: 'string',
          key: 'captcha',
          title: 'Captcha',
          description: 'Enter the captcha',
          format: 'image',
          defaultValue: connectionResponse.isCaptcha.captcha,
        },
        {
          type: 'string',
          key: 'captchaCode',
          title: 'Captcha Code',
          description: 'Enter the captcha code',
          required: true,
        },
        {
          type: 'string',
          key: 'captchaId',
          title: 'Captcha ID',
          description: 'Enter the captcha ID',
          hidden: true,
          defaultValue: connectionResponse.isCaptcha.id,
        },
      ];

      formResponse.toast = {
        message: 'CAPTCHA Required!',
        type: 'warning',
      };
    }

    return formResponse;
  }
}
