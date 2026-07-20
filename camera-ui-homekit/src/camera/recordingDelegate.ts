import { Characteristic, HDSProtocolError, HDSProtocolSpecificErrorReason, Service } from '../hap.js';
import { getHdsReason } from '../utils/utils.js';
import { RecordingSession } from './recordingSession.js';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type { Accessory, CameraRecordingConfiguration, CameraRecordingDelegate, RecordingPacket } from '../hap.js';
import type { CameraAccessory } from './accessory.js';

export class RecordingDelegate implements CameraRecordingDelegate {
  private readonly logPrefix = '[HKSV]';
  private readonly recordingSession: RecordingSession;

  private activeStreamId?: number;
  private logger: LoggerService;

  constructor(
    private cameraAccessory: CameraAccessory,
    private accessory: Accessory,
    private cameraDevice: CameraDevice,
  ) {
    this.logger = this.cameraDevice.logger;
    this.recordingSession = new RecordingSession(this.cameraAccessory, this.cameraDevice, this.logger);
  }

  public updateRecordingActive(active: boolean): void {
    this.recordingSession.updateRecordingActive(active);

    if (!active) {
      this.accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected).updateValue(false);
    }
  }

  public updateRecordingConfiguration(configuration?: CameraRecordingConfiguration): void {
    this.recordingSession.updateRecordingConfiguration(configuration);
  }

  public refreshPrebuffer(): void {
    this.recordingSession.refreshPrebuffer();
  }

  public async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    if (this.activeStreamId !== undefined) {
      this.logger.warn(this.logPrefix, `Stream ${streamId} rejected: stream ${this.activeStreamId} already active`);
      throw new HDSProtocolError(HDSProtocolSpecificErrorReason.BUSY);
    }

    this.activeStreamId = streamId;
    this.logger.log(this.logPrefix, `Recording stream ${streamId} started`);

    const startTime = Date.now();
    let packetCount = 0;
    let isFirstPacket = true;

    try {
      let pending: Buffer | undefined;

      for await (const buffer of this.recordingSession.getRecordingStream(signal)) {
        if (isFirstPacket) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          this.logger.debug(this.logPrefix, `Initialization fragment sent after ${elapsed}s`);
          isFirstPacket = false;
        }

        packetCount++;
        this.logger.debug(this.logPrefix, `Fragment ${packetCount}: ${buffer.length} bytes`);

        if (pending !== undefined) {
          yield { data: pending, isLast: false };
        }
        pending = buffer;
      }

      if (pending !== undefined) {
        yield { data: pending, isLast: true };
      }

      this.logger.log(this.logPrefix, `Recording stream ${streamId} completed (${packetCount} fragments)`);
    } catch (error) {
      this.logger.error(this.logPrefix, `Recording stream ${streamId} error:`, error);
      throw new HDSProtocolError(HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE);
    } finally {
      this.cleanup(streamId);
    }
  }

  public acknowledgeStream(streamId: number): void {
    this.logger.debug(this.logPrefix, `Stream ${streamId} acknowledged`);

    if (this.activeStreamId === streamId) {
      this.cleanup(streamId);
    }
  }

  public closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {
    this.logger.log(this.logPrefix, `Stream ${streamId} closed: ${getHdsReason(reason)}`);

    if (this.activeStreamId === streamId) {
      this.recordingSession.closeCurrentRecording();
      this.cleanup(streamId);
    }
  }

  public async stop(): Promise<void> {
    this.logger.debug(this.logPrefix, 'Stopping recording delegate');
    await this.recordingSession.stop();
    this.cleanup(this.activeStreamId);
  }

  private cleanup(streamId?: number): void {
    if (streamId !== undefined && this.activeStreamId === streamId) {
      this.activeStreamId = undefined;
    }
  }
}
