import { StreamRequestTypes } from '../hap.js';

import { captureSnapshot } from '../utils/placeholder.js';
import { getDurationSeconds } from '../utils/utils.js';
import { StreamingSession } from './streamingSession.js';

import type { CameraDevice, LoggerService } from '@camera.ui/sdk';
import type {
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamRequestCallback,
  StreamingRequest,
} from '../hap.js';
import type { CameraAccessory } from './accessory.js';

export class StreamingDelegate implements CameraStreamingDelegate {
  private cameraAccessory: CameraAccessory;
  private cameraDevice: CameraDevice;
  private cameraLogger: LoggerService;

  private sessions: Record<string, StreamingSession> = {};
  private disposed = false;

  constructor(cameraAccessory: CameraAccessory, cameraDevice: CameraDevice) {
    this.cameraAccessory = cameraAccessory;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;
  }

  public handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    captureSnapshot(this.cameraDevice, this.cameraAccessory.batteryPowered)
      .then((snapshot) => callback(undefined, snapshot))
      .catch((error: any) => callback(error));
  }

  public async stopAllSessions(): Promise<void> {
    const sessions = Object.values(this.sessions);
    this.sessions = {};
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const start = Date.now();
    const session = new StreamingSession(this.cameraAccessory, this.cameraDevice, request, start);

    this.cameraLogger.debug('[RTP] Preparing stream...');

    session
      .prepare()
      .then(async () => {
        if (this.disposed) {
          await session.stop();
          callback(new Error('Streaming delegate stopped while preparing stream'));
          return;
        }

        this.cameraLogger.debug(`[RTP] Stream prepared (${getDurationSeconds(start)}s)`);

        this.sessions[request.sessionID] = session;

        callback(undefined, {
          addressOverride: session.sourceAddress,
          audio: {
            port: session.audioSplitter.port!,
            ssrc: session.audioSsrc,
            srtp_key: session.audioSrtp.srtp_key,
            srtp_salt: session.audioSrtp.srtp_salt,
          },
          video: {
            port: session.videoSplitter.port!,
            ssrc: session.videoSsrc,
            srtp_key: session.videoSrtp.srtp_key,
            srtp_salt: session.videoSrtp.srtp_salt,
          },
        });
      })
      .catch(async (error: any) => {
        this.cameraLogger.error(`[RTP] Failed to prepare stream (${getDurationSeconds(start)}s)`, error);
        await session.stop();
        callback(error);
      });
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const sessionID = request.sessionID;
    const session = this.sessions[sessionID];
    const requestType = request.type;

    if (!session) {
      callback(new Error('Cannot find session for stream ' + sessionID));
      return;
    }

    if (requestType === StreamRequestTypes.START) {
      this.cameraLogger.debug(`[RTP] Activating stream (${getDurationSeconds(session.start)}s)`);

      session
        .activate(request)
        .then(async () => {
          if (this.disposed || this.sessions[sessionID] !== session) {
            await session.stop();
            callback(new Error('Streaming session stopped while activating'));
            return;
          }

          this.cameraLogger.log(`[RTP] Streaming activated (${getDurationSeconds(session.start)}s)`);
          callback();
        })
        .catch(async (error: any) => {
          this.cameraLogger.error('[RTP] Failed to activate stream', error);
          if (this.sessions[sessionID] === session) {
            delete this.sessions[sessionID];
          }
          await session.stop();
          callback(error);
        });
    } else if (requestType === StreamRequestTypes.STOP) {
      this.cameraLogger.log('[RTP] Stopping stream...');
      delete this.sessions[sessionID];
      session.stop().then(() => callback(), callback);
    } else {
      // ReconfigureStreamRequest
      callback();
    }
  }

  public async cleanup(): Promise<void> {
    this.disposed = true;
    const sessions = Object.values(this.sessions);
    this.sessions = {};
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }
}
