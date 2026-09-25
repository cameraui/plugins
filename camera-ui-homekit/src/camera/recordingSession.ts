import { EventEmitter } from 'node:events';

import { normalizeFragmentTfdt, ntpToMilliseconds, prependProducerReferenceTime } from '../utils/fmp4.js';

import type { CameraDevice, Fmp4Session, Fmp4VideoInfo, LoggerService } from '@camera.ui/sdk';
import type { CameraRecordingConfiguration } from '../hap.js';
import type { CameraAccessory } from './accessory.js';

interface LiveConsumer {
  queue: Buffer[];
  resolve: ((box: Buffer | null) => void) | null;
  error?: Error;
  closed?: boolean;
}

export interface ClipStreamOptions {
  start?: bigint;
  stop?: bigint;
  signal?: AbortSignal;
}

export type ClipPart =
  { type: 'init'; data: Buffer; startedAt: number; videoInfo: Fmp4VideoInfo | undefined } | { type: 'fragment'; data: Buffer; duration: number; last: boolean };

export class RecordingSession extends EventEmitter {
  private static readonly maxLiveQueueFragments = 8;

  private readonly logPrefix = '[HKSV]';
  private readonly fragmentTimeout = 8000;
  private readonly sessionRestartDelay = 3000;

  private session?: Fmp4Session;
  private sessionSubscriptions: { unsubscribe(): void }[] = [];
  private configuration?: CameraRecordingConfiguration;

  private batteryRequests = 0;
  private batteryTimer?: NodeJS.Timeout;
  private batteryRetryAfter = 0;
  private recordingActive = false;
  private stopped = false;
  private deferred = false;
  private lifecycle = Promise.resolve();
  private lifecycleRevision = 0;

  private prebuffer: Buffer[] = [];
  private receivedAt = new WeakMap<Buffer, number>();
  private prebufferMaxFragments = 2;
  private collectAbort?: AbortController;
  private restartTimeout?: NodeJS.Timeout;

