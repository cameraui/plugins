import { EventEmitter } from 'node:events';

import { PromiseTimeout } from '../utils/utils.js';

import type { CameraDevice, Fmp4Session, LoggerService } from '@camera.ui/sdk';
import type { CameraRecordingConfiguration } from '../hap.js';
import type { CameraAccessory } from './accessory.js';

export class RecordingSession extends EventEmitter {
  private readonly logPrefix = '[HKSV]';
  private readonly fragmentTimeout = 8000;
  private readonly sessionRestartDelay = 3000;

  private session?: Fmp4Session;
  private configuration?: CameraRecordingConfiguration;

  private recordingActive = false;
  private stopped = false;

  private prebuffer: Buffer[] = [];
  private prebufferMaxFragments = 2;
  private collectAbort?: AbortController;
  private restartTimeout?: NodeJS.Timeout;

  private liveQueue: Buffer[] | null = null;
  private liveResolve: ((box: Buffer | null) => void) | null = null;

  constructor(
    private cameraAccessory: CameraAccessory,
    private cameraDevice: CameraDevice,
    private logger: LoggerService,
  ) {
    super();
  }

  public updateRecordingActive(active: boolean): void {
    this.logger.debug(this.logPrefix, `Recording active: ${active}`);
    if (this.recordingActive === active) {
      return;
    }
    this.recordingActive = active;

    if (active) {
      this.startPrebuffer();
    } else {
      this.stopPrebuffer();
    }
  }

  public updateRecordingConfiguration(configuration?: CameraRecordingConfiguration): void {
    this.configuration = configuration;
    this.logger.debug(this.logPrefix, 'Recording configuration updated:', configuration ?? 'No configuration');

    if (configuration) {
      const fragmentLength = configuration.mediaContainerConfiguration?.fragmentLength ?? 4000;
      const prebufferLength = configuration.prebufferLength ?? 4000;
      this.prebufferMaxFragments = Math.max(1, Math.ceil(prebufferLength / fragmentLength));
    }

    if (this.recordingActive && configuration) {
      this.restartPrebuffer();
    }
  }

  public async *getRecordingStream(signal?: AbortSignal): AsyncGenerator<Buffer, void> {
    if (!this.configuration) {
      throw new Error('No recording configuration set');
    }

    const session = this.session;
    if (!session) {
      throw new Error('FMP4 session unavailable');
    }

    const buffered = [...this.prebuffer];
    const queue: Buffer[] = [];
    this.liveQueue = queue;
    this.liveResolve = null;

    try {
      this.logger.debug(this.logPrefix, 'Yielding init segment');
      const initSegment = await PromiseTimeout(session.initSegment, this.fragmentTimeout, undefined, 'Init segment timeout');
      yield initSegment;

      if (buffered.length > 0) {
        this.logger.debug(this.logPrefix, `Yielding ${buffered.length} prebuffered fragments`);
        for (const fragment of buffered) {
          if (signal?.aborted) {
            return;
          }
          yield fragment;
        }
      }

      this.logger.debug(this.logPrefix, 'Yielding live fragments');
      while (!signal?.aborted) {
        let box: Buffer | null;
        if (queue.length > 0) {
          box = queue.shift()!;
        } else {
          box = await PromiseTimeout(
            new Promise<Buffer | null>((resolve) => {
              this.liveResolve = resolve;
            }),
            this.fragmentTimeout,
            undefined,
            'Fragment timeout',
          );
        }

        if (box === null) {
          break;
        }

        yield box;
      }
    } catch (error) {
      if (signal?.aborted) {
        this.logger.debug(this.logPrefix, 'Recording stream aborted');
        return;
      }

      this.logger.error(this.logPrefix, 'Error in recording stream:', error);
      throw error;
    } finally {
      if (this.liveQueue === queue) {
        this.liveQueue = null;
        this.liveResolve = null;
      }
    }
  }

  public closeCurrentRecording(): void {
    const resolve = this.liveResolve;
    this.liveResolve = null;
    this.liveQueue = null;
    resolve?.(null);
  }

  public stop(): void {
    this.stopped = true;
    this.recordingActive = false;
    this.stopPrebuffer();
  }

  private startPrebuffer(): void {
    if (this.stopped || !this.configuration) {
      return;
    }
    this.logger.debug(this.logPrefix, 'Starting prebuffer');
    void this.runPrebuffer();
  }

  private stopPrebuffer(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = undefined;
    }

    this.closeCurrentRecording();

    this.collectAbort?.abort();
    this.collectAbort = undefined;
    this.prebuffer = [];

    const session = this.session;
    if (session) {
      this.session = undefined;
      this.logger.debug(this.logPrefix, 'Stopping FMP4 session');
      session.stop().catch((error) => {
        this.logger.error(this.logPrefix, 'Error stopping FMP4 session:', error);
      });
    }
  }

  private restartPrebuffer(): void {
    this.stopPrebuffer();
    if (this.recordingActive && !this.stopped) {
      this.startPrebuffer();
    }
  }

  private async runPrebuffer(): Promise<void> {
    try {
      await this.ensureSessionStarted();
    } catch (error) {
      this.logger.error(this.logPrefix, 'Failed to start prebuffer session:', error);
      this.session = undefined;
      this.scheduleRestart();
      return;
    }

    const session = this.session;
    if (!session) {
      this.scheduleRestart();
      return;
    }

    const abort = new AbortController();
    this.collectAbort = abort;

    try {
      for await (const box of session.streamBoxes(abort.signal)) {
        this.pushBox(box);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger.error(this.logPrefix, 'Prebuffer collection error:', error);
      }
    }

    if (this.collectAbort === abort) {
      this.collectAbort = undefined;
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || !this.recordingActive || this.restartTimeout) {
      return;
    }
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = undefined;
      if (this.recordingActive && !this.stopped) {
        this.session = undefined;
        void this.runPrebuffer();
      }
    }, this.sessionRestartDelay);
  }

  private pushBox(box: Buffer): void {
    this.prebuffer.push(box);
    while (this.prebuffer.length > this.prebufferMaxFragments) {
      this.prebuffer.shift();
    }

    if (this.liveQueue) {
      if (this.liveResolve) {
        const resolve = this.liveResolve;
        this.liveResolve = null;
        resolve(box);
      } else {
        this.liveQueue.push(box);
      }
    }
  }

  private async ensureSessionStarted(): Promise<void> {
    if (this.session) {
      return;
    }

    this.logger.debug(this.logPrefix, 'Starting FMP4 session');

    const session = this.cameraDevice.streamSource.createFmp4Session({
      audio: true,
      video: true,
      backchannel: false,
      gop: false,
    });

    session.onEnded.subscribe(() => {
      this.logger.debug(this.logPrefix, 'FMP4 session ended; discarding');
      if (this.session === session) {
        this.session = undefined;
      }
      this.emit('session-ended');
    });

    this.session = session;

    await session.startStream({
      supportedVideoCodecs: ['h264'],
      supportedAudioCodecs: ['aac'],
      boxMode: true,
      fragDuration: (this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000) * 1000, // in microseconds
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAcceleration ? 'auto' : undefined,
      video: {
        width: this.configuration?.videoCodec.resolution[0],
        height: this.configuration?.videoCodec.resolution[1],
        fps: this.configuration?.videoCodec.resolution[2],
      },
    });

    this.logger.debug(this.logPrefix, 'FMP4 session started');
  }
}
