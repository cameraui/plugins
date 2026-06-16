import { randomBytes } from 'crypto';
import {
  Accessory,
  AccessoryEventTypes,
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  Categories,
  Characteristic,
  ControllerStorage,
  H264Level,
  H264Profile,
  MediaContainerType,
  Service,
  SRTPCryptoSuites,
  uuid,
  VideoCodecType,
} from '../hap.js';

import { baseAdvertiser } from '../constants.js';
import * as mac from '../utils/mac.js';
import { generateValidAccessoryName, Subscribed } from '../utils/utils.js';
import { RecordingDelegate } from './recordingDelegate.js';
import { CameraServices } from './services.js';
import { StreamingDelegate } from './streamingDelegate.js';

import type { CameraDevice, DeviceStorage, LoggerService, PluginAPI } from '@camera.ui/sdk';
import type { CameraControllerOptions, MacAddress, MDNSAdvertiser, PublishInfo } from '../hap.js';
import type HomeKit from '../index.js';
import type { CameraStorageValues } from '../types.js';

export class CameraAccessory extends Subscribed {
  public controller?: CameraController;
  public cameraStorage: DeviceStorage<CameraStorageValues>;
  public api: PluginAPI;

  private logger: LoggerService;
  private cameraLogger: LoggerService;
  private cameraDevice: CameraDevice;

  private accessory?: Accessory;
  private cameraServices?: CameraServices;

  private recordingDelegate?: RecordingDelegate;
  private streamingDelegate?: StreamingDelegate;

  private published = false;
  private cameraSeenOnline = false;

  private publishedExternalAccessories = new Map<MacAddress, Accessory>();
  private accessoryPort: number | undefined;

  private get advertiser(): MDNSAdvertiser {
    return this.cameraStorage.values.advertiser.split(' (')[0] as MDNSAdvertiser;
  }

  constructor(platform: HomeKit, cameraDevice: CameraDevice) {
    super();

    this.api = platform.api;
    this.logger = platform.logger;
    this.cameraLogger = cameraDevice.logger;
    this.cameraDevice = cameraDevice;

    this.cameraStorage = this.createCameraStorage();

    this.cameraDevice.onConnected.subscribe(async (connected) => {
      if (connected) {
        await this.publishAccessory(this.cameraSeenOnline);
        this.cameraSeenOnline = true;
      } else {
        await this.unpublishAccessory(false);
      }
    });
  }

  public async teardown(destroy?: boolean): Promise<void> {
    if (this.published) {
      this.published = false;

      if (this.accessory) {
        if (destroy) {
          this.cameraLogger.log('Removing...');
          await this.accessory.destroy();
        } else {
          this.cameraLogger.log('Stopping...');
          await this.accessory.unpublish();
        }

        this.resetAccessory(destroy);
        const advertiseAddress = await this.cameraStorage.getValue<string>('advertiseAddress')!;
        this.publishedExternalAccessories.delete(advertiseAddress);
      }
    }
  }

  private async publishAccessory(republish?: boolean): Promise<void> {
    if (!this.published) {
      try {
        const accessoryPin = await this.cameraStorage.getValue<string>('accessoryPin')!;
        const advertiseAddress = await this.cameraStorage.getValue<string>('advertiseAddress')!;
        const accessoryPortOverride = this.cameraStorage.values.accessoryPortOverride;

        if (this.publishedExternalAccessories.has(advertiseAddress)) {
          throw new Error(`Accessory ${this.cameraDevice.name} experienced an address collision.`);
        }

        if (!republish) {
          this.cameraLogger.log(`Publishing camera (${this.advertiser})`);
        } else {
          this.cameraLogger.log(`Republishing camera (${this.advertiser})`);
        }

        this.setupAccessory();

        this.accessory!.on(AccessoryEventTypes.LISTENING, (port: number) => {
          this.accessoryPort = port;
          this.cameraLogger.debug(`is running on port ${port}`);
          this.cameraLogger.log(`Please add the camera manually in Home app. Setup Code: ${accessoryPin}`);
        });

        const addresses = await this.api.coreManager.getServerAddresses();
        let bind = addresses.length ? addresses : undefined;

        if (!bind) {
          this.cameraLogger.debug('No server addresses set, binding to: 0.0.0.0');
          bind = ['0.0.0.0'];
        }

        const port = accessoryPortOverride === 0 && this.accessoryPort === undefined ? undefined : accessoryPortOverride || this.accessoryPort;

        const publishInfo: PublishInfo = {
          username: advertiseAddress,
          pincode: accessoryPin,
          category: this.accessory!.category,
          port,
          bind,
          addIdentifyingMaterial: true,
          advertiser: this.advertiser,
        };

        await this.accessory!.publish(publishInfo);

        this.publishedExternalAccessories.set(advertiseAddress, this.accessory!);

        this.published = true;
      } catch (error) {
        this.cameraLogger.error('Error publishing camera', error);
        this.unpublishAccessory(true);
      }
    }
  }

