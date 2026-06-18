import { Duplex } from 'node:stream';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type { Device, EufySecurity, Station } from 'eufy-security-client';
import type { Writable } from 'node:stream';
import type { EufyHome } from '../types.js';

export class TalkbackStream extends Duplex {
  private cacheData: Buffer[] = [];
  private talkbackStarted = false;
  private stopTalkbackTimeout?: NodeJS.Timeout;

  private targetStream?: Writable;

  private eufyClient: EufySecurity;
  private cameraSN: string;
  private cameraLogger: LoggerService;
  private home: EufyHome;
  private cameraDevice: CameraDevice;

  constructor(home: EufyHome, eufyClient: EufySecurity, eufyDevice: Device, cameraDevice: CameraDevice, cameraLogger: LoggerService) {
    super();

    this.home = home;
    this.eufyClient = eufyClient;
    this.cameraLogger = cameraLogger;
    this.cameraDevice = cameraDevice;
    this.cameraSN = eufyDevice.getSerial();

    this.eufyClient.on('station talkback start', this.onTalkbackStarted.bind(this));
    this.eufyClient.on('station talkback stop', this.onTalkbackStopped.bind(this));
  }

  private onTalkbackStarted(station: Station, device: Device, stream: Writable) {
    if (device.getSerial() !== this.cameraSN) {
      return;
    }

    this.cameraLogger.debug(this.home.name, 'talkback started event from station ' + station.getName());

    if (this.targetStream) {
      this.unpipe(this.targetStream);
    }

    this.targetStream = stream;
    this.pipe(this.targetStream);
  }

  private onTalkbackStopped(station: Station, device: Device) {
    if (device.getSerial() !== this.cameraSN) {
      return;
    }

    this.cameraLogger.debug(this.home.name, 'talkback stopped event from station ' + station.getName());

    if (this.targetStream) {
      this.unpipe(this.targetStream);
    }

    this.targetStream = undefined;
  }

  public stopTalkbackStream(): void {
    // remove event listeners
    this.eufyClient.removeListener('station talkback start', this.onTalkbackStarted.bind(this));
    this.eufyClient.removeListener('station talkback stop', this.onTalkbackStopped.bind(this));

    this.stopTalkback();
    this.unpipe();
    this.destroy();
  }

  override _read(): void {
    let pushReturn = true;
    while (this.cacheData.length > 0 && pushReturn) {
      const data = this.cacheData.shift();
      pushReturn = this.push(data);
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.stopTalkbackTimeout) {
      clearTimeout(this.stopTalkbackTimeout);
    }

    this.stopTalkbackTimeout = setTimeout(() => {
      this.stopTalkback();
    }, 2000);

    if (this.targetStream) {
      this.push(chunk);
    } else {
      this.cacheData.push(chunk);
      this.startTalkback();
    }
    callback();
  }

  private startTalkback() {
    if (!this.talkbackStarted) {
      this.talkbackStarted = true;
      this.cameraLogger.debug(this.home.name, 'starting talkback');
      this.eufyClient.startStationTalkback(this.cameraSN).catch((err) => {
        this.cameraLogger.error(this.home.name, 'talkback could not be started: ' + err);
      });
    }
  }

  private stopTalkback() {
    if (this.talkbackStarted) {
      this.talkbackStarted = false;
      this.cameraLogger.debug(this.home.name, 'stopping talkback');
      this.eufyClient.stopStationTalkback(this.cameraSN).catch((err) => {
        this.cameraLogger.error(this.home.name, 'talkback could not be stopped: ' + err);
      });
    }
  }
}
