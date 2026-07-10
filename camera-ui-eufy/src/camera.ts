import { BackchannelTranscoder, Relay } from '@seydx/rtsp';
import { PropertyName } from 'eufy-security-client';

import { LocalLivestreamManager } from './eufy/LocalLiveStreamManager.js';
import { EufyP2PSource } from './eufy/P2PSource.js';
import { TalkbackStream } from './eufy/Talkback.js';
import { EufyBatteryInfo, EufyDoorbellTrigger, EufyMotionSensor, EufyObjectSensor } from './sensors.js';

import type { CameraDevice, DeviceStorage, LoggerService, SnapshotInterface, StreamingInterface, TrackedDetection } from '@camera.ui/sdk';
import type { Logger, RtspServerSink } from '@seydx/rtsp';
import type { Device, Camera as EufyCamera, EufySecurity } from 'eufy-security-client';
import type Eufy from './index.js';
import type { EufyCameraStorage, EufyHome } from './types.js';

const TALKBACK_ADVERTISE = { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 } as const;
const TALKBACK_TARGET = { codec: 'aac', sampleRate: 16000, channels: 1, format: 'adts', bitRate: 32000 } as const;

class CameraDeviceImplementations implements StreamingInterface, SnapshotInterface {
  constructor(
    private camera: Camera,
    private eufyCamera: EufyCamera,
    private logger: LoggerService,
  ) {}

  async streamUrl(_sourceId: string): Promise<string> {
    return this.camera.getStreamUrl();
  }

  async snapshot(_sourceId: string, _forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    try {
      const imageData = this.eufyCamera.getLastCameraImageURL();
      if (imageData && typeof imageData === 'object' && 'imageUrl' in imageData) {
        const response = await fetch(imageData.imageUrl as string);
        if (response.ok) {
          return await response.arrayBuffer();
        }
      }
    } catch (error) {
      this.logger.error('Failed to get snapshot:', error);
    }
  }
}

export class Camera {
  public readonly eufyClient: EufySecurity;
  public readonly eufyDevice: EufyCamera;
  public readonly cameraDevice: CameraDevice;

  private readonly storage: DeviceStorage<EufyCameraStorage>;

  private platform: Eufy;
  private home: EufyHome;
  private cameraLogger: LoggerService;

  private relay?: Relay;
  private rtspServer?: RtspServerSink;
  private relayLogger?: Logger;
  private talkbackTranscoder?: BackchannelTranscoder;
  private talkbackStarting?: Promise<void>;
  private localLivestreamManager!: LocalLivestreamManager;
  private talkbackStream!: TalkbackStream;

  private motionSensor?: EufyMotionSensor;
  private objectSensor?: EufyObjectSensor;
  private batterySensor?: EufyBatteryInfo;
  private doorbellTrigger?: EufyDoorbellTrigger;

  private activeObjectCategories = new Set<'person' | 'animal' | 'vehicle'>();

  constructor(platform: Eufy, home: EufyHome, eufyClient: EufySecurity, eufyDevice: EufyCamera, cameraDevice: CameraDevice) {
    this.platform = platform;
    this.home = home;
    this.eufyClient = eufyClient;
    this.eufyDevice = eufyDevice;

    this.cameraDevice = cameraDevice;
    this.storage = this.createStorage();

    this.cameraLogger = cameraDevice.logger;
  }

  public async initialize(): Promise<void> {
    this.localLivestreamManager = new LocalLivestreamManager(this.home, this.eufyClient, this.eufyDevice, this.cameraDevice, this.cameraLogger);
    this.talkbackStream = new TalkbackStream(this.home, this.eufyClient, this.eufyDevice, this.cameraDevice, this.cameraLogger);

    await this.setupStreaming();
    await this.cameraDevice.implement(new CameraDeviceImplementations(this, this.eufyDevice, this.cameraLogger));
    await this.initializeSensors();

    this.subscribeToEvents();
    this.cameraDevice.connect();
  }

  public async getStreamUrl(): Promise<string> {
    if (this.storage.values.useP2P && this.rtspServer) {
      return this.rtspServer.url;
    }
    return this.getNativeRTSPUrl();
  }

  private async initializeSensors(): Promise<void> {
    this.motionSensor = new EufyMotionSensor();
    await this.cameraDevice.addSensor(this.motionSensor);

    this.objectSensor = new EufyObjectSensor();
    await this.cameraDevice.addSensor(this.objectSensor);

    if (this.eufyDevice.hasBattery()) {
      this.batterySensor = new EufyBatteryInfo();
      await this.cameraDevice.addSensor(this.batterySensor);

      this.batterySensor.updateFromEufyCamera(this.eufyDevice);
    }

    if (this.eufyDevice.isDoorbell()) {
      this.doorbellTrigger = new EufyDoorbellTrigger();
      await this.cameraDevice.addSensor(this.doorbellTrigger);
    }
  }

