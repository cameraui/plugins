import { BackchannelTranscoder } from '@seydx/rtsp';

import type { Device, TalkbackHandle } from '@mega-yfue/eufy-sdk';
import type { BackchannelAdvertise, Logger } from '@seydx/rtsp';

export const TALKBACK_ADVERTISE: BackchannelAdvertise = { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 };

// the device only plays AAC-LC 16 kHz mono in ADTS, frames above ~32 kbps get dropped
const TALKBACK_TARGET = { codec: 'aac', sampleRate: 16000, channels: 1, format: 'adts', bitRate: 32000 } as const;
const IDLE_STOP_MS = 2000;
const MAX_PENDING_CHUNKS = 64;

export class EufyTalkback {
  private transcoder?: BackchannelTranscoder;
  private starting?: Promise<void>;
  private handle?: TalkbackHandle;
  private opening?: Promise<void>;
  private pending: Buffer[] = [];
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly device: Device,
    private readonly logger: Logger,
  ) {}

  public push(rtp: Buffer): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);

    if (!this.transcoder) {
      this.transcoder = new BackchannelTranscoder({
        from: { ...TALKBACK_ADVERTISE },
        to: { ...TALKBACK_TARGET },
        output: (chunk) => this.write(chunk),
        onError: (error) => this.logger.error?.('Talkback transcoding failed:', error),
        logger: this.logger,
      });
      this.starting = this.transcoder.start();
    }

    const transcoder = this.transcoder;
    this.starting?.then(() => transcoder.push(rtp)).catch((error) => this.logger.error?.('Talkback transcoder did not start:', error));
  }

  public async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.pending = [];

    const transcoder = this.transcoder;
    const handle = this.handle;
    this.transcoder = undefined;
    this.starting = undefined;
    this.handle = undefined;

    await transcoder?.close().catch(() => undefined);
    await handle?.stop().catch(() => undefined);
  }

  private write(chunk: Buffer): void {
    if (this.handle) {
      this.handle.write(chunk);
      return;
    }
    if (this.pending.length < MAX_PENDING_CHUNKS) this.pending.push(chunk);
    this.opening ??= this.open().finally(() => (this.opening = undefined));
  }

  private async open(): Promise<void> {
    const talkback = this.device.camera?.()?.talkback;
    if (!talkback) {
      this.logger.warn?.(`${this.device.name} has no speaker, two-way audio is not available`);
      return;
    }

    try {
      const handle = await talkback();
      handle.on('error', (error) => this.logger.warn?.(`Talkback on ${this.device.name}: ${error.message}`));
      handle.on('stop', () => {
        if (this.handle === handle) this.handle = undefined;
      });

      if (!this.transcoder) {
        await handle.stop();
        return;
      }

      this.handle = handle;
      const pending = this.pending;
      this.pending = [];
      for (const chunk of pending) handle.write(chunk);
    } catch (error) {
      this.pending = [];
      this.logger.error?.(`Could not start talkback on ${this.device.name}:`, error);
    }
  }
}
