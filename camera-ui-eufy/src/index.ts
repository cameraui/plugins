import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { LoginStatus } from '@mega-yfue/eufy-sdk';
import { installNativeLogging } from '@seydx/rtsp';

import { accountKey, EufyAccount, isCameraRecord } from './account.js';
import { EufyCamera } from './camera.js';
import { createStandaloneSensor, discoverStandaloneSensors } from './standalone.js';
import { COUNTRIES, errorMessage } from './utils.js';

import type {
  AdoptedSensor,
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveredSensor,
  DiscoveryProvider,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
  Sensor,
  SensorDiscoveryProvider,
} from '@camera.ui/sdk';
import type { AnyDeviceEvent, EufyDevice, LoginResult } from '@mega-yfue/eufy-sdk';
import type { NativeLoggingHandle } from '@seydx/rtsp';
import type { AccountCredentials } from './account.js';
import type { StandaloneSensor } from './standalone.js';
import type { EufyContext, StorageValues } from './types.js';

const DEFAULT_MAX_LIVE_STREAM_SECONDS = 86_400;

export default class Eufy extends BasePlugin<StorageValues> implements DiscoveryProvider, SensorDiscoveryProvider {
  private account?: EufyAccount;
  private pendingLogin?: EufyAccount;
  private pendingStep?: 'captcha' | 'twoFactor';
  private devicesLoaded = false;
  private ffmpegPath?: string;
  private nativeLogging?: NativeLoggingHandle;

