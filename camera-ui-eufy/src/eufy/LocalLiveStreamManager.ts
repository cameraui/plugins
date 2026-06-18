import { EventEmitter } from 'node:events';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type { Device, Camera as EufyCamera, EufySecurity, Station, StreamMetadata } from 'eufy-security-client';
import type { Readable } from 'node:stream';
import type { EufyHome } from '../types.js';

// Define a type for the station stream data.
export interface StationStream {
  station: Station;
  device: Device;
  metadata: StreamMetadata;
  videostream: Readable;
  audiostream: Readable;
  createdAt: number;
}

// Define a class for the local livestream manager.
export class LocalLivestreamManager extends EventEmitter {
  private stationStream: StationStream | null = null;
  private livestreamStartedAt: number | null = null;
  private startingPromise: Promise<StationStream> | null = null;
  private pendingStart: { reject: (error: Error) => void; cleanup: () => void } | null = null;
  private wantStream = false;

  private eufyClient: EufySecurity;
  private cameraDevice: CameraDevice;
  private home: EufyHome;
  private cameraLogger: LoggerService;
  private serial_number: string;

  constructor(home: EufyHome, eufyClient: EufySecurity, eufyDevice: EufyCamera, cameraDevice: CameraDevice, cameraLogger: LoggerService) {
    super();

    this.eufyClient = eufyClient;
    this.serial_number = eufyDevice.getSerial();
    this.cameraLogger = cameraLogger;
    this.home = home;
    this.cameraDevice = cameraDevice;

    this.initialize();

    this.eufyClient.on('station livestream start', this.onStationLivestreamStart.bind(this));
    this.eufyClient.on('station livestream stop', this.onStationLivestreamStop.bind(this));
  }

  // Initialize the manager.
  private initialize() {
    this.stationStream?.audiostream.unpipe();
    this.stationStream?.audiostream.destroy();
    this.stationStream?.videostream.unpipe();
    this.stationStream?.videostream.destroy();
    this.stationStream = null;
    this.livestreamStartedAt = null;
  }

  // Get the local livestream.
  public async getLocalLivestream(): Promise<StationStream> {
    this.cameraLogger.debug(this.home.name, 'New instance requests livestream.');
    if (this.stationStream) {
      const runtime = (Date.now() - this.livestreamStartedAt!) / 1000;
      this.cameraLogger.debug(this.home.name, `Using livestream that was started ${runtime} seconds ago.`);
      return this.stationStream;
    }

    this.startingPromise ??= this.startAndGetLocalLiveStream().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  // Start and get the local livestream.
  private startAndGetLocalLiveStream(): Promise<StationStream> {
    return new Promise<StationStream>((resolve, reject) => {
      this.cameraLogger.debug(this.home.name, 'Start new station livestream...');
      this.wantStream = true;

      const cleanup = (): void => {
        clearTimeout(hardStop);
        this.off('livestream start', onStart);
        this.pendingStart = null;
      };

      const onStart = (): void => {
        cleanup();
        if (this.stationStream) {
          this.cameraLogger.debug(this.home.name, 'New livestream started.');
          resolve(this.stationStream);
        } else {
          reject(new Error('No started livestream found'));
        }
      };

      const hardStop = setTimeout(() => {
        cleanup();
        this.stopLocalLiveStream();
        reject(new Error('Eufy P2P livestream did not start within 60s'));
      }, 60 * 1000);

      this.pendingStart = { reject, cleanup };
      this.once('livestream start', onStart);
      this.eufyClient.startStationLivestream(this.serial_number);
    });
  }

  // Stop the local livestream.
  public stopLocalLiveStream(): void {
    this.cameraLogger.debug(this.home.name, 'Stopping station livestream.');
    this.wantStream = false;

    // Cancel an in-flight start so its timer/listener don't dangle and a late P2P
    // completion can't resolve an already-abandoned request.
    if (this.pendingStart) {
      const { reject, cleanup } = this.pendingStart;
      cleanup();
      reject(new Error('Livestream start cancelled'));
    }

    this.eufyClient.stopStationLivestream(this.serial_number);
    this.initialize();
  }

  // Handle the station livestream stop event.
  private onStationLivestreamStop(station: Station, device: Device) {
    if (device.getSerial() === this.serial_number) {
      this.cameraLogger.debug(this.home.name, `${station.getName()} station livestream for ${device.getName()} has stopped.`);
      this.initialize();
    }
  }

  // Handle the station livestream start event.
  private async onStationLivestreamStart(station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable) {
    if (device.getSerial() === this.serial_number) {
      // The P2P negotiation finished after the consumer gave up (e.g. go2rtc timed
      // out). The library can't cancel a connecting session, so it completes here —
      // stop it now instead of caching an orphan that would later be reused stale.
      if (!this.wantStream) {
        this.cameraLogger.debug(this.home.name, 'Livestream started after the consumer left; stopping it.');
        this.eufyClient.stopStationLivestream(this.serial_number);
        return;
      }

      if (this.stationStream) {
        const diff = (Date.now() - this.stationStream.createdAt) / 1000;
        if (diff < 5) {
          this.cameraLogger.warn(this.home.name, 'Second livestream was started from station. Ignore.');
          return;
        }
      }

      this.initialize(); // important to prevent unwanted behaviour when the eufy station emits the 'livestream start' event multiple times

      this.cameraLogger.debug(this.home.name, station.getName() + ' station livestream (P2P session) for ' + device.getName() + ' has started.');
      this.livestreamStartedAt = Date.now();
      const createdAt = Date.now();

      this.stationStream = { station, device, metadata, videostream, audiostream, createdAt };
      this.cameraLogger.debug(this.home.name, 'Stream metadata: ', this.stationStream.metadata);

      this.emit('livestream start');
    }
  }
}
