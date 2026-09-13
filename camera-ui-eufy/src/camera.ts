import { DoorbellTrigger } from '@camera.ui/sdk';
import { Relay } from '@seydx/rtsp';

import {
  EufyAudioSensor,
  EufyBatteryInfo,
  EufyCameraSwitch,
  EufyLightControl,
  EufyMotionSensor,
  EufyObjectSensor,
  EufyPtzControl,
  EufySecuritySystem,
  EufySirenControl,
} from './sensors.js';
import { EufyLiveSource } from './stream.js';
import { EufyTalkback, TALKBACK_ADVERTISE } from './talkback.js';
import { errorMessage } from './utils.js';

import type { CameraDevice, DeviceStorage, LoggerService, Sensor, SnapshotInterface, StreamingInterface } from '@camera.ui/sdk';
import type { AnyDeviceEvent, Device } from '@mega-yfue/eufy-sdk';
import type { Logger, RtspServerSink } from '@seydx/rtsp';
import type { BindableSensor } from './sensors.js';
import type { EufyCameraStorage, EufyContext, StreamMode } from './types.js';

const RTSP_URL_ATTEMPTS = 2;

class CameraDeviceImplementations implements StreamingInterface, SnapshotInterface {
  constructor(private readonly camera: EufyCamera) {}

  public async streamUrl(_sourceId: string): Promise<string> {
    return this.camera.getStreamUrl();
  }

  public async snapshot(_sourceId: string, forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    return this.camera.getSnapshot(forceNew);
  }
}

export class EufyCamera {
  private readonly logger: LoggerService;
  private readonly bindables: BindableSensor[] = [];

  private device?: Device;
  private context?: EufyContext;
  private storage?: DeviceStorage<EufyCameraStorage>;
  private implemented = false;
  private queue: Promise<void> = Promise.resolve();
  private relay?: Relay;
  private relayReady?: Promise<RtspServerSink>;
  private talkback?: EufyTalkback;
  private motionSensor?: EufyMotionSensor;
  private objectSensor?: EufyObjectSensor;
  private audioSensor?: EufyAudioSensor;
  private batteryInfo?: EufyBatteryInfo;
  private doorbellTrigger?: DoorbellTrigger;
  private lightControl?: EufyLightControl;
  private sirenControl?: EufySirenControl;
  private ptzControl?: EufyPtzControl;
  private cameraSwitch?: EufyCameraSwitch;
  private securitySystem?: EufySecuritySystem;

  constructor(public readonly cameraDevice: CameraDevice) {
    this.logger = cameraDevice.logger;
  }

  public bind(device: Device, context: EufyContext): Promise<void> {
    return this.serialize(async () => {
      await this.detach();
      this.device = device;
      this.context = context;
      try {
        this.storage ??= this.createStorage(device);
        if (!this.implemented) {
          await this.cameraDevice.implement(new CameraDeviceImplementations(this));
          this.implemented = true;
        }
        await this.addSensors(device);
        for (const sensor of this.bindables) {
          sensor.device = device;
          sensor.sync();
        }
        if (this.streamMode === 'p2p') await this.ensureRelay();
        await this.cameraDevice.connect();
      } catch (error) {
        await this.detach();
        throw error;
      }
    });
  }

  public unbind(): Promise<void> {
    return this.serialize(() => this.detach());
  }

  public release(): Promise<void> {
    return this.serialize(async () => {
      if (this.streamMode === 'rtsp') await this.withdrawRtsp();
      await this.detach();
    });
  }

  public async getStreamUrl(): Promise<string> {
    const device = this.requireDevice();
    if (this.streamMode === 'rtsp') return this.getRtspUrl(device);
    const server = await this.ensureRelay();
    return `${server.url}#timeout=30`;
  }

