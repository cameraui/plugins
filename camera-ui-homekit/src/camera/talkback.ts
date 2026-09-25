import { audioPayloadType } from '../constants.js';
import { SFrameRtpDepacketizer } from './sframeRtp.js';

import type { LoggerService, RtpSession } from '@camera.ui/sdk';
import type { RtpPacket } from 'werift';
import type { SecureVideoSFrame, SFrameReceiver } from './sframe.js';

// packets seen per stream before the primary one is picked
const PROBE_PACKETS = 5;

interface TalkbackStream {
  receiver: SFrameReceiver;
  depacketizer: SFrameRtpDepacketizer;
  payloadType: number;
  packets: number;
  bytes: number;
  lastTimestamp?: number;
  timestampDelta?: number;
}

// the relay sends the viewer's microphone twice (voice and a low bitrate copy) with ssrcs and payload types it never
// announces in any SDP; the voice stream is picked by frame size and fed to the camera backchannel once decrypted
export class Talkback {
  private readonly streams = new Map<number, TalkbackStream>();
  private primary?: number;
  private ready = false;

  constructor(
    private stream: RtpSession,
    private sframe: SecureVideoSFrame,
    private logger: LoggerService,
  ) {}

  public push(rtp: RtpPacket): void {
    if (rtp.payload.length === 0) {
      return;
    }
    const talkback = this.track(rtp);
    if (this.primary === undefined) {
      this.pickPrimary();
    }
    if (rtp.header.ssrc === this.primary && this.ready) {
      this.forward(talkback, rtp);
    }
  }

  private track(rtp: RtpPacket): TalkbackStream {
    const { ssrc, payloadType, timestamp } = rtp.header;
    let talkback = this.streams.get(ssrc);
    if (!talkback) {
      talkback = { receiver: this.sframe.audioReceiver(ssrc), depacketizer: new SFrameRtpDepacketizer(), payloadType, packets: 0, bytes: 0 };
      this.streams.set(ssrc, talkback);
    }
    if (talkback.lastTimestamp !== undefined && timestamp !== talkback.lastTimestamp) {
      talkback.timestampDelta = (timestamp - talkback.lastTimestamp) >>> 0;
    }
    talkback.lastTimestamp = timestamp;
    talkback.packets++;
    talkback.bytes += rtp.payload.length;
    return talkback;
  }

  private pickPrimary(): void {
    const streams = [...this.streams.entries()];
    if (streams.some(([, candidate]) => candidate.packets < PROBE_PACKETS)) {
      return;
    }
    const [ssrc, chosen] = streams.reduce((best, entry) => (averageSize(entry[1]) > averageSize(best[1]) ? entry : best));
    this.primary = ssrc;

    const clockRate = clockRateFromTimestampDelta(chosen.timestampDelta);

    // prettier-ignore
    this.logger.debug(
      `[WebRTC] Talkback primary ssrc ${ssrc} pt ${chosen.payloadType} (${Math.round(averageSize(chosen))}B avg, opus/${clockRate}) ` +
      `of ${streams.map(([id, candidate]) => `${id}/pt${candidate.payloadType}`).join(' ')}`,
    );

    this.stream
      .startBackchannel({ decoderCodec: 'libopus', payloadType: audioPayloadType, clockRate, channels: 1, fmtp: 'minptime=20;useinbandfec=0' })
      .then(() => {
        this.ready = this.stream.hasBackchannel;
        if (!this.ready) {
          this.logger.warn('[WebRTC] Camera stream offers no backchannel, talkback dropped');
        }
      })
      .catch((error) => this.logger.warn('[WebRTC] Failed to start backchannel', error));
  }

  private forward(talkback: TalkbackStream, rtp: RtpPacket): void {
    try {
      const ciphertext = talkback.depacketizer.push(rtp);
      if (!ciphertext) {
        return;
      }
      rtp.payload = talkback.receiver.unprotectFrame(ciphertext);
      rtp.header.payloadType = audioPayloadType;
      this.stream.sendAudioPacket(rtp.serialize()).catch(() => undefined);
    } catch (error) {
      if (talkback.packets <= PROBE_PACKETS + 1) {
        this.logger.warn(`[WebRTC] Failed to receive audio (ssrc ${rtp.header.ssrc}, pt ${rtp.header.payloadType})`, error);
      }
    }
  }
}

function averageSize(stream: TalkbackStream): number {
  return stream.bytes / stream.packets;
}

function clockRateFromTimestampDelta(delta: number | undefined): number {
  switch (delta) {
    case 160:
      return 8000;
    case 320:
      return 16000;
    case 480:
      return 24000;
    default:
      return 48000;
  }
}
