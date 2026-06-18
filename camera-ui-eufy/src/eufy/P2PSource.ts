import { MultiSource } from '@seydx/rtsp';
import { AudioCodec, VideoCodec } from 'eufy-security-client';

import type { Logger, MediaPacket, MultiSourceInput, Source, StreamInfo } from '@seydx/rtsp';
import type { LocalLivestreamManager } from './LocalLiveStreamManager.js';

export class EufyP2PSource implements Source {
  private multi?: MultiSource;
  private closed = false;

  constructor(
    private readonly manager: LocalLivestreamManager,
    private readonly logger?: Logger,
  ) {}

  async open(): Promise<StreamInfo> {
    this.closed = false;
    const stream = await this.manager.getLocalLivestream();

    // The consumer may have given up while the (slow) P2P negotiation was still in
    // flight. Don't build a source nobody will ever close — release the livestream
    // and abort the open instead.
    if (this.closed) {
      this.manager.stopLocalLiveStream();
      throw new Error('EufyP2PSource closed during open');
    }

    const inputs: MultiSourceInput[] = [{ input: stream.videostream, format: videoFormatOf(stream.metadata.videoCodec) }];
    if (hasAudio(stream.metadata.audioCodec)) {
      inputs.push({ input: stream.audiostream, format: 'aac' });
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
