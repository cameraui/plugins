import { EventEmitter } from 'node:events';

import { normalizeFragmentTfdt } from '../utils/fmp4.js';

import type { CameraDevice, Fmp4Session, LoggerService } from '@camera.ui/sdk';
import type { CameraRecordingConfiguration } from '../hap.js';
import type { CameraAccessory } from './accessory.js';

export class RecordingSession extends EventEmitter {
  private static readonly maxLiveQueueFragments = 8;

  private readonly logPrefix = '[HKSV]';
  private readonly fragmentTimeout = 8000;
  private readonly sessionRestartDelay = 3000;

  private session?: Fmp4Session;
  private sessionSubscriptions: { unsubscribe(): void }[] = [];
  private configuration?: CameraRecordingConfiguration;

  private recordingActive = false;
  private stopped = false;
  private lifecycle = Promise.resolve();
  private lifecycleRevision = 0;

  private prebuffer: Buffer[] = [];
  private prebufferMaxFragments = 2;
  private collectAbort?: AbortController;
  private restartTimeout?: NodeJS.Timeout;

  private liveQueue: Buffer[] | null = null;
  private liveResolve: ((box: Buffer | null) => void) | null = null;
  private liveError?: Error;

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
      this.restartPrebuffer();
    } else {
      void this.stopPrebuffer();
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

    if (this.recordingActive) {
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

    const tfdtOffsets = new Map<number, bigint>();
    const buffered = [...this.prebuffer];
    const queue: Buffer[] = [];
    this.liveQueue = queue;
    this.liveResolve = null;
    this.liveError = undefined;

    try {
      this.logger.debug(this.logPrefix, 'Yielding init segment');
      const initSegment = await this.waitForRecording(session.initSegment, signal, 'Init segment timeout');
      yield initSegment;

      if (buffered.length > 0) {
        this.logger.debug(this.logPrefix, `Yielding ${buffered.length} prebuffered fragments`);
        for (const fragment of buffered) {
          if (signal?.aborted) {
            return;
          }
          yield normalizeFragmentTfdt(fragment, tfdtOffsets);
        }
      }

      this.logger.debug(this.logPrefix, 'Yielding live fragments');
      while (!signal?.aborted) {
        if (this.liveError) {
          const liveError = this.liveError as Error;
          throw new Error(liveError.message, { cause: liveError });
        }

        let box: Buffer | null;
        if (queue.length > 0) {
          box = queue.shift()!;
        } else {
          box = await this.waitForRecording(
            new Promise<Buffer | null>((resolve) => {
              this.liveResolve = resolve;
            }),
            signal,
            'Fragment timeout',
          );
        }

        if (box === null) {
          break;
        }

        yield normalizeFragmentTfdt(box, tfdtOffsets);
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
        this.liveError = undefined;
      }
    }
  }

  public closeCurrentRecording(): void {
    const resolve = this.liveResolve;
    this.liveResolve = null;
    this.liveQueue = null;
    resolve?.(null);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.recordingActive = false;
    await this.stopPrebuffer();
  }

  private stopPrebuffer(): Promise<void> {
    ++this.lifecycleRevision;
    this.clearRestart();
    this.closeCurrentRecording();
    this.collectAbort?.abort();
    this.prebuffer = [];

    return this.enqueueLifecycle(() => this.stopSession());
  }

  private restartPrebuffer(): void {
    const revision = ++this.lifecycleRevision;
    this.clearRestart();
    this.closeCurrentRecording();
    this.collectAbort?.abort();
    this.prebuffer = [];

    void this.enqueueLifecycle(async () => {
      await this.stopSession();

      if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive || !this.configuration) {
        return;
      }

      try {
        const session = await this.startSession();
        if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive) {
          await this.stopSession(session);
          return;
        }
        this.startCollector(session);
      } catch (error) {
        this.logger.error(this.logPrefix, 'Failed to start prebuffer session:', error);
        await this.stopSession();
        this.scheduleRestart();
      }
    });
  }

  private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(task, task);
    this.lifecycle = next.catch((error) => {
      this.logger.error(this.logPrefix, 'Session lifecycle error:', error);
    });
    return next;
  }

  private async startSession(): Promise<Fmp4Session> {
    this.logger.debug(this.logPrefix, 'Starting FMP4 session');

    const session = this.cameraDevice.streamSource.createFmp4Session({
      audio: true,
      video: true,
      backchannel: false,
      gop: false,
    });

    this.session = session;
    this.sessionSubscriptions = [
      session.onError.subscribe((error) => {
        this.logger.warn(this.logPrefix, 'FMP4 session error:', error.message);
      }),
      session.onEnded.subscribe(() => {
        this.logger.debug(this.logPrefix, 'FMP4 session ended');
        this.emit('session-ended');
      }),
    ];

    await session.startStream({
      supportedVideoCodecs: ['h264'],
      supportedAudioCodecs: ['aac'],
      boxMode: true,
      fragDuration: (this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000) * 1000,
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAcceleration ? 'auto' : undefined,
      video: {
        width: this.configuration?.videoCodec.resolution[0],
        height: this.configuration?.videoCodec.resolution[1],
        fps: this.configuration?.videoCodec.resolution[2],
        bitrate: this.configuration?.videoCodec.parameters.bitRate ? this.configuration.videoCodec.parameters.bitRate * 1000 : undefined,
      },
    });

    this.logger.debug(this.logPrefix, 'FMP4 session started');
    return session;
  }

  private startCollector(session: Fmp4Session): void {
    const abort = new AbortController();
    this.collectAbort = abort;

    void (async () => {
      try {
        for await (const box of session.streamBoxes(abort.signal)) {
          this.pushBox(box);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          this.logger.error(this.logPrefix, 'Prebuffer collection error:', error);
        }
      } finally {
        if (this.collectAbort === abort) {
          this.collectAbort = undefined;
          await this.enqueueLifecycle(async () => {
            if (this.session === session) {
              await this.stopSession(session);
              this.scheduleRestart();
            }
          });
        }
      }
    })();
  }

  private async stopSession(expectedSession?: Fmp4Session): Promise<void> {
    const session = this.session;
    if (!session || (expectedSession && session !== expectedSession)) {
      return;
    }

    this.session = undefined;
    this.collectAbort?.abort();
    this.collectAbort = undefined;
    this.sessionSubscriptions.forEach((subscription) => subscription.unsubscribe());
    this.sessionSubscriptions = [];

    this.logger.debug(this.logPrefix, 'Stopping FMP4 session');
    try {
      await session.stop();
    } catch (error) {
      this.logger.error(this.logPrefix, 'Error stopping FMP4 session:', error);
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || !this.recordingActive || this.restartTimeout) {
      return;
    }
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = undefined;
      if (this.recordingActive && !this.stopped) {
        this.restartPrebuffer();
      }
    }, this.sessionRestartDelay);
  }

  private clearRestart(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = undefined;
    }
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
      } else if (this.liveQueue.length >= RecordingSession.maxLiveQueueFragments) {
        this.liveError = new Error(`HKSV consumer too slow: recording ended after ${RecordingSession.maxLiveQueueFragments} queued fragments`);
        this.liveQueue.length = 0;
      } else {
        this.liveQueue.push(box);
      }
    }
  }

  private async waitForRecording<T>(promise: Promise<T>, signal: AbortSignal | undefined, errorMessage: string): Promise<T> {
    if (signal?.aborted) {
      throw new Error('Recording stream aborted');
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(errorMessage)), this.fragmentTimeout);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (signal) {
        abortHandler = () => reject(new Error('Recording stream aborted'));
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });

    try {
      return await Promise.race([promise, timeout, aborted]);
    } finally {
      clearTimeout(timeoutId);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}
