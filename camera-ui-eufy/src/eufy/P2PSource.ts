import { buildAacEldConfig, MultiSource, RawAudioTranscoder } from '@seydx/rtsp';
import { AudioCodec, VideoCodec } from 'eufy-security-client';

import type { Logger, MediaPacket, MultiSourceInput, Source, StreamInfo } from '@seydx/rtsp';
import type { LocalLivestreamManager } from './LocalLiveStreamManager.js';

const ELD_SAMPLE_RATE = 16000;
const ELD_CHANNELS = 1;
const ELD_FRAME_LENGTH = 480;

export class EufyP2PSource implements Source {
  private multi?: MultiSource;
  private eldTranscoder?: RawAudioTranscoder;
  private closed = false;

  constructor(
    private readonly manager: LocalLivestreamManager,
    private readonly logger?: Logger,
  ) {}

  async open(): Promise<StreamInfo> {
    this.closed = false;
    const stream = await this.manager.getLocalLivestream();

    // Consumer may have given up during the slow P2P negotiation — release the livestream and abort.
    if (this.closed) {
      this.manager.stopLocalLiveStream();
      throw new Error('EufyP2PSource closed during open');
    }

    const inputs: MultiSourceInput[] = [
      {
        input: stream.videostream,
        format: videoFormatOf(stream.metadata.videoCodec),
        options: { framerate: String(stream.metadata.videoFPS || 15) },
      },
    ];
    if (hasAudio(stream.metadata.audioCodec)) {
      if (stream.metadata.audioCodec === AudioCodec.AAC_ELD) {
        this.eldTranscoder = new RawAudioTranscoder({
          from: {
            codec: 'aac',
            decoder: 'libfdk_aac',
            sampleRate: ELD_SAMPLE_RATE,
            channels: ELD_CHANNELS,
            samplesPerFrame: ELD_FRAME_LENGTH,
            config: buildAacEldConfig(ELD_SAMPLE_RATE, ELD_CHANNELS, ELD_FRAME_LENGTH),
          },
          to: { bitRate: 32000 },
          logger: this.logger,
          onError: (error) => this.logger?.error?.('Eufy ELD audio transcode failed — audio stops until the next stream start:', error),
        });
        await this.eldTranscoder.start();
        stream.audiostream.on('data', (frame: Buffer) => this.eldTranscoder?.push(frame));
        inputs.push({ input: this.eldTranscoder.stream, format: 'aac' });
      } else {
        inputs.push({ input: stream.audiostream, format: 'aac' });
      }
    }

    this.multi = new MultiSource(inputs, { logger: this.logger });
    return this.multi.open();
  }

  packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    if (!this.multi) throw new Error('EufyP2PSource.open() must be called before packets()');
    return this.multi.packets(signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.multi?.close();
    } finally {
      this.multi = undefined;
      await this.eldTranscoder?.close().catch(() => undefined);
      this.eldTranscoder = undefined;
      this.manager.stopLocalLiveStream();
    }
  }
}

function videoFormatOf(codec: VideoCodec): string {
  return codec === VideoCodec.H265 ? 'hevc' : 'h264';
}

function hasAudio(codec: AudioCodec): boolean {
  return codec !== AudioCodec.NONE && codec !== AudioCodec.UNKNOWN;
}