  private subscribeToEvents(): void {
    this.eufyDevice.on('motion detected', (_device: Device, state: boolean) => {
      if (this.motionSensor) {
        this.motionSensor.reportDetections(state);
      }
    });

    this.eufyDevice.on('person detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('person', state);
      }
    });

    this.eufyDevice.on('pet detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('animal', state);
      }
    });

    this.eufyDevice.on('vehicle detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('vehicle', state);
      }
    });

    if (this.doorbellTrigger) {
      this.eufyDevice.on('rings', (_device: Device, state: boolean) => {
        if (state && this.doorbellTrigger) {
          this.doorbellTrigger.trigger();
        }
      });
    }

    if (this.batterySensor) {
      const batteryProps = [PropertyName.DeviceBattery, PropertyName.DeviceBatteryLow, PropertyName.DeviceChargingStatus] as string[];
      this.eufyDevice.on('property changed', (_device: Device, name: string) => {
        if (batteryProps.includes(name)) {
          this.batterySensor?.updateFromEufyCamera(this.eufyDevice);
        }
      });

      this.eufyDevice.on('low battery', (_device: Device, state: boolean) => {
        if (this.batterySensor) {
          this.batterySensor.setLow(state);
        }
      });
    }
  }

  private reportObjectCategory(category: 'person' | 'animal' | 'vehicle', detected: boolean): void {
    if (!this.objectSensor) return;

    if (detected) {
      this.activeObjectCategories.add(category);
    } else {
      this.activeObjectCategories.delete(category);
    }

    if (this.activeObjectCategories.size === 0) {
      this.objectSensor.reportDetections(false);
      return;
    }

    // Eufy events lack bounding boxes — synthesize a full-frame detection per category.
    const detections: TrackedDetection[] = Array.from(this.activeObjectCategories).map((label) => ({
      label,
      confidence: 1,
      box: { x: 0, y: 0, width: 1, height: 1 },
    }));

    this.objectSensor.reportDetections(true, detections);
  }

  private async setupStreaming(): Promise<void> {
    const useP2P = this.storage.values.useP2P ?? false;

    if (useP2P) {
      await this.createP2PRTSPServer();
    } else {
      this.cameraLogger.log('Using direct RTSP stream');
    }
  }

  private async createP2PRTSPServer(): Promise<void> {
    this.relayLogger = this.createRelayLogger();

    // Lazy relay: acquires the Eufy livestream on first viewer, releases it after idleTimeout when the last leaves.
    this.relay = new Relay({
      source: new EufyP2PSource(this.localLivestreamManager, this.relayLogger),
      idleTimeout: 10_000,
      logger: this.relayLogger,
    });

    this.relay.on('stop', () => this.resetTalkback());

    this.rtspServer = await this.relay.serveRtsp({
      path: 'live',
      backchannel: { ...TALKBACK_ADVERTISE },
      audioTranscode: { codec: 'aac', bitRate: 48000 },
      sdpTimeout: 30,
    });

    this.rtspServer.on('backchannel', (rtp) => this.handleTalkbackRtp(rtp));

    this.cameraLogger.log('P2P RTSP relay started');
  }

  private handleTalkbackRtp(rtp: Buffer): void {
    if (!this.talkbackTranscoder) {
      this.talkbackTranscoder = new BackchannelTranscoder({
        from: { ...TALKBACK_ADVERTISE },
        to: { ...TALKBACK_TARGET },
        output: (chunk) => this.talkbackStream.write(chunk),
        logger: this.relayLogger,
      });
      this.talkbackStarting = this.talkbackTranscoder.start();
    }
    this.talkbackStarting?.then(() => this.talkbackTranscoder?.push(rtp)).catch((error) => this.cameraLogger.error('Talkback transcode failed:', error));
  }

  private resetTalkback(): void {
    this.talkbackTranscoder?.close();
    this.talkbackTranscoder = undefined;
    this.talkbackStarting = undefined;
  }

  private createRelayLogger(): Logger {
    return {
      log: (...args) => this.cameraLogger.log(...args),
      warn: (...args) => this.cameraLogger.warn(...args),
      error: (...args) => this.cameraLogger.error(...args),
      debug: (...args) => this.cameraLogger.debug(...args),
    };
  }

  private async getNativeRTSPUrl(): Promise<string> {
    const rtspUrl = this.eufyDevice.getPropertyValue(PropertyName.DeviceRTSPStreamUrl) as string;

    if (rtspUrl && rtspUrl !== '') {
      return rtspUrl;
    }

    if (!this.eufyDevice.hasProperty(PropertyName.DeviceRTSPStream)) {
      throw new Error('This Eufy device does not support native RTSP — enable "Use P2P" for this camera.');
    }

    if (!this.eufyDevice.getPropertyValue(PropertyName.DeviceRTSPStream)) {
      await this.eufyClient.setDeviceProperty(this.eufyDevice.getSerial(), PropertyName.DeviceRTSPStream, true);
    }

    let attempts = 0;
    while (attempts < 20) {
      attempts++;
      const url = this.eufyDevice.getPropertyValue(PropertyName.DeviceRTSPStreamUrl) as string;

      if (url && url !== '') {
        return url;
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error('Failed to get RTSP URL from Eufy device');
  }

  private async onUseP2PChanged(useP2P: boolean): Promise<void> {
    this.cameraLogger.log(`P2P enabled: ${useP2P}`);

    this.localLivestreamManager.stopLocalLiveStream();

    if (useP2P) {
      await this.createP2PRTSPServer();
    } else {
      if (this.relay) {
        await this.rtspServer?.shutdown();
        await this.relay.stop();
        this.resetTalkback();
        this.rtspServer = undefined;
        this.relay = undefined;
        this.cameraLogger.log('P2P RTSP relay stopped, using direct RTSP');
      }
    }
  }

  private createStorage(): DeviceStorage<EufyCameraStorage> {
    return this.cameraDevice.createStorage<EufyCameraStorage>([
      {
        type: 'boolean',
        key: 'useP2P',
        title: 'Use P2P',
        description: 'Stream over P2P instead of RTSP. Use this if your camera has no RTSP.',
        required: false,
        defaultValue: false,
        store: true,
        onSet: async (useP2P: boolean) => {
          await this.onUseP2PChanged(useP2P);
        },
      },
    ]);
  }
}
