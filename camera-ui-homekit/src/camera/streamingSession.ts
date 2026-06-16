import { Disposable, firstValueFrom, Subject } from '@camera.ui/sdk';
import { isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isRtcp, RtcpPacketConverter, RtcpRrPacket, RtcpSenderInfo, RtcpSrPacket, SrtcpSession, SrtpSession } from 'werift';
import { AudioStreamingCodecType, SRTPCryptoSuites } from '../hap.js';

import { RtpSplitter } from '../utils/rtp-splitter.js';
import { generateSrtpOptions, generateSsrc, getSessionConfig } from '../utils/srtp.js';
import { getDurationSeconds, PromiseTimeout } from '../utils/utils.js';

import type { CameraDevice, LoggerService, RtpSession } from '@camera.ui/sdk';
import type { RtpPacket } from 'werift';
import type { PrepareStreamRequest, StartStreamRequest } from '../hap.js';
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
  private homekitSrtcpSession: SrtcpSession;

  private cameraAccessory: CameraAccessory;
  private cameraDevice: CameraDevice;
  private streamingSession: RtpSession;
  private prepareStreamRequest: PrepareStreamRequest;
  private cameraLogger: LoggerService;

  private lastPacketLoss = 0;
  private packetReceivedSubject = new Subject<void>();

  constructor(cameraAccessory: CameraAccessory, cameraDevice: CameraDevice, prepareStreamRequest: PrepareStreamRequest, start: number) {
    this.cameraAccessory = cameraAccessory;
    this.cameraDevice = cameraDevice;
    this.prepareStreamRequest = prepareStreamRequest;
    this.start = start;
    this.cameraLogger = cameraDevice.logger;

    this.videoSrtcpSession = new SrtcpSession(getSessionConfig(this.videoSrtp));
    this.homekitSrtcpSession = new SrtcpSession(getSessionConfig(prepareStreamRequest.video));

    this.streamingSession = this.cameraDevice.streamSource.createRtpSession({
      audio: true,
      video: true,
      backchannel: true,
    });
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
        this.analyzeRtcpPacket(message);
      }

      return null;
    });

    this.audioSplitter.addMessageHandler(() => {
      if (!firstRtcp) {
        firstRtcp = true;
        logFirstRtcp();
      }

      this.packetReceivedSubject.next();
      return null;
    });

    // Inactivity detection: if no packets for 5s (after initial 15s grace period), stop stream
    {
      let debounceTimer: NodeJS.Timeout | undefined;
      const resetDebounce = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          this.cameraLogger.log(`Live stream appears to be inactive. (${getDurationSeconds(this.start)}s)`);
          await this.streamingSession.stop();
        }, 5000);
      };
      const initialTimer = setTimeout(resetDebounce, 15000);
      const packetSub = this.packetReceivedSubject.subscribe(resetDebounce);
      this.streamingSession.addSubscriptions(
        new Disposable(() => {
          clearTimeout(initialTimer);
          clearTimeout(debounceTimer);
          packetSub.dispose();
        }),
      );
    }

    // Send RTCP sender reports every 500ms
    {
      const rtcpInterval = setInterval(async () => {
        const senderInfo = new RtcpSenderInfo({
          ntpTimestamp: BigInt(0),
          packetCount: 0,
          octetCount: 0,
          rtpTimestamp: 0,
        });

        const senderReport = new RtcpSrPacket({
          ssrc: this.videoSsrc,
          senderInfo: senderInfo,
        });

        const encryptedPacket = this.videoSrtcpSession.encrypt(senderReport.serialize());

        try {
          await this.videoSplitter.send(encryptedPacket, {
            port: this.prepareStreamRequest.video.port,
            address: this.prepareStreamRequest.targetAddress,
          });
        } catch {
          //
        }
      }, 500);
      this.streamingSession.addSubscriptions(new Disposable(() => clearInterval(rtcpInterval)));
    }
  }

  public async activate(startStreamRequest: StartStreamRequest): Promise<void> {
    this.cameraLogger.debug('Starting stream:', startStreamRequest);

    const waitForRtcp = false;

    // if (this.isLowBandwidth(startStreamRequest)) {
    //   this.cameraLogger.attention('Low bandwidth detected, waiting for initial RTCP');
    //   waitForRtcp = true;
    // }

    if (waitForRtcp) {
      await PromiseTimeout(firstValueFrom(this.packetReceivedSubject), 3000, undefined, 'Failed to receive initial RTCP packet');
      await this.run(startStreamRequest);
    } else {
      await this.run(startStreamRequest);
    }
  }

  public async stop(): Promise<void> {
    this.cameraLogger.debug('Stopping stream');
    await this.streamingSession.stop();
    this.audioSplitter.close();
    this.videoSplitter.close();
    this.cameraLogger.debug('Stream stopped');
  }

  private async run(startStreamRequest: StartStreamRequest): Promise<void> {
    this.listenForAudioPackets();
    this.listenForVideoPackets();

    await this.streamingSession.startStream({
      hardware: 'auto',
      video: {
        codec: 'h264',
        mtu: startStreamRequest.video.mtu,
        ssrc: this.videoSsrc,
        payloadType: startStreamRequest.video.pt,
        fps: startStreamRequest.video.fps,
        width: startStreamRequest.video.width,
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

    await this.streamingSession.startBackchannel({
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

    if (this.streamingSession.hasBackchannel) {
      this.listenForReturnAudioPackets();
    }
  }

  private listenForVideoPackets(): void {
    let sentVideo = false;

    const {
      targetAddress: address,
      video: { port },
    } = this.prepareStreamRequest;

    const videoSrtpSession = new SrtpSession(getSessionConfig(this.videoSrtp));

    this.streamingSession.addSubscriptions(
      this.streamingSession.onVideoRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentVideo) {
          sentVideo = true;
          this.cameraLogger.debug(`Received video data (${getDurationSeconds(this.start)}s)`);
        }

        try {
          const encryptedPacket = videoSrtpSession.encrypt(rtp.payload, rtp.header);
          this.videoSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // Ignore deserialization errors
        }
      }),
    );
  }

  private listenForAudioPackets(): void {
    let sentAudio = false;

    const {
      targetAddress: address,
      audio: { port },
    } = this.prepareStreamRequest;

    const audioSrtpSession = new SrtpSession(getSessionConfig(this.audioSrtp));

    this.streamingSession.addSubscriptions(
      this.streamingSession.onAudioRtp.subscribe(async (rtp: RtpPacket) => {
        if (!sentAudio) {
          sentAudio = true;
          this.cameraLogger.debug(`Received audio data (${getDurationSeconds(this.start)}s)`);
        }

        try {
          const encryptedPacket = audioSrtpSession.encrypt(rtp.payload, rtp.header);
          this.audioSplitter.send(encryptedPacket, { port, address }).catch(() => {});
        } catch {
          // Ignore deserialization errors
        }
      }),
    );
  }

  private listenForReturnAudioPackets(): void {
    this.audioSplitter.addMessageHandler(({ message, isRtpMessage }) => {
      if (isRtpMessage) {
        try {
          // Forward encrypted SRTP packet directly - node-av will decrypt
          this.streamingSession.sendAudioPacket(message).catch(() => {});
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

  private analyzeRtcpPacket(message: Buffer): void {
    if (isRtcp(message)) {
      try {
        const decryptedRtcp = this.homekitSrtcpSession.decrypt(message);
        const decryptedRtcpPackets = RtcpPacketConverter.deSerialize(decryptedRtcp);
        const rrPacket = decryptedRtcpPackets[0];

        if (rrPacket instanceof RtcpRrPacket) {
          for (const report of rrPacket.reports) {
            if (report.packetsLost > this.lastPacketLoss) {
              this.lastPacketLoss = report.packetsLost;
              this.cameraLogger.debug(`Increased packet loss detected: Total Lost=${report.packetsLost}, Highest Seq=${report.highestSequence}, Jitter=${report.jitter}`);
            }
          }
        }
      } catch {
        // Ignore deserialization errors
      }
    }
  }
}
