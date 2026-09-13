import { buildAacEldConfig, MultiSource, RawAudioTranscoder, wrapAvPacket } from '@seydx/rtsp';
import { PassThrough } from 'node:stream';

import { StationClock, TrackTimeline } from './timeline.js';

import type { Device, LiveAudioFrame, LiveStreamConsumer, LiveVideoConfig, LiveVideoFrame, StreamBudgetNotice } from '@mega-yfue/eufy-sdk';
import type { Logger, MediaPacket, MultiSourceInput, Source, StreamInfo, TrackInfo } from '@seydx/rtsp';

const AUDIO_PROBE_MS = 500;
const PROBE_TIMEOUT_MS = 45_000;
const ELD_SAMPLE_RATE = 16000;
const ELD_CHANNELS = 1;
const ELD_FRAME_LENGTH = 480;
const FALLBACK_VIDEO_STEP_S = 1 / 15;
const FALLBACK_AUDIO_STEP_S = 0.064;

interface Probe {
  config: LiveVideoConfig;
  audio?: LiveAudioFrame['codec'];
}

export class EufyLiveSource implements Source {
  private consumer?: LiveStreamConsumer;
  private multi?: MultiSource;
  private tracks: TrackInfo[] = [];
  private stationClock = new StationClock();
  private videoTimeline = new TrackTimeline(this.stationClock, 'frames', FALLBACK_VIDEO_STEP_S);
  private audioTimeline = new TrackTimeline(this.stationClock, 'samples', FALLBACK_AUDIO_STEP_S);
  private eldTranscoder?: RawAudioTranscoder;
  private video?: PassThrough;
  private audio?: PassThrough;
  private audioCodec?: LiveAudioFrame['codec'];
  private videoCodec?: LiveVideoConfig['codec'];
  private pendingAudio: LiveAudioFrame[] = [];
  private audioDecided = false;
  private keyframeSeen = false;
  private startedAt = 0;
  private closed = false;
  private abortProbe?: (error: Error) => void;

  constructor(
    private readonly device: Device,
    private readonly maxDurationMs: number,
    private readonly logger: Logger,
  ) {}

  public async open(): Promise<StreamInfo> {
    this.closed = false;
    this.audioDecided = false;
    this.keyframeSeen = false;
    this.pendingAudio = [];
    this.stationClock = new StationClock();
    this.videoTimeline = new TrackTimeline(this.stationClock, 'frames', FALLBACK_VIDEO_STEP_S);
    this.audioTimeline = new TrackTimeline(this.stationClock, 'samples', FALLBACK_AUDIO_STEP_S);

    const live = this.device.camera?.()?.live;
    if (!live) throw new Error(`${this.device.name} offers no live stream`);

    const consumer = await live();
    if (this.closed) {
      consumer.stop();
      throw closedError();
    }

    this.consumer = consumer;
    this.startedAt = Date.now();

    const video = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
    video.on('drain', () => consumer.resume());
    this.video = video;

    consumer.on('video', (frame) => this.writeVideo(frame));
    consumer.on('audio', (frame) => this.writeAudio(frame));
    consumer.on('budget', (notice) => this.extendBudget(notice));
    consumer.on('stop', () => this.endInputs());
    consumer.on('error', (error) => {
      this.logger.warn?.(`${this.device.name} live stream failed: ${error.message}`);
      this.endInputs();
    });

    try {
      const probe = await this.probe(consumer);
      this.videoCodec = probe.config.codec;
      if (probe.config.codec === 'av1') throw new Error(`${this.device.name} streams AV1, which the relay cannot serve`);

      const inputs: MultiSourceInput[] = [{ input: video, format: probe.config.codec === 'h265' ? 'hevc' : 'h264', options: { framerate: '15' } }];
      const audioInput = await this.createAudioInput(probe.audio);
      if (this.closed) throw closedError();
      if (audioInput) inputs.push(audioInput);
      this.flushAudio();

      const multi = new MultiSource(inputs, { logger: this.logger });
      this.multi = multi;
      const info = await multi.open();
      if (this.closed) throw closedError();

      this.tracks = info.tracks;
      return info;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    if (!this.multi) throw new Error('EufyLiveSource.open() must be called before packets()');
    for await (const packet of this.multi.packets(signal)) yield this.rebase(packet);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.abortProbe?.(closedError());
    this.consumer?.stop();
    this.consumer = undefined;
    this.endInputs();

    const multi = this.multi;
    const transcoder = this.eldTranscoder;
    this.multi = undefined;
    this.eldTranscoder = undefined;
    this.video = undefined;
    this.audio = undefined;
    this.audioCodec = undefined;
    this.videoCodec = undefined;
    this.tracks = [];

    try {
      await multi?.close();
    } finally {
      await transcoder?.close().catch(() => undefined);
    }
  }

  private probe(consumer: LiveStreamConsumer): Promise<Probe> {
    return new Promise<Probe>((resolve, reject) => {
      let config: LiveVideoConfig | undefined;
      let audioTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(audioTimer);
        clearTimeout(timeout);
        this.abortProbe = undefined;
        fn();
      };

      const timeout = setTimeout(() => settle(() => reject(new Error(`${this.device.name} sent no keyframe within ${PROBE_TIMEOUT_MS / 1000} s`))), PROBE_TIMEOUT_MS);
      this.abortProbe = (error) => settle(() => reject(error));

      consumer.on('video-config', (next) => {
        config = next;
      });
      consumer.on('video', (frame) => {
        if (settled || audioTimer || !frame.keyframe) return;
        const keyframeConfig: LiveVideoConfig = { codec: frame.codec, width: config?.width ?? frame.width, height: config?.height ?? frame.height };
        audioTimer = setTimeout(() => settle(() => resolve({ config: keyframeConfig })), AUDIO_PROBE_MS);
        consumer.on('audio', (audio) => settle(() => resolve({ config: keyframeConfig, audio: audio.codec })));
      });
      consumer.on('error', (error) => settle(() => reject(error)));
      consumer.on('stop', () => settle(() => reject(new Error(`${this.device.name} stopped streaming before the first keyframe`))));
    });
  }

