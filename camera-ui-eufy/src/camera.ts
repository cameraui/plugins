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

  // Only created when useP2P is enabled
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
    // Motion sensor - always available for Eufy cameras
    this.motionSensor = new EufyMotionSensor();
    await this.cameraDevice.addSensor(this.motionSensor);

    // Object sensor - for person/pet/vehicle detection
    this.objectSensor = new EufyObjectSensor();
    await this.cameraDevice.addSensor(this.objectSensor);

    // Battery sensor - only for battery-powered cameras
    if (this.eufyDevice.hasBattery()) {
      this.batterySensor = new EufyBatteryInfo();
      await this.cameraDevice.addSensor(this.batterySensor);

      // Set initial battery state
      this.batterySensor.updateFromEufyCamera(this.eufyDevice);
    }

    // Doorbell trigger - only for doorbell devices
    if (this.eufyDevice.isDoorbell()) {
      this.doorbellTrigger = new EufyDoorbellTrigger();
      await this.cameraDevice.addSensor(this.doorbellTrigger);
    }
  }

  private subscribeToEvents(): void {
    // Motion detection events
    this.eufyDevice.on('motion detected', (_device: Device, state: boolean) => {
      if (this.motionSensor) {
        this.motionSensor.reportDetections(state);
      }
    });

    // Person detected events
    this.eufyDevice.on('person detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('person', state);
      }
    });

    // Pet detected events
    this.eufyDevice.on('pet detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('animal', state);
      }
    });

    // Vehicle detected events
    this.eufyDevice.on('vehicle detected', (_device: Device, state: boolean) => {
      if (this.objectSensor) {
        this.reportObjectCategory('vehicle', state);
      }
    });

    // Doorbell ring events
    if (this.doorbellTrigger) {
      this.eufyDevice.on('rings', (_device: Device, state: boolean) => {
        if (state && this.doorbellTrigger) {
          this.doorbellTrigger.trigger();
        }
      });
    }

    // Battery level changes
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

    // Eufy events don't include bounding boxes — synthesize one full-frame
    // detection per active category so labels are correctly auto-derived.
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

    // One upstream P2P session, fanned out to every rtsp:// puller. The relay is
    // lazy: it acquires the Eufy livestream on the first viewer and releases it
    // (idleTimeout) once the last one leaves.
    this.relay = new Relay({
      source: new EufyP2PSource(this.localLivestreamManager, this.relayLogger),
      idleTimeout: 5_000,
      logger: this.relayLogger,
    });

    this.relay.on('stop', () => this.resetTalkback());

    // Advertise a talkback channel to viewers; inbound audio is transcoded to the
    // Eufy station's expected format and written to the talkback stream.
    this.rtspServer = await this.relay.serveRtsp({ path: 'live', backchannel: { ...TALKBACK_ADVERTISE } });
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
    void this.talkbackTranscoder?.close();
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

    // Poll for RTSP URL if not immediately available
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

    // Stop any active livestream
    this.localLivestreamManager.stopLocalLiveStream();

    if (useP2P) {
      // Create P2P RTSP relay
      await this.createP2PRTSPServer();
    } else {
      // Tear down P2P relay if it exists
      if (this.relay) {
        await this.rtspServer?.shutdown(); // stop the listener + detach from the relay
        await this.relay.stop(); // close the upstream P2P session
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
        description: 'Use P2P for live stream instead of RTSP. Enable this if RTSP is not available on your camera.',
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
