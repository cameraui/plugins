import { Disposable, Subject } from '@camera.ui/sdk';
import { spawn } from 'node:child_process';
import { isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  isRtcp,
  PictureLossIndication,
  RtcpPacketConverter,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSenderInfo,
  RtcpSrPacket,
  SrtcpSession,
  SrtpSession,
} from 'werift';
import { AudioStreamingCodecType, SRTPCryptoSuites } from '../hap.js';

import { placeholderImageFor } from '../utils/placeholder.js';
import { RtpSplitter } from '../utils/rtp-splitter.js';
import { createReceiverStats, ntpMiddle32, ntpTimestamp, recordRtpPacket, summarizeReceiverStats } from '../utils/rtp-stats.js';
import { generateSrtpOptions, generateSsrc, getSessionConfig } from '../utils/srtp.js';
import { getDurationSeconds } from '../utils/utils.js';

import type { CameraDevice, CameraDeviceSource, LoggerService, RtpSession } from '@camera.ui/sdk';
import type { ChildProcess } from 'node:child_process';
import type { RtpPacket } from 'werift';
import type { PrepareStreamRequest, StartStreamRequest } from '../hap.js';
import type { RtpSenderState } from '../utils/rtp-stats.js';
import type { CameraAccessory } from './accessory.js';

export class StreamingSession {
  public start: number;

  public audioSsrc = generateSsrc();
  public videoSsrc = generateSsrc();
  public audioSrtp = generateSrtpOptions();
  public videoSrtp = generateSrtpOptions();

  public audioSplitter = new RtpSplitter();
  public videoSplitter = new RtpSplitter();

  private videoSrtcpSession: SrtcpSession;
  private audioSrtcpSession: SrtcpSession;
  private homekitSrtcpSession: SrtcpSession;
  private homekitAudioSrtcpSession: SrtcpSession;

  private cameraAccessory: CameraAccessory;
  private cameraDevice: CameraDevice;
  private streamingSession?: RtpSession;
  private placeholderProcess?: ChildProcess;
  private placeholderDisposables: Disposable[] = [];
  private prepareStreamRequest: PrepareStreamRequest;
  private cameraLogger: LoggerService;
  private stopPromise?: Promise<void>;

  private lastPacketLoss = 0;
  private packetReceivedSubject = new Subject<void>();

  private videoSenderState?: RtpSenderState;
  private audioSenderState?: RtpSenderState;
  private videoReceiverStats = createReceiverStats();
  private audioReceiverStats = createReceiverStats();
  private audioClockRate = 48000;

  constructor(cameraAccessory: CameraAccessory, cameraDevice: CameraDevice, prepareStreamRequest: PrepareStreamRequest, start: number) {
    this.cameraAccessory = cameraAccessory;
    this.cameraDevice = cameraDevice;
    this.prepareStreamRequest = prepareStreamRequest;
    this.start = start;
    this.cameraLogger = cameraDevice.logger;

    this.videoSrtcpSession = new SrtcpSession(getSessionConfig(this.videoSrtp));
    this.audioSrtcpSession = new SrtcpSession(getSessionConfig(this.audioSrtp));
    this.homekitSrtcpSession = new SrtcpSession(getSessionConfig(prepareStreamRequest.video));
    this.homekitAudioSrtcpSession = new SrtcpSession(getSessionConfig(prepareStreamRequest.audio));
  }