  private async createAudioInput(codec: LiveAudioFrame['codec'] | undefined): Promise<MultiSourceInput | undefined> {
    if (codec === 'aac-lc') {
      this.audioCodec = codec;
      this.audio = new PassThrough();
      return { input: this.audio, format: 'aac' };
    }

    if (codec === 'aac-eld') {
      this.audioCodec = codec;
      const transcoder = new RawAudioTranscoder({
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
        onError: (error) => this.logger.error?.('AAC-ELD transcoding failed, audio stops until the stream restarts:', error),
      });
      this.eldTranscoder = transcoder;
      this.audioTimeline = new TrackTimeline(this.stationClock, 'resampled', FALLBACK_AUDIO_STEP_S);
      await transcoder.start();
      return { input: transcoder.stream, format: 'aac' };
    }

    if (codec) this.logger.warn?.(`${this.device.name} sends ${codec} audio, which is not relayed. Serving video only.`);
    return undefined;
  }

  private writeVideo(frame: LiveVideoFrame): void {
    const video = this.video;
    if (!video || video.writableEnded) return;
    // a demuxer fed delta frames before the parameter sets cannot probe the stream
    if (!this.keyframeSeen) {
      if (!frame.keyframe) return;
      this.keyframeSeen = true;
      if (frame.timestamp !== undefined) this.stationClock.start(frame.timestamp);
    }
    if (this.videoCodec && frame.codec !== this.videoCodec) {
      this.logger.warn?.(`${this.device.name} switched from ${this.videoCodec} to ${frame.codec}, restarting the stream`);
      this.endInputs();
      return;
    }
    this.videoTimeline.push(frame.timestamp);
    if (!video.write(frame.data)) this.consumer?.pause();
  }

  private writeAudio(frame: LiveAudioFrame): void {
    if (!this.keyframeSeen) return;
    if (!this.audioDecided) {
      this.pendingAudio.push(frame);
      return;
    }
    if (frame.codec !== this.audioCodec) return;

    if (this.eldTranscoder) {
      this.audioTimeline.push(frame.timestamp);
      this.eldTranscoder.push(stripAdts(frame.data));
    } else if (this.audio && !this.audio.writableEnded) {
      this.audioTimeline.push(frame.timestamp);
      this.audio.write(frame.data);
    }
  }

  private flushAudio(): void {
    this.audioDecided = true;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    for (const frame of pending) this.writeAudio(frame);
  }

  private extendBudget(notice: StreamBudgetNotice): void {
    if (this.maxDurationMs > 0 && Date.now() - this.startedAt >= this.maxDurationMs) {
      this.logger.log?.(`${this.device.name} reached the maximum live stream duration, letting the stream stop`);
      return;
    }
    notice.extend();
  }

  private rebase(packet: MediaPacket): MediaPacket {
    const av = packet.av;
    const track = this.tracks[packet.streamIndex];
    const timeBase = track?.timeBase;
    if (!av || !track || !timeBase) return packet;

    const timeline = track.kind === 'audio' ? this.audioTimeline : this.videoTimeline;
    const duration = track.kind === 'audio' && av.duration > 0n ? (Number(av.duration) * timeBase.num) / timeBase.den : undefined;
    const pts = BigInt(Math.round((timeline.next(duration) * timeBase.den) / timeBase.num));

    av.pts = pts;
    av.dts = pts;
    return wrapAvPacket(av, packet.streamIndex);
  }

  private endInputs(): void {
    if (this.video && !this.video.writableEnded) this.video.end();
    if (this.audio && !this.audio.writableEnded) this.audio.end();
    // the transcoder output is its own stream and only ends on close
    void this.eldTranscoder?.close().catch(() => undefined);
  }
}

function closedError(): Error {
  return new Error('Eufy live source closed while the stream was starting');
}

function stripAdts(data: Buffer): Buffer {
  if (data.length < 7 || data[0] !== 0xff || (data[1] & 0xf0) !== 0xf0) return data;
  const frameLength = ((data[3] & 0x03) << 11) | (data[4] << 3) | (data[5] >> 5);
  if (frameLength !== data.length) return data;
  return data.subarray(data[1] & 0x01 ? 7 : 9);
}