  private readonly records = new Map<string, EufyDevice>();
  private readonly cameraDevices = new Map<string, CameraDevice>();
  private readonly cameras = new Map<string, EufyCamera>();
  private readonly standalone = new Map<string, StandaloneSensor>();

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);

    this.nativeLogging = installNativeLogging(this.logger);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));
  }

  public get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'boolean',
        key: 'debug',
        title: 'Debug',
        description: 'Log what the Eufy connection and the streams are doing.',
        required: false,
        defaultValue: false,
        store: true,
      },
      {
        type: 'string',
        key: 'username',
        title: 'Email',
        description: 'Email of your Eufy account.',
        format: 'email',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'password',
        title: 'Password',
        description: 'Password of your Eufy account.',
        format: 'password',
        required: true,
        store: true,
      },
      {
        type: 'string',
        key: 'country',
        title: 'Country',
        description: 'Country of your Eufy account.',
        required: true,
        store: true,
        defaultValue: 'United States',
        enum: Object.values(COUNTRIES),
      },
      {
        type: 'number',
        key: 'maxLiveStreamDuration',
        title: 'Max Live Stream Duration',
        description: 'Battery cameras stop streaming after this many seconds.',
        required: false,
        defaultValue: DEFAULT_MAX_LIVE_STREAM_SECONDS,
        minimum: 10,
        maximum: DEFAULT_MAX_LIVE_STREAM_SECONDS,
        step: 10,
        store: true,
      },
      {
        type: 'array',
        key: 'ignoreDevices',
        title: 'Ignore Devices',
        description: 'Serial numbers of Eufy devices that should not be offered.',
        required: false,
        items: {
          type: 'string',
          title: 'Serial Number',
          description: 'Serial number of the device',
        },
        defaultValue: [],
        store: true,
      },
      {
        type: 'submit',
        key: 'onLogin',
        title: 'Log In',
        description: 'Log in to Eufy',
        onClick: this.onLogin.bind(this),
      },
      {
        type: 'submit',
        key: 'onLogout',
        title: 'Log Out',
        description: 'End the Eufy session and forget the saved login',
        onClick: this.onLogout.bind(this),
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      this.cameraDevices.set(camera.id, camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    this.cameraDevices.set(camera.id, camera);
    await this.initializeCamera(camera);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const cameraDevice = this.cameraDevices.get(cameraId);
    this.cameraDevices.delete(cameraId);

    const sn = cameraDevice?.nativeId;
    if (!sn) return;

    const controller = this.cameras.get(sn);
    this.cameras.delete(sn);
    await controller?.release().catch((error: unknown) => this.logger.warn(`Could not release camera ${cameraDevice.name}: ${errorMessage(error)}`));

    await this.pushDiscoveredCameras();
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    return this.discoveredCameras();
  }

  public async onGetCameraSettings(_camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    return [];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, _settings: Record<string, unknown>): Promise<CameraConfig> {
    const sn = camera.id.replace(/^eufy:/, '');
    if (!this.account || !this.records.has(sn)) throw new Error(`Eufy camera ${sn} not found`);

    const device = await this.account.getDevice(sn);
    const info = device.info?.();

    this.logger.log(`Adopted camera ${device.name}`);

    return {
      name: device.name,
      nativeId: sn,
      isCloud: true,
      info: {
        manufacturer: 'Eufy',
        model: device.modelName,
        hardware: info?.hardwareVersion,
        serialNumber: sn,
        firmwareVersion: info?.firmwareVersion,
        supportUrl: 'https://support.eufy.com/',
      },
      sources: [
        {
          name: 'Stream',
          role: 'high-resolution',
          useForSnapshot: true,
          hotMode: false,
          preload: false,
        },
      ],
    };
  }

  public async onDiscoverSensors(): Promise<DiscoveredSensor[]> {
    const account = this.account;
    if (!account || !this.devicesLoaded) return [];

    const discovered: DiscoveredSensor[] = [];
    for (const record of this.records.values()) {
      if (isCameraRecord(record) || this.isIgnored(record.sn)) continue;
      try {
        discovered.push(...discoverStandaloneSensors(record, await account.getDevice(record.sn)));
      } catch (error) {
        this.logger.warn(`Could not read Eufy device ${record.sn}: ${errorMessage(error)}`);
      }
    }
    return discovered;
  }

  public async configureAdoptedSensors(records: AdoptedSensor[]): Promise<Sensor<any, any, any>[]> {
    const sensors: Sensor<any, any, any>[] = [];
    for (const record of records) {
      const standalone = this.createStandalone(record);
      if (standalone) sensors.push(standalone.sensor);
    }
    return sensors;
  }

  public async onSensorAdopted(record: AdoptedSensor): Promise<Sensor<any, any, any>> {
    const standalone = this.createStandalone(record);
    if (!standalone) throw new Error(`"${record.name}" is not a sensor of this plugin`);
    return standalone.sensor;
  }

  public async onSensorUnadopted(nativeId: string): Promise<void> {
    this.standalone.delete(nativeId);
  }

  private async start(): Promise<void> {
    try {
      this.ffmpegPath = await this.api.coreManager.getFFmpegPath();
    } catch (error) {
      this.logger.warn(`No ffmpeg available, fresh snapshots are disabled: ${errorMessage(error)}`);
    }

    const credentials = this.credentials(this.storage.values);
    if (!credentials) {
      this.logger.warn('Enter your Eufy login in the plugin settings');
      return;
    }

    const account = this.createAccount(credentials);
    try {
      const result = await account.login();
      if (result.status !== LoginStatus.Ok) {
        this.logger.error('Eufy asks for a captcha or a verification code, log in again in the plugin settings');
        await account.dispose();
        return;
      }
      await this.activate(account);
    } catch (error) {
      this.logger.error(`Eufy login failed: ${errorMessage(error)}`);
      await account.dispose().catch(() => undefined);
    }
  }

  private async stop(): Promise<void> {
    await this.deactivate();
    await this.pendingLogin?.dispose().catch(() => undefined);
    this.pendingLogin = undefined;
    this.pendingStep = undefined;

    this.nativeLogging?.dispose();
    this.nativeLogging = undefined;
  }

  private createAccount(credentials: AccountCredentials): EufyAccount {
    return new EufyAccount(credentials, this.api.storagePath, this.logger, this.storage.values.debug ?? false, this.ffmpegPath);
  }

  private async activate(account: EufyAccount): Promise<void> {
    await this.deactivate();

    this.account = account;
    account.client.on('event', (event) => this.routeEvent(account, event));
    account.client.on('deviceAdded', (record) => this.onDeviceAdded(account, record));
    account.client.on('deviceRemoved', (record) => this.onDeviceRemoved(account, record));
    account.client.on('sessionExpired', (error) => this.onSessionExpired(account, error));

    this.logger.log('Connected to Eufy');
    await this.loadDevices(account);
  }

  private async deactivate(logout = false): Promise<void> {
    const account = this.account;
    this.account = undefined;
    this.devicesLoaded = false;
    this.records.clear();

    await Promise.all([...this.cameras.values()].map((camera) => camera.unbind().catch(() => undefined)));

    for (const standalone of this.standalone.values()) standalone.bind(undefined);

    await (logout ? account?.logout() : account?.dispose())?.catch(() => undefined);
  }

  private async loadDevices(account: EufyAccount): Promise<void> {
    let records: EufyDevice[];
    try {
      records = await account.listDevices();
    } catch (error) {
      this.logger.error(`Could not load the Eufy devices: ${errorMessage(error)}`);
      return;
    }
    if (this.account !== account) return;

    this.records.clear();
    for (const record of records) this.records.set(record.sn, record);
    this.devicesLoaded = true;

    const cameras = records.filter(isCameraRecord).length;
    this.logger.log(`Found ${cameras} Eufy camera(s) and ${records.length - cameras} other device(s)`);

    await Promise.all([...this.cameraDevices.values()].map((camera) => this.initializeCamera(camera)));
    await Promise.all([...this.standalone.values()].map((standalone) => this.bindStandalone(standalone)));
    await this.pushDiscoveredCameras();
  }

  private async onDeviceAdded(account: EufyAccount, record: EufyDevice): Promise<void> {
    if (this.account !== account) return;
    this.records.set(record.sn, record);

    const camera = [...this.cameraDevices.values()].find((cameraDevice) => cameraDevice.nativeId === record.sn);
    if (camera) await this.initializeCamera(camera);

    for (const standalone of this.standalone.values()) {
      if (standalone.sn === record.sn) await this.bindStandalone(standalone);
    }
    await this.pushDiscoveredCameras();
  }

  private onDeviceRemoved(account: EufyAccount, record: EufyDevice): void {
    if (this.account !== account) return;
    this.records.delete(record.sn);
    account.forgetDevice(record.sn);
    this.logger.log(`${record.name ?? record.sn} was removed from the Eufy account`);

    for (const standalone of this.standalone.values()) {
      if (standalone.sn === record.sn) standalone.markRemoved();
    }
  }

  private async onSessionExpired(account: EufyAccount, error: Error): Promise<void> {
    if (this.account !== account) return;
    this.logger.error('The Eufy session ended, log in again in the plugin settings:', error.message);
    await this.deactivate();
  }

  private routeEvent(account: EufyAccount, event: AnyDeviceEvent): void {
    const sn = event.deviceSn ?? event.stationSn;
    if (this.account !== account || !sn) return;
    // pushes that name the triggering camera often leave the station out
    const stationSn = event.stationSn ?? this.records.get(sn)?.stationSn;

    this.cameras.get(sn)?.handleEvent(event);
    for (const standalone of this.standalone.values()) {
      if (standalone.sn === sn) {
        standalone.handleEvent(event, true);
      } else if (standalone.sn === stationSn) {
        standalone.handleEvent(event, false);
      }
    }
  }

  private async initializeCamera(cameraDevice: CameraDevice): Promise<void> {
    const account = this.account;
    const sn = cameraDevice.nativeId;
    if (!account || !sn || !this.records.has(sn)) return;

    let controller = this.cameras.get(sn);
    if (!controller) {
      controller = new EufyCamera(cameraDevice);
      this.cameras.set(sn, controller);
    }

    try {
      const device = await account.getDevice(sn);
      if (this.account !== account) return;
      await controller.bind(device, this.createContext(account));
      if (this.account !== account) await controller.unbind();
      if (this.storage.values.debug) this.logger.debug(`Initialized camera ${device.name}`);
    } catch (error) {
      this.logger.error(`Could not set up camera ${cameraDevice.name}: ${errorMessage(error)}`);
    }
  }

  private createContext(account: EufyAccount): EufyContext {
    const values = this.storage.values;
    return {
      client: account.client,
      debug: values.debug ?? false,
      maxLiveStreamDuration: Math.max(10, Math.min(DEFAULT_MAX_LIVE_STREAM_SECONDS, values.maxLiveStreamDuration ?? DEFAULT_MAX_LIVE_STREAM_SECONDS)),
    };
  }

  private createStandalone(record: AdoptedSensor): StandaloneSensor | undefined {
    const standalone = createStandaloneSensor(record, this.logger);
    if (!standalone) {
      this.logger.warn(`Adopted sensor "${record.name}" has no Eufy identity, it stays disconnected`);
      return undefined;
    }
    this.standalone.set(record.nativeId, standalone);
    this.bindStandalone(standalone);
    return standalone;
  }

  private async bindStandalone(standalone: StandaloneSensor): Promise<void> {
    const account = this.account;
    if (!account || !this.devicesLoaded) {
      standalone.bind(undefined);
      return;
    }
    if (!this.records.has(standalone.sn)) {
      standalone.markRemoved();
      return;
    }
    try {
      const device = await account.getDevice(standalone.sn);
      if (this.account === account && this.standalone.get(standalone.nativeId) === standalone) standalone.bind(device);
    } catch (error) {
      this.logger.warn(`Could not read Eufy device ${standalone.sn}: ${errorMessage(error)}`);
      standalone.bind(undefined);
    }
  }

  private async pushDiscoveredCameras(): Promise<void> {
    const discovered = this.discoveredCameras();
    if (discovered.length > 0) await this.api.deviceManager.pushDiscoveredCameras(discovered);
  }

  private discoveredCameras(): DiscoveredCamera[] {
    const adopted = new Set([...this.cameraDevices.values()].map((camera) => camera.nativeId));
    return [...this.records.values()]
      .filter((record) => isCameraRecord(record) && !adopted.has(record.sn) && !this.isIgnored(record.sn))
      .map((record) => ({ id: `eufy:${record.sn}`, name: record.name ?? record.sn, manufacturer: 'Eufy', model: record.model }));
  }

  private isIgnored(sn: string): boolean {
    return (this.storage.values.ignoreDevices ?? []).includes(sn);
  }

  private credentials(values: StorageValues): AccountCredentials | undefined {
    if (!values.username || !values.password) return undefined;
    return { email: values.username.trim(), password: values.password, country: values.country };
  }

  private async onLogin(values: StorageValues): Promise<FormSubmitResponse> {
    const credentials = this.credentials(values);
    if (!credentials) return { toast: { type: 'error', message: 'Enter email and password' } };

    const key = accountKey(credentials);
    if (this.account?.key === key && this.account.client.loggedIn && !this.pendingStep) {
      await this.saveConfig(values);
      return { toast: { type: 'success', message: 'Already logged in' } };
    }

    let account = this.pendingLogin?.key === key ? this.pendingLogin : undefined;
    const step = account ? this.pendingStep : undefined;
    try {
      let result: LoginResult;
      if (account && step === 'captcha' && values.captchaCode) {
        result = await account.solveCaptcha(values.captchaCode.trim());
      } else if (account && step === 'twoFactor' && values.twoFactorCode) {
        result = await account.submitVerifyCode(values.twoFactorCode.trim());
      } else {
        await this.pendingLogin?.dispose().catch(() => undefined);
        account = this.createAccount(credentials);
        result = await account.login();
      }
      this.pendingLogin = account;

      if (result.status === LoginStatus.Captcha) {
        this.pendingStep = 'captcha';
        return {
          toast: { type: 'warning', message: result.retry ? 'Wrong captcha, try again' : 'Eufy asks for a captcha' },
          schema: [
            { type: 'string', key: 'captcha', title: 'Captcha', description: 'Type the characters from the image', format: 'image', defaultValue: result.image },
            { type: 'string', key: 'captchaCode', title: 'Captcha Code', description: 'Characters from the image', required: true },
          ],
        };
      }

      if (result.status === LoginStatus.TwoFactor) {
        this.pendingStep = 'twoFactor';
        return {
          toast: { type: 'warning', message: 'Eufy sent a verification code' },
          schema: [{ type: 'string', key: 'twoFactorCode', title: 'Verification Code', description: 'Code from the Eufy email or SMS', required: true }],
        };
      }

      this.pendingLogin = undefined;
      this.pendingStep = undefined;
      await this.saveConfig(values);
      await this.activate(account);
      return { toast: { type: 'success', message: 'Logged in to Eufy' } };
    } catch (error) {
      await account?.dispose().catch(() => undefined);
      this.pendingLogin = undefined;
      this.pendingStep = undefined;
      const message = `Eufy login failed: ${errorMessage(error)}`;
      this.logger.error(message);
      return { toast: { type: 'error', message } };
    }
  }

  private async onLogout(): Promise<FormSubmitResponse> {
    await this.pendingLogin?.dispose().catch(() => undefined);
    this.pendingLogin = undefined;
    this.pendingStep = undefined;

    if (!this.account) return { toast: { type: 'info', message: 'Not logged in' } };

    await this.deactivate(true);
    this.logger.log('Logged out of Eufy');
    return { toast: { type: 'success', message: 'Logged out of Eufy' } };
  }

  private async saveConfig(values: StorageValues): Promise<void> {
    const { captcha: _captcha, captchaCode: _captchaCode, twoFactorCode: _twoFactorCode, ...config } = values;
    this.storage.values = config;
    await this.storage.save();
  }
}