  private consumers = new Set<LiveConsumer>();
  private hdsConsumer?: LiveConsumer;

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
      this.stopPrebuffer();
    }
  }

  public refreshBatteryState(): void {
    if (this.cameraAccessory.batteryPowered && (!this.cameraAccessory.batteryRecordingAllowed || this.batteryRequests === 0)) {
      void this.stopPrebuffer();
    }
  }

  public refreshPrebuffer(): void {
    if (this.recordingActive && !this.stopped) {
      this.restartPrebuffer();
    }
  }

  public resumePrebuffer(): void {
    if (this.recordingActive && !this.stopped && this.deferred) {
      this.restartPrebuffer();
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

    const onDemand = this.cameraAccessory.batteryPowered;
    const session = await this.acquireRecordingSession(signal);

    const tfdtOffsets = new Map<number, bigint>();
    const buffered = [...this.prebuffer];
    const consumer = this.addConsumer();
    this.hdsConsumer = consumer;

    try {
      this.logger.debug(this.logPrefix, 'Yielding init segment');
      const initSegment = await this.waitForRecording(session.initSegment, signal, 'Init segment timeout');
      const sampleEntry = ['hvc1', 'hev1', 'avc1', 'avc3'].find((tag) => initSegment.includes(tag)) ?? 'unknown';
      this.logger.debug(this.logPrefix, `Init segment ${initSegment.length} bytes, sample entry ${sampleEntry}`);
      yield initSegment;

      if (buffered.length > 0) {
        this.logger.debug(this.logPrefix, `Yielding ${buffered.length} prebuffered fragments`);
        for (const fragment of buffered) {
          if (signal?.aborted) {
            return;
          }
          yield this.prepareFragment(fragment, tfdtOffsets);
        }
      }

      this.logger.debug(this.logPrefix, 'Yielding live fragments');
      for await (const box of this.liveFragments(consumer, signal)) {
        yield this.prepareFragment(box, tfdtOffsets);
      }
    } catch (error) {
      if (signal?.aborted) {
        this.logger.debug(this.logPrefix, 'Recording stream aborted');
        return;
      }

      this.logger.error(this.logPrefix, 'Error in recording stream:', error);
      throw error;
    } finally {
      this.removeConsumer(consumer);
      if (this.hdsConsumer === consumer) {
        this.hdsConsumer = undefined;
      }
      if (onDemand) await this.releaseBatterySession(session);
    }
  }

  public async *getClipStream(options: ClipStreamOptions): AsyncGenerator<ClipPart, void> {
    const { signal } = options;
    const onDemand = this.cameraAccessory.batteryPowered;
    const session = await this.acquireRecordingSession(signal);
    const fragmentLength = this.fragmentLength();
    const startMs = options.start === undefined ? 0 : ntpToMilliseconds(options.start);
    const stopMs = options.stop === undefined ? Infinity : ntpToMilliseconds(options.stop);
    const tfdtOffsets = new Map<number, bigint>();
    const buffered = this.prebuffer.filter((fragment) => this.fragmentEnd(fragment) > startMs);
    const consumer = this.addConsumer();

    try {
      const initSegment = await this.waitForRecording(session.initSegment, signal, 'Init segment timeout');
      const firstStart = (buffered.length > 0 ? this.fragmentEnd(buffered[0]) : Date.now()) - fragmentLength;
      yield { type: 'init', data: initSegment, startedAt: Math.max(startMs, firstStart), videoInfo: session.videoInfo };

      for (const fragment of buffered) {
        if (signal?.aborted) {
          return;
        }
        const last = this.fragmentEnd(fragment) >= stopMs;
        yield { type: 'fragment', data: normalizeFragmentTfdt(fragment, tfdtOffsets), duration: fragmentLength / 1000, last };
        if (last) {
          return;
        }
      }

      for await (const box of this.liveFragments(consumer, signal)) {
        const end = this.fragmentEnd(box);
        if (end - fragmentLength >= stopMs) {
          return;
        }
        const last = end >= stopMs;
        yield { type: 'fragment', data: normalizeFragmentTfdt(box, tfdtOffsets), duration: fragmentLength / 1000, last };
        if (last) {
          return;
        }
      }
    } finally {
      this.removeConsumer(consumer);
      if (onDemand) await this.releaseBatterySession(session);
    }
  }

  private async acquireRecordingSession(signal?: AbortSignal): Promise<Fmp4Session> {
    signal?.throwIfAborted();
    if (!this.cameraAccessory.batteryPowered) {
      if (!this.session) throw new Error('FMP4 session unavailable');
      return this.session;
    }
    let result: Fmp4Session | undefined;
    await this.enqueueLifecycle(async () => {
      signal?.throwIfAborted();
      if (
        this.stopped ||
        !this.recordingActive ||
        !this.configuration ||
        this.cameraDevice.disabled ||
        !this.cameraDevice.connected ||
        !this.cameraAccessory.batteryRecordingAllowed ||
        Date.now() < this.batteryRetryAfter
      ) {
        throw new Error('Battery recording unavailable: low/unknown battery, offline or cooling down');
      }
      try {
        if (!this.session) {
          const session = await this.startSession();
          signal?.throwIfAborted();
          if (this.stopped || !this.recordingActive || !this.cameraAccessory.batteryRecordingAllowed) throw new Error('Battery recording cancelled');
          this.startCollector(session);
          this.batteryTimer = setTimeout(() => {
            void this.stopPrebuffer();
          }, 60_000);
        }
        this.batteryRequests++;
        result = this.session;
      } catch (error) {
        this.batteryRetryAfter = Date.now() + 30_000;
        await this.stopSession();
        throw error;
      }
    });
    if (!result) throw new Error('Battery recording unavailable');
    return result;
  }

  private async releaseBatterySession(session: Fmp4Session): Promise<void> {
    if (this.session !== session) return;
    this.batteryRequests = Math.max(0, this.batteryRequests - 1);
    if (!this.batteryRequests) await this.stopPrebuffer();
  }

  public closeCurrentRecording(): void {
    const consumer = this.hdsConsumer;
    this.hdsConsumer = undefined;
    if (consumer) {
      this.closeConsumer(consumer);
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.recordingActive = false;
    await this.stopPrebuffer();
  }

  private stopPrebuffer(): Promise<void> {
    ++this.lifecycleRevision;
    this.deferred = false;
    this.clearRestart();
    if (this.batteryTimer) clearTimeout(this.batteryTimer);
    this.batteryTimer = undefined;
    if (this.cameraAccessory.batteryPowered && this.session) this.batteryRetryAfter = Date.now() + 30_000;
    this.closeConsumers();
    this.collectAbort?.abort();
    this.prebuffer = [];

    return this.enqueueLifecycle(() => this.stopSession());
  }

  private restartPrebuffer(): void {
    if (this.cameraAccessory.batteryPowered) {
      this.refreshBatteryState();
      return;
    }
    const revision = ++this.lifecycleRevision;
    this.clearRestart();
    this.closeConsumers();
    this.collectAbort?.abort();
    this.prebuffer = [];

    this.enqueueLifecycle(async () => {
      await this.stopSession();

      if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive || !this.configuration) {
        return;
      }

      if (this.cameraAccessory.batteryPowered || this.cameraDevice.disabled || !this.cameraDevice.connected) {
        this.logger.debug(this.logPrefix, 'Camera unavailable, prebuffer deferred');
        this.deferred = true;
        return;
      }

      try {
        const session = await this.startSession();
        if (revision !== this.lifecycleRevision || this.stopped || !this.recordingActive) {
          await this.stopSession(session);
          return;
        }
        this.startCollector(session);
        this.deferred = false;
      } catch (error) {
        this.logger.error(this.logPrefix, 'Failed to start prebuffer session:', error);
        this.deferred = true;
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
      supportedVideoCodecs: this.cameraAccessory.secureVideoCodec === 'hevc' ? ['h264', 'hevc'] : ['h264'],
      supportedAudioCodecs: ['aac'],
      boxMode: true,
      fragDuration: (this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000) * 1000,
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAccelerationForRecording ? 'auto' : undefined,
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
              if (this.recordingActive && !this.stopped) {
                this.deferred = true;
              }
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

    if (this.batteryTimer) clearTimeout(this.batteryTimer);
    this.batteryTimer = undefined;
    if (this.cameraAccessory.batteryPowered) this.batteryRetryAfter = Date.now() + 30_000;

    this.session = undefined;
    this.batteryRequests = 0;
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
    if (this.cameraAccessory.batteryPowered || this.stopped || !this.recordingActive || this.restartTimeout) {
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

  private prepareFragment(fragment: Buffer, tfdtOffsets: Map<number, bigint>): Buffer {
    const normalized = normalizeFragmentTfdt(fragment, tfdtOffsets);
    if (this.cameraAccessory.secureVideoCodec !== 'hevc') {
      return normalized;
    }

    return prependProducerReferenceTime(normalized, this.fragmentEnd(fragment) - this.fragmentLength());
  }

  private fragmentLength(): number {
    return this.configuration?.mediaContainerConfiguration?.fragmentLength ?? 4000;
  }

  private fragmentEnd(fragment: Buffer): number {
    return this.receivedAt.get(fragment) ?? Date.now();
  }

  private async *liveFragments(consumer: LiveConsumer, signal?: AbortSignal): AsyncGenerator<Buffer, void> {
    while (!signal?.aborted && !consumer.closed) {
      if (consumer.error) {
        throw new Error(consumer.error.message, { cause: consumer.error });
      }

      let box: Buffer | null;
      if (consumer.queue.length > 0) {
        box = consumer.queue.shift()!;
      } else {
        box = await this.waitForRecording(
          new Promise<Buffer | null>((resolve) => {
            consumer.resolve = resolve;
          }),
          signal,
          'Fragment timeout',
        );
      }

      if (box === null) {
        return;
      }
      yield box;
    }
  }

  private addConsumer(): LiveConsumer {
    const consumer: LiveConsumer = { queue: [], resolve: null };
    this.consumers.add(consumer);
    return consumer;
  }

  private removeConsumer(consumer: LiveConsumer): void {
    this.consumers.delete(consumer);
  }

  private closeConsumer(consumer: LiveConsumer): void {
    this.consumers.delete(consumer);
    consumer.closed = true;
    const resolve = consumer.resolve;
    consumer.resolve = null;
    resolve?.(null);
  }

  private closeConsumers(): void {
    this.hdsConsumer = undefined;
    for (const consumer of [...this.consumers]) {
      this.closeConsumer(consumer);
    }
  }

  private pushBox(box: Buffer): void {
    this.receivedAt.set(box, Date.now());
    this.prebuffer.push(box);
    while (this.prebuffer.length > this.prebufferMaxFragments) {
      this.prebuffer.shift();
    }

    for (const consumer of this.consumers) {
      if (consumer.resolve) {
        const resolve = consumer.resolve;
        consumer.resolve = null;
        resolve(box);
      } else if (consumer.queue.length >= RecordingSession.maxLiveQueueFragments) {
        consumer.error = new Error(`HKSV consumer too slow: recording ended after ${RecordingSession.maxLiveQueueFragments} queued fragments`);
        consumer.queue.length = 0;
      } else {
        consumer.queue.push(box);
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
