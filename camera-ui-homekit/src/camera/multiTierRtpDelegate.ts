import {
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  H264Level,
  H264Profile,
  StreamRequestTypes,
  StreamTierAudioSampleRate,
  VideoCodecPacketizationMode,
  VideoCodecType,
} from '../hap.js';

import { getDurationSeconds } from '../utils/utils.js';
import { StreamingSession } from './streamingSession.js';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type {
  AudioStreamTier,
  MultiTierPrepareStreamRequest,
  MultiTierPrepareStreamResponse,
  MultiTierRTPStreamingDelegate,
  MultiTierStreamStartRequest,
  PrepareStreamRequest,
  SecureVideoVideoTier,
  StartStreamRequest,
} from '../hap.js';
import type { CameraAccessory } from './accessory.js';
import type { SecureVideoCodec } from './sframeRtp.js';

interface MultiTierConfig {
  codec: SecureVideoCodec;
  videoTiers: SecureVideoVideoTier[];
  audioTier: AudioStreamTier;
  videoPayloadType: number;
  audioPayloadType: number;
}

export class MultiTierRtpDelegate implements MultiTierRTPStreamingDelegate {
  private sessions = new Map<string, StreamingSession>();
  private cameraLogger: LoggerService;

  constructor(
    private cameraAccessory: CameraAccessory,
    private cameraDevice: CameraDevice,
    private config: MultiTierConfig,
  ) {
    this.cameraLogger = cameraDevice.logger;
  }

  public async prepareStream(request: MultiTierPrepareStreamRequest): Promise<MultiTierPrepareStreamResponse> {
    this.cameraLogger.debug('[Multi-RTP] Preparing stream...');

    const prepareStreamRequest: PrepareStreamRequest = {
      sessionID: request.sessionIdentifier,
      sourceAddress: request.sourceAddress,
      targetAddress: request.targetAddress,
      addressVersion: request.addressVersion,
      video: {
        port: request.controllerVideoPort,
        srtpCryptoSuite: request.video.cryptoSuite,
        srtp_key: request.video.masterKey,
        srtp_salt: request.video.masterSalt,
      },
      audio: {
        port: request.controllerAudioPort,
        srtpCryptoSuite: request.audio.cryptoSuite,
        srtp_key: request.audio.masterKey,
        srtp_salt: request.audio.masterSalt,
      },
    };

    // secure video streams Opus on the fixed 48 kHz clock of RFC 7587, not the legacy negotiated rate
    const session = new StreamingSession(this.cameraAccessory, this.cameraDevice, prepareStreamRequest, Date.now(), this.config.codec, 'fixed');
    await session.prepare();
    this.sessions.set(request.sessionIdentifier, session);

    this.cameraLogger.debug(`[Multi-RTP] Stream prepared (${getDurationSeconds(session.start)}s)`);

    return {
      addressOverride: session.sourceAddress,
      videoPort: session.videoSplitter.port!,
      audioPort: session.audioSplitter.port!,
      videoSSRC: session.videoSsrc,
      audioSSRC: session.audioSsrc,
      video: { cryptoSuite: request.video.cryptoSuite, masterKey: session.videoSrtp.srtp_key, masterSalt: session.videoSrtp.srtp_salt },
      audio: { cryptoSuite: request.audio.cryptoSuite, masterKey: session.audioSrtp.srtp_key, masterSalt: session.audioSrtp.srtp_salt },
    };
  }

  public async startStream(request: MultiTierStreamStartRequest): Promise<void> {
    const session = this.sessions.get(request.sessionIdentifier);
    if (!session) {
      throw new Error(`No prepared multi-tier session ${request.sessionIdentifier}`);
    }

    const tier = this.config.videoTiers.find((candidate) => candidate.identifier === request.videoTier) ?? this.config.videoTiers[0];
    const bitrate = Math.round(this.config.audioTier.targetAverageBitrate / 1000);

    // iOS filters the incoming stream by the ssrc from the Setup Endpoints response, so keep the
    // ssrc prepared there instead of the one the controller sends in the RTP Streaming Control START

    const startStreamRequest: StartStreamRequest = {
      sessionID: request.sessionIdentifier,
      type: StreamRequestTypes.START,
      video: {
        codec: VideoCodecType.H264,
        profile: H264Profile.MAIN,
        level: H264Level.LEVEL4_0,
        packetizationMode: VideoCodecPacketizationMode.NON_INTERLEAVED,
        width: tier.width,
        height: tier.height,
        fps: tier.frameRate,
        pt: this.config.videoPayloadType,
        ssrc: session.videoSsrc,
        max_bit_rate: tier.peakBitrate,
        rtcp_interval: 0.5,
        mtu: 1378,
      },
      audio: {
        codec: AudioStreamingCodecType.OPUS,
        channel: this.config.audioTier.channels,
        bit_rate: bitrate,
        sample_rate: captureSampleRate(this.config.audioTier.sampleRate),
        packet_time: this.config.audioTier.packetTime,
        pt: this.config.audioPayloadType,
        ssrc: session.audioSsrc,
        max_bit_rate: bitrate,
        rtcp_interval: 0.5,
        comfort_pt: 13,
        comfortNoiseEnabled: false,
      },
    };

    this.cameraLogger.debug(`[Multi-RTP] Activating stream (${getDurationSeconds(session.start)}s)`);
    await session.activate(startStreamRequest);
    this.cameraLogger.log(`[Multi-RTP] Streaming activated (${getDurationSeconds(session.start)}s)`);
  }

  public async stopStream(sessionIdentifier: string): Promise<void> {
    const session = this.sessions.get(sessionIdentifier);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionIdentifier);
    this.cameraLogger.log('[Multi-RTP] Stopping stream...');
    await session.stop();
  }

  public async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }
}

// the tier reports the Opus transmission rate, which is always 48 kHz, the capture runs at 16 or 24 kHz
function captureSampleRate(sampleRate: StreamTierAudioSampleRate): AudioStreamingSamplerate {
  switch (sampleRate) {
    case StreamTierAudioSampleRate.KHZ_16:
      return AudioStreamingSamplerate.KHZ_16;
    default:
      return AudioStreamingSamplerate.KHZ_24;
  }
}