  private async unpublishAccessory(reset?: boolean): Promise<void> {
    if (this.accessory) {
      if (!reset) {
        this.accessory.controllerStorage = new ControllerStorage(this.accessory);
      }

      await this.teardown(reset);
    }
  }

  private async republishAccessory(reset?: boolean): Promise<void> {
    await this.unpublishAccessory(reset);
    await this.publishAccessory(!reset);
  }

  private resetAccessory(destroy?: boolean): void {
    if (destroy) {
      this.accessoryPort = undefined;
    }

    this.recordingDelegate?.stop();
    this.recordingDelegate = undefined;
    this.streamingDelegate?.cleanup();
    this.streamingDelegate = undefined;
    this.cameraServices?.cleanup();
    this.cameraServices = undefined;
    this.accessory?.removeAllListeners();
    this.accessory = undefined;
    this.unsubscribe();
  }

  private setupAccessory(): void {
    this.cameraLogger.log('Configuring camera...');

    const republishId = this.cameraStorage.values.republishId;
    const accessoryUUID = uuid.generate(republishId + '-' + this.cameraDevice.id);

    this.accessory = new Accessory(generateValidAccessoryName(this.cameraDevice.name), accessoryUUID);
    this.accessory.category = this.cameraDevice.type === 'doorbell' ? Categories.VIDEO_DOORBELL : Categories.IP_CAMERA;

    const accessoryInformation = this.accessory.getService(Service.AccessoryInformation);

    accessoryInformation?.setCharacteristic(Characteristic.Name, this.cameraDevice.name);
    accessoryInformation?.setCharacteristic(Characteristic.ConfiguredName, this.cameraDevice.name);
    accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, 'camera.ui');
    accessoryInformation?.setCharacteristic(Characteristic.Identify, true);