  public async getSnapshot(forceNew?: boolean): Promise<ArrayBuffer | undefined> {
    const device = this.device;
    const camera = device?.camera?.();
    if (!device || !camera) return undefined;

    if (!forceNew && camera.snapshotStored) {
      try {
        return toArrayBuffer(await camera.snapshotStored());
      } catch (error) {
        if (this.context?.debug) this.logger.debug(`No stored snapshot: ${errorMessage(error)}`);
      }
    }

    // a fresh still wakes a battery camera, only an explicit request may pay for that
    if (!camera.snapshotLive || (!forceNew && device.has('battery'))) return undefined;

    try {
      const shot = await camera.snapshotLive();
      return toArrayBuffer(shot.jpeg);
    } catch (error) {
      this.logger.warn(`Could not capture a snapshot: ${errorMessage(error)}`);
      return undefined;
    }
  }

  public handleEvent(event: AnyDeviceEvent): void {
    switch (event.eventName) {
      case 'motion':
        this.motionSensor?.pulse();
        break;
      case 'personDetected':
      case 'strangerDetected':
        this.objectSensor?.pulse('person');
        break;
      case 'vehicleDetected':
        this.objectSensor?.pulse('vehicle');
        break;
      case 'petDetection':
      case 'dogDetected':
        this.objectSensor?.pulse('animal');
        break;
      case 'soundDetected':
        this.audioSensor?.pulse();
        break;
      case 'cryingDetected':
        this.audioSensor?.pulse('baby_cry');
        break;
      case 'doorbellPress':
        this.doorbellTrigger?.trigger();
        break;
      case 'batteryAlert':
        if (event.state === 'low') this.batteryInfo?.reportLow();
        break;
      case 'alarm':
        this.securitySystem?.handleAlarm(event);
        break;
      case 'propertyChanged':
      case 'armingModeChanged':
      case 'cameraEnabledChanged':
        for (const sensor of this.bindables) sensor.sync();
        break;
    }
  }