  public async prepare(): Promise<void> {
    const { socketType, sourceAddress } = await this.setupAddress();

    await Promise.all([this.audioSplitter.prepare(socketType, sourceAddress), this.videoSplitter.prepare(socketType, sourceAddress)]);

    if (!this.videoSplitter.port || !this.audioSplitter.port) {
      throw new Error('Failed to prepare stream splitters');
    }

    let firstRtcp = false;

    const logFirstRtcp = () => {
      this.cameraLogger.debug('Received RTCP packet from HomeKit');
    };

    this.videoSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (!firstRtcp) {
        firstRtcp = true;
        logFirstRtcp();
      }

      this.packetReceivedSubject.next();

      if (!isRtpMessage) {
        this.analyzeRtcpPacket(message, 'video');
      }

      return null;
    });

    this.audioSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (!firstRtcp) {
        firstRtcp = true;
        logFirstRtcp();
      }

      this.packetReceivedSubject.next();

      if (!isRtpMessage) {
        this.analyzeRtcpPacket(message, 'audio');
      }

      return null;
    });
  }

  private setupInactivityDetection(session: RtpSession): void {
    // Stop the stream if no packets arrive for 5s, after an initial 15s grace period.
    let debounceTimer: NodeJS.Timeout | undefined;
    const resetDebounce = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        this.cameraLogger.log(`Live stream appears to be inactive. (${getDurationSeconds(this.start)}s)`);
        await session.stop();
      }, 5000);
    };
    const initialTimer = setTimeout(resetDebounce, 15000);
    const packetSub = this.packetReceivedSubject.subscribe(resetDebounce);
    session.addSubscriptions(
      new Disposable(() => {
        clearTimeout(initialTimer);
        clearTimeout(debounceTimer);
        packetSub.dispose();
      }),
    );
  }

  private setupRtcpSenderReports(session: RtpSession, startStreamRequest: StartStreamRequest): void {
    const sendSenderReport = async (state: RtpSenderState | undefined, ssrc: number, srtcp: SrtcpSession, splitter: RtpSplitter, port: number): Promise<void> => {
      if (!state) return;

      const senderReport = new RtcpSrPacket({
        ssrc,
        senderInfo: new RtcpSenderInfo({
          ntpTimestamp: ntpTimestamp(state.wallclock),
          rtpTimestamp: state.timestamp,
          packetCount: state.packets >>> 0,
          octetCount: state.octets >>> 0,
        }),
      });

      try {
        await splitter.send(srtcp.encrypt(senderReport.serialize()), {
          port,
          address: this.prepareStreamRequest.targetAddress,
        });
      } catch {
        //
      }
    };

    const videoInterval = setInterval(
      () => sendSenderReport(this.videoSenderState, this.videoSsrc, this.videoSrtcpSession, this.videoSplitter, this.prepareStreamRequest.video.port),
      Math.max(500, (startStreamRequest.video.rtcp_interval || 0.5) * 1000),
    );
    const audioInterval = setInterval(
      () => sendSenderReport(this.audioSenderState, this.audioSsrc, this.audioSrtcpSession, this.audioSplitter, this.prepareStreamRequest.audio.port),
      Math.max(500, (startStreamRequest.audio.rtcp_interval || 5) * 1000),
    );
    session.addSubscriptions(
      new Disposable(() => {
        clearInterval(videoInterval);
        clearInterval(audioInterval);
      }),
    );
  }

  public async activate(startStreamRequest: StartStreamRequest): Promise<void> {
    this.cameraLogger.debug('Starting stream:', startStreamRequest);

    const placeholder = placeholderImageFor(this.cameraDevice);
    if (placeholder) {
      this.cameraLogger.log(`Camera unavailable, streaming placeholder (${this.cameraDevice.disabled ? 'disabled' : 'offline'})`);
      await this.runPlaceholder(placeholder, startStreamRequest);
      return;
    }

    const allowAuto = this.cameraAccessory.cameraStorage.values.adaptiveStreamSource;
    const remote = this.isLowBandwidth(startStreamRequest);
    if (remote && allowAuto) {
      this.cameraLogger.attention('Low bandwidth detected, using adaptive stream source if available');
    }

    const source = this.selectStreamSource(startStreamRequest, remote);
    const session = source.createRtpSession({
      audio: true,
      video: true,
      backchannel: true,
    });
    this.streamingSession = session;

    session.onError.subscribe((error) => {
      this.cameraLogger.warn(`Live stream source error: ${error.message}`);
    });

    this.setupInactivityDetection(session);
    this.setupRtcpSenderReports(session, startStreamRequest);

    // if (remote) {
    //   await PromiseTimeout(firstValueFrom(this.packetReceivedSubject), 3000, undefined, 'Failed to receive initial RTCP packet');
    // }

    await this.run(session, startStreamRequest);
  }

  public stop(): Promise<void> {
    this.stopPromise ??= Promise.resolve().then(() => this.shutdown());
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.cameraLogger.debug('Stopping stream');
    const streamingSession = this.streamingSession;
    this.streamingSession = undefined;

    try {
      await streamingSession?.stop();
    } finally {
      this.stopPlaceholderProcess();
      this.audioSplitter.close();
      this.videoSplitter.close();
      this.logStreamSummary();
      this.cameraLogger.debug('Stream stopped');
    }
  }

  private async runPlaceholder(imagePath: string, startStreamRequest: StartStreamRequest): Promise<void> {
    const ffmpegPath = await this.cameraAccessory.api.coreManager.getFFmpegPath();
    const { targetAddress, video } = this.prepareStreamRequest;
    const address = isIPv6(targetAddress) ? `[${targetAddress}]` : targetAddress;
    const srtpParams = Buffer.concat([this.videoSrtp.srtp_key, this.videoSrtp.srtp_salt]).toString('base64');

    const request = startStreamRequest.video;
    const fps = request.fps || 15;
    const bitrate = request.max_bit_rate || 300;

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      String(fps),
      '-i',
      imagePath,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2`,
      '-b:v',
      `${bitrate}k`,
      '-maxrate',
      `${bitrate}k`,
      '-bufsize',
      `${bitrate * 2}k`,
      '-g',
      String(fps * 2),
      '-payload_type',
      String(request.pt),
      '-ssrc',
      String(this.videoSsrc),
      '-f',
      'rtp',
      '-srtp_out_suite',
      'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params',
      srtpParams,
      `srtp://${address}:${video.port}?rtcpport=${video.port}&pkt_size=${request.mtu || 1316}`,
    ];

    const process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.placeholderProcess = process;

    process.stderr?.on('data', (chunk: Buffer) => this.cameraLogger.debug(`Placeholder ffmpeg: ${chunk.toString().trim()}`));
    process.on('exit', (code) => {
      if (this.placeholderProcess === process && code !== 0 && code !== null) {
        this.cameraLogger.warn(`Placeholder stream exited with code ${code}`);
      }
    });

    this.setupPlaceholderInactivityDetection();
  }

  private setupPlaceholderInactivityDetection(): void {
    let debounceTimer: NodeJS.Timeout | undefined;
    const resetDebounce = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.cameraLogger.log(`Live stream appears to be inactive. (${getDurationSeconds(this.start)}s)`);
        this.stopPlaceholderProcess();
      }, 5000);
    };
    const initialTimer = setTimeout(resetDebounce, 15000);
    const packetSub = this.packetReceivedSubject.subscribe(resetDebounce);
    this.placeholderDisposables.push(
      new Disposable(() => {
        clearTimeout(initialTimer);
        clearTimeout(debounceTimer);
        packetSub.dispose();
      }),
    );
  }

  private stopPlaceholderProcess(): void {
    for (const disposable of this.placeholderDisposables) {
      disposable.dispose();
    }
    this.placeholderDisposables = [];

    const process = this.placeholderProcess;
    this.placeholderProcess = undefined;
    if (process && !process.killed) {
      process.kill('SIGKILL');
    }
  }

  private selectStreamSource(startStreamRequest: StartStreamRequest, remote: boolean): CameraDeviceSource {
    const { streamSource, highResolutionSource: high, midResolutionSource: mid, lowResolutionSource: low } = this.cameraDevice;

    if (!remote || !this.cameraAccessory.cameraStorage.values.adaptiveStreamSource) {
      return streamSource;
    }

    const width = startStreamRequest.video.width;
    let preference: (CameraDeviceSource | undefined)[];
    if (width >= 1920) {
      preference = [high, mid, low];
    } else if (width >= 1280) {
      preference = [mid, low, high];
    } else {
      preference = [low, mid, high];
    }

    const selected = preference.find((candidate): candidate is CameraDeviceSource => candidate !== undefined) ?? streamSource;

    if (selected !== streamSource) {
      this.cameraLogger.debug(`Adaptive source: HomeKit requested ${width}px width, using "${selected.name}" (${selected.role})`);
    }

    return selected;
  }

  private async run(session: RtpSession, startStreamRequest: StartStreamRequest): Promise<void> {
    this.audioClockRate = startStreamRequest.audio.sample_rate * 1000;

    this.listenForAudioPackets(session, startStreamRequest);
    this.listenForVideoPackets(session);

    await session.startStream({
      hardware: this.cameraAccessory.cameraStorage.values.useHardwareAcceleration ? 'auto' : undefined,
      video: {
        codec: 'h264',
        mtu: startStreamRequest.video.mtu,
        ssrc: this.videoSsrc,
        payloadType: startStreamRequest.video.pt,
        fps: startStreamRequest.video.fps,
        width: startStreamRequest.video.width,
        bitrate: startStreamRequest.video.max_bit_rate * 1000,
      },
      audio: {
        codec: startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS ? 'opus' : 'aac',
        mtu: 1200,
        sampleRate: startStreamRequest.audio.sample_rate * 1000,
        channels: startStreamRequest.audio.channel,
        ssrc: this.audioSsrc,
        payloadType: startStreamRequest.audio.pt,
        frameDuration: startStreamRequest.audio.packet_time,
      },
    });

    await session.startBackchannel({
      decoderCodec: startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS ? 'libopus' : 'libfdk_aac',
      payloadType: startStreamRequest.audio.pt,
      clockRate: startStreamRequest.audio.sample_rate * 1000,
      channels: startStreamRequest.audio.channel,
      fmtp:
        startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS
          ? 'minptime=10;useinbandfec=1'
          : 'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00',
      srtp: {
        key: this.prepareStreamRequest.audio.srtp_key,
        salt: this.prepareStreamRequest.audio.srtp_salt,
        suite: this.prepareStreamRequest.audio.srtpCryptoSuite === SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80 ? 'AES_CM_128_HMAC_SHA1_80' : 'AES_CM_256_HMAC_SHA1_80',
      },
    });

    if (session.hasBackchannel) {
      this.listenForReturnAudioPackets(session);
    }
  }

  private listenForVideoPackets(session: RtpSession): void {
    let sentVideo = false;

    const {
      targetAddress: address,
      video: { port },
    } = this.prepareStreamRequest;

    const videoSrtpSession = new SrtpSession(getSessionConfig(this.videoSrtp));

    session.addSubscriptions(
      session.onVideoRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentVideo) {
          sentVideo = true;
          this.cameraLogger.debug(`Received video data (${getDurationSeconds(this.start)}s)`);
        }

        try {
          const encryptedPacket = videoSrtpSession.encrypt(rtp.payload, rtp.header);
          this.videoSenderState = recordRtpPacket(this.videoSenderState, rtp, 90000);
          this.videoSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // Ignore deserialization errors
        }
      }),
    );
  }

  private listenForAudioPackets(session: RtpSession, startStreamRequest: StartStreamRequest): void {
    let sentAudio = false;

    const {
      targetAddress: address,
      audio: { port },
    } = this.prepareStreamRequest;

    const audioSrtpSession = new SrtpSession(getSessionConfig(this.audioSrtp));

    // HAP wants Opus timestamps on an RFC 3550 clock built from the
    // negotiated sample rate and packet time, as an exception to the fixed
    // 48 kHz clock of RFC 7587 that ffmpeg stamps. Left at 48 kHz the audio
    // timeline runs twice as fast as real time for HomeKit, and the receiver
    // drags the lip-synced video ever further behind the live picture.
    const rewriteTimestamps = startStreamRequest.audio.codec === AudioStreamingCodecType.OPUS;
    const increment = 160 * (startStreamRequest.audio.sample_rate / 8) * (startStreamRequest.audio.packet_time / 20);
    let baseTimestamp: number | undefined;
    let packetIndex = 0;

    session.addSubscriptions(
      session.onAudioRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentAudio) {
          sentAudio = true;
          this.cameraLogger.debug(`Received audio data (${getDurationSeconds(this.start)}s)`);
        }

        try {
          if (rewriteTimestamps) {
            baseTimestamp ??= rtp.header.timestamp;
            rtp.header.timestamp = (baseTimestamp + packetIndex * increment) >>> 0;
            packetIndex++;
          }

          const encryptedPacket = audioSrtpSession.encrypt(rtp.payload, rtp.header);
          this.audioSenderState = recordRtpPacket(this.audioSenderState, rtp, this.audioClockRate);
          this.audioSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // Ignore deserialization errors
        }
      }),
    );
  }

  private listenForReturnAudioPackets(session: RtpSession): void {
    this.audioSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (isRtpMessage) {
        try {
          // Forward encrypted SRTP packet directly - node-av will decrypt
          session.sendAudioPacket(message).catch(() => {});
        } catch {
          // Ignore deserialization errors
        }
      }

      return null;
    });
  }

  private async setupAddress(): Promise<{
    socketType: 'udp4' | 'udp6';
    sessionID: string;
    sourceAddress: string;
    targetAddress: string;
    addressVersion: 'ipv4' | 'ipv6';
  }> {
    const { sessionID, targetAddress, addressVersion } = this.prepareStreamRequest;
    let { sourceAddress } = this.prepareStreamRequest;

    const socketType = addressVersion === 'ipv6' ? 'udp6' : 'udp4';
    if (socketType === 'udp4' && sourceAddress.startsWith('::ffff:')) {
      sourceAddress = sourceAddress.replace('::ffff:', '');
    }

    const serverAddresses = await this.cameraAccessory.api.coreManager.getServerAddresses();
    const found = serverAddresses.find((address) => address.includes(sourceAddress));

    if (!found && serverAddresses.length) {
      this.cameraLogger.debug(`Source address ${sourceAddress} not found in server addresses`);

      const infos = Object.values(networkInterfaces())
        .flat()
        .map((i) => i?.address) as string[];

      const targetAddresses = serverAddresses.filter((address) => {
        if (socketType === 'udp4') {
          return !isIPv6(address);
        } else {
          return isIPv6(address);
        }
      });

      const targetAddressFound = infos.find((address) => targetAddresses.includes(address));
      if (targetAddressFound) {
        this.cameraLogger.debug(`Using target address ${targetAddressFound}`);
        sourceAddress = targetAddressFound;
      }
    } else if (found) {
      this.cameraLogger.debug(`Using source address ${sourceAddress}`);
    }

    if (isIPv6(sourceAddress)) {
      sourceAddress = sourceAddress.split('%')[0];
    }

    this.cameraLogger.debug('Session setup:', { sessionID, sourceAddress, targetAddress, addressVersion });

    return { socketType, sessionID, sourceAddress, targetAddress, addressVersion };
  }

  private isLowBandwidth(startStreamRequest: StartStreamRequest): boolean {
    return startStreamRequest.audio.packet_time >= 60;
  }

  private logStreamSummary(): void {
    if (!this.videoSenderState && !this.audioSenderState) return;

    if (this.videoReceiverStats.rrCount === 0 && this.audioReceiverStats.rrCount === 0) {
      this.cameraLogger.debug(`Live stream summary (${getDurationSeconds(this.start)}s): no RTCP received from the device, return path may be blocked`);
      return;
    }

    const video = summarizeReceiverStats('video', this.videoReceiverStats, this.videoSenderState, 90000);
    const audio = summarizeReceiverStats('audio', this.audioReceiverStats, this.audioSenderState, this.audioClockRate);
    this.cameraLogger.debug(`Live stream summary (${getDurationSeconds(this.start)}s): ${video}; ${audio}`);
  }

  private analyzeRtcpPacket(message: Buffer, kind: 'video' | 'audio'): void {
    if (!isRtcp(message)) return;

    const stats = kind === 'video' ? this.videoReceiverStats : this.audioReceiverStats;
    const clockRate = kind === 'video' ? 90000 : this.audioClockRate;

    try {
      const srtcp = kind === 'video' ? this.homekitSrtcpSession : this.homekitAudioSrtcpSession;
      const packets = RtcpPacketConverter.deSerialize(srtcp.decrypt(message));

      for (const packet of packets) {
        if (packet instanceof RtcpRrPacket) {
          for (const report of packet.reports) {
            stats.rrCount++;
            stats.packetsLost = Math.max(stats.packetsLost, report.packetsLost);
            stats.fractionLostMax = Math.max(stats.fractionLostMax, report.fractionLost);
            stats.jitterSum += report.jitter;
            stats.jitterCount++;
            stats.jitterMax = Math.max(stats.jitterMax, report.jitter);

            if (report.lsr > 0) {
              const rttMs = (((ntpMiddle32(Date.now()) - report.lsr - report.dlsr) >>> 0) / 65536) * 1000;
              if (rttMs >= 0 && rttMs < 10_000) {
                stats.rttSumMs += rttMs;
                stats.rttCount++;
                stats.rttMaxMs = Math.max(stats.rttMaxMs, rttMs);
              }
            }

            if (kind === 'video' && report.packetsLost > this.lastPacketLoss) {
              this.lastPacketLoss = report.packetsLost;
              const jitterMs = Math.round((report.jitter / clockRate) * 1000);
              this.cameraLogger.debug(`Increased packet loss detected: Total Lost=${report.packetsLost}, Highest Seq=${report.highestSequence}, Jitter=${jitterMs}ms`);
            }
          }
        } else if (packet instanceof RtcpPayloadSpecificFeedback) {
          if (packet.feedback instanceof PictureLossIndication) {
            stats.pliCount++;
            // this.cameraLogger.debug(`Device requested a keyframe (PLI) on the ${kind} stream`);
          }
        }
      }
    } catch {
      // Ignore deserialization errors
    }
  }
}