    if (this.cameraDevice.info.manufacturer) accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, this.cameraDevice.info.manufacturer);
    if (this.cameraDevice.info.model) accessoryInformation?.setCharacteristic(Characteristic.Model, this.cameraDevice.info.model);
    if (this.cameraDevice.info.serialNumber) accessoryInformation?.setCharacteristic(Characteristic.SerialNumber, this.cameraDevice.info.serialNumber);
    if (this.cameraDevice.info.firmwareVersion) accessoryInformation?.setCharacteristic(Characteristic.FirmwareRevision, this.cameraDevice.info.firmwareVersion);

    this.accessory.on(AccessoryEventTypes.IDENTIFY, () => this.cameraLogger.debug('identified!'));

    this.addSubscriptions(
      this.cameraDevice.onPropertyChange('type').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory category to', newData);

        if (this.accessory) {
          this.accessory.category = newData === 'doorbell' ? Categories.VIDEO_DOORBELL : Categories.IP_CAMERA;
        }
      }),

      this.cameraDevice.onPropertyChange('name').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory name', newData);
        accessoryInformation?.setCharacteristic(Characteristic.Name, this.cameraDevice.name);
        accessoryInformation?.setCharacteristic(Characteristic.ConfiguredName, this.cameraDevice.name);
      }),

      this.cameraDevice.onPropertyChange('info').subscribe(({ newData }) => {
        this.cameraLogger.debug('Changing accessory information', newData);
        if (newData.manufacturer) accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, newData.manufacturer);
        if (newData.model) accessoryInformation?.setCharacteristic(Characteristic.Model, newData.model);
        if (newData.serialNumber) accessoryInformation?.setCharacteristic(Characteristic.SerialNumber, newData.serialNumber);
        if (newData.firmwareVersion) accessoryInformation?.setCharacteristic(Characteristic.FirmwareRevision, newData.firmwareVersion);
      }),
    );

    this.cameraServices = new CameraServices(this.accessory, this.cameraDevice);
    this.controller = new CameraController(this.createControllerOptions(this.accessory));

    this.accessory.configureController(this.controller);
  }

  private createCameraStorage(): DeviceStorage<CameraStorageValues> {
    return this.cameraDevice.createStorage<CameraStorageValues>([
      {
        type: 'string',
        key: 'qrCode',
        title: 'QR Code',
        description: 'The QR code to use for pairing the HomeKit camera',
        format: 'qrCode',
        group: 'Pairing',
        readonly: true,
        onGet: async () => {
          return this.accessory?.setupURI() ?? '';
        },
      },
      {
        type: 'string',
        key: 'accessoryPin',
        title: 'PIN',
        description: 'The pin to use for pairing the HomeKit camera',
        group: 'Pairing',
        store: true,
        readonly: true,
        onGet: async () => {
          if (this.cameraStorage.values.accessoryPin) {
            return this.cameraStorage.values.accessoryPin;
          }

          return mac.randomPinCode();
        },
      },
      {
        type: 'number',
        key: 'accessoryPort',
        title: 'Port',
        description: 'The port to use for the HomeKit camera',
        group: 'Advanced',
        readonly: true,
        onGet: async () => {
          return this.accessoryPort;
        },
      },
      {
        type: 'number',
        key: 'accessoryPortOverride',
        title: 'Override Port',
        description: 'Override the port to use for the HomeKit camera (0 = auto)',
        group: 'Advanced',
        store: true,
        required: false,
        defaultValue: 0,
        minimum: 0,
        maximum: 65535,
        onSet: async () => {
          await this.republishAccessory();
        },
      },
      {
        type: 'string',
        key: 'advertiser',
        title: 'mDNS advertiser',
        description: 'The mDNS advertiser to use for the HomeKit camera',
        group: 'Advanced',
        store: true,
        defaultValue: baseAdvertiser[0],
        enum: baseAdvertiser,
        onSet: async (newAdvertiser: any) => {
          const advertiser = newAdvertiser.split(' (')[0] as MDNSAdvertiser;
          this.cameraLogger.log('Changing mDNS advertiser to:', advertiser);
          await this.republishAccessory();
        },
      },
      {
        type: 'string',
        key: 'advertiseAddress',
        title: 'Username',
        description: 'The username to use for pairing the HomeKit camera',
        readonly: true,
        hidden: true,
        onGet: async () => {
          const republishId = this.cameraStorage.values.republishId;
          return mac.generate(`${republishId}-${this.cameraDevice.id}`);
        },
      },
      {
        type: 'string',
        key: 'republishId',
        title: 'Republish ID',
        description: 'The ID to use for republishing the HomeKit camera',
        store: true,
        hidden: true,
        defaultValue: '',
      },
      {
        type: 'button',
        title: 'Reset Pairing',
        key: 'reset',
        group: 'Reset',
        description: 'Reset the pairing of the HomeKit camera',
        color: 'danger',
        onSet: async () => {
          this.cameraLogger.log('Reset pairing...');
          await this.cameraStorage.setValue('republishId', randomBytes(8).toString('hex'));
          await this.cameraStorage.setValue('accessoryPin', mac.randomPinCode());
          await this.republishAccessory(true);
        },
      },
      {
        type: 'boolean',
        key: 'useHardwareAcceleration',
        title: 'Use Hardware Acceleration',
        description: 'Use hardware acceleration for streaming',
        group: 'Advanced',
        defaultValue: true,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Use hardware acceleration:', state);
        },
      },
      {
        type: 'boolean',
        key: 'transcodeStreaming',
        title: 'Transcode Streaming',
        description: 'Force transcode streaming',
        group: 'Advanced',
        defaultValue: false,
        store: true,
        onSet: async (state: boolean) => {
          this.cameraLogger.log('Transcode streaming:', state);
        },
      },
    ]);
  }

  private createControllerOptions(accessory: Accessory): CameraControllerOptions {
    this.streamingDelegate = new StreamingDelegate(this, this.cameraDevice);
    this.recordingDelegate = new RecordingDelegate(this, accessory, this.cameraDevice);

    return {
      cameraStreamCount: 10,
      delegate: this.streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
          ],
          codec: {
            profiles: [H264Profile.BASELINE],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              // required by watch
              samplerate: AudioStreamingSamplerate.KHZ_8,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_24,
            },
          ],
          twoWayAudio: true,
        },
      },
      recording: {
        options: {
          prebufferLength: 8000,
          mediaContainerConfiguration: [
            {
              type: MediaContainerType.FRAGMENTED_MP4,
              fragmentLength: 4000,
            },
          ],
          video: {
            type: VideoCodecType.H264,
            parameters: {
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
              profiles: [H264Profile.MAIN],
            },
            resolutions: [
              [1280, 720, 30],
              [1920, 1080, 30],
            ],
          },
          audio: {
            codecs: [
              {
                type: AudioRecordingCodecType.AAC_LC,
                bitrateMode: AudioBitrate.VARIABLE,
                samplerate: AudioRecordingSamplerate.KHZ_32,
                audioChannels: 1,
              },
            ],
          },
        },
        delegate: this.recordingDelegate,
      },
    };
  }
}