  private get streamMode(): StreamMode {
    if (!this.device?.rtsp?.()) return 'p2p';
    return this.storage?.values.streamMode ?? 'p2p';
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async detach(): Promise<void> {
    const wasBound = this.device !== undefined;
    await this.stopRelay();
    this.device = undefined;
    this.context = undefined;
    for (const sensor of this.bindables) sensor.device = undefined;
    if (wasBound) await this.cameraDevice.disconnect().catch(() => undefined);
  }

  private requireDevice(): Device {
    if (!this.device) throw new Error(`${this.cameraDevice.name} is not connected to Eufy`);
    return this.device;
  }

  private async addSensors(device: Device): Promise<void> {
    const camera = device.camera?.();

    this.motionSensor ??= await this.add(new EufyMotionSensor('Eufy Motion'));
    this.objectSensor ??= await this.add(new EufyObjectSensor('Eufy Object'));

    if (!this.audioSensor && camera?.soundDetection !== undefined) {
      this.audioSensor = await this.add(new EufyAudioSensor('Eufy Audio'));
    }

    if (!this.batteryInfo && device.battery?.()?.level !== undefined) {
      this.batteryInfo = await this.addBindable(new EufyBatteryInfo(device));
    }

    if (!this.doorbellTrigger && device.has('doorbell')) {
      this.doorbellTrigger = await this.add(new DoorbellTrigger('Eufy Doorbell'));
    }

    if (!this.lightControl && device.light?.()) {
      this.lightControl = await this.addBindable(new EufyLightControl(device, this.logger));
    }

    if (!this.sirenControl && device.siren?.()?.trigger) {
      this.sirenControl = await this.addBindable(new EufySirenControl(device, this.logger));
    }

    if (!this.ptzControl && device.ptz?.()) {
      this.ptzControl = await this.addBindable(new EufyPtzControl(device, this.logger));
    }

    if (!this.cameraSwitch && camera?.enabled !== undefined) {
      this.cameraSwitch = await this.addBindable(new EufyCameraSwitch(device, this.logger));
    }

    // a HomeBase owns the guard mode of its cameras, that one is adopted as a standalone sensor
    if (!this.securitySystem && device.arming?.() && device.stationSn === device.sn) {
      this.securitySystem = await this.addBindable(new EufySecuritySystem(device, this.logger));
    }
  }

  private async add<T extends Sensor<any, any, any>>(sensor: T): Promise<T> {
    await this.cameraDevice.addSensor(sensor);
    return sensor;
  }

  private async addBindable<T extends Sensor<any, any, any> & BindableSensor>(sensor: T): Promise<T> {
    await this.add(sensor);
    this.bindables.push(sensor);
    return sensor;
  }

  private ensureRelay(): Promise<RtspServerSink> {
    const device = this.requireDevice();
    this.relayReady ??= this.startRelay(device, this.context!).catch((error: unknown) => {
      this.relayReady = undefined;
      throw error;
    });
    return this.relayReady;
  }

  private async startRelay(device: Device, context: EufyContext): Promise<RtspServerSink> {
    const logger = this.createRelayLogger(context);
    const talkback = new EufyTalkback(device, logger);
    const relay = new Relay({
      source: new EufyLiveSource(device, context.maxLiveStreamDuration * 1000, logger),
      idleTimeout: device.has('battery') ? 10_000 : 30_000,
      stallTimeout: 8_000,
      logger,
    });
    relay.on('stop', () => talkback.stop());

    this.relay = relay;
    this.talkback = talkback;

    try {
      const server = await relay.serveRtsp({
        path: 'live',
        backchannel: device.camera?.()?.talkback ? { ...TALKBACK_ADVERTISE } : false,
        sdpTimeout: 30_000,
      });
      server.on('backchannel', (rtp) => talkback.push(rtp));
      if (context.debug) this.logger.debug('P2P relay started');
      return server;
    } catch (error) {
      await relay.stop().catch(() => undefined);
      throw error;
    }
  }

  private async stopRelay(): Promise<void> {
    const ready = this.relayReady;
    const relay = this.relay;
    const talkback = this.talkback;
    this.relayReady = undefined;
    this.relay = undefined;
    this.talkback = undefined;

    await talkback?.stop();
    const server = await ready?.catch(() => undefined);
    await server?.shutdown().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
  }

  private async getRtspUrl(device: Device): Promise<string> {
    // publishes on demand and returns the credentials in force, a cold station can miss the first window
    for (let attempt = 0; attempt < RTSP_URL_ATTEMPTS; attempt++) {
      const url = await this.context?.client.reportedRtspUrl(device.sn);
      if (url) return url;
    }
    throw new Error(`${device.name} did not report an RTSP address`);
  }

  private async withdrawRtsp(): Promise<void> {
    try {
      await this.device?.rtsp?.()?.withdraw();
    } catch (error) {
      this.logger.warn(`Could not withdraw the RTSP stream: ${errorMessage(error)}`);
    }
  }

  private onStreamModeChanged(mode: StreamMode): Promise<void> {
    return this.serialize(async () => {
      this.logger.log(`Stream mode set to ${mode === 'rtsp' ? 'RTSP' : 'P2P'}`);
      if (mode === 'rtsp') {
        await this.stopRelay();
      } else {
        await this.withdrawRtsp();
        if (this.device) await this.ensureRelay();
      }
    });
  }

  private createRelayLogger(context: EufyContext): Logger {
    return {
      log: (...args) => this.logger.log(...args),
      warn: (...args) => this.logger.warn(...args),
      error: (...args) => this.logger.error(...args),
      debug: (...args) => {
        if (context.debug) this.logger.debug(...args);
      },
    };
  }

  private createStorage(device: Device): DeviceStorage<EufyCameraStorage> {
    if (!device.rtsp?.()) return this.cameraDevice.createStorage<EufyCameraStorage>([]);

    return this.cameraDevice.createStorage<EufyCameraStorage>([
      {
        type: 'string',
        key: 'streamMode',
        title: 'Stream Mode',
        description: 'P2P works for every camera. RTSP needs mains power, and a HomeBase serves only one camera over RTSP.',
        enum: ['p2p', 'rtsp'],
        enumLabels: { p2p: 'P2P', rtsp: 'RTSP' },
        defaultValue: 'p2p',
        required: false,
        store: true,
        onSet: async (mode: StreamMode) => this.onStreamModeChanged(mode),
      },
    ]);
  }
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return Uint8Array.from(data).buffer;
}
