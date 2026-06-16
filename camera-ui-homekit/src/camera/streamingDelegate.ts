import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StreamRequestTypes } from '../hap.js';

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

const noSnapshotPath = resolve(__dirname, './media/noSnapshot.png');

export class StreamingDelegate implements CameraStreamingDelegate {
  private cameraAccessory: CameraAccessory;
  private cameraDevice: CameraDevice;
  private cameraLogger: LoggerService;

  private sessions: Record<string, StreamingSession> = {};

  constructor(cameraAccessory: CameraAccessory, cameraDevice: CameraDevice) {
    this.cameraAccessory = cameraAccessory;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;
  }

  public handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const source = this.cameraDevice.snapshotSource ?? this.cameraDevice.streamSource;

    source
      .snapshot()
      .then((snapshot) => {
        let snapshotBuffer = snapshot ? Buffer.from(snapshot) : undefined;
        if (!snapshotBuffer || snapshotBuffer.length === 0) {
          snapshotBuffer = readFileSync(noSnapshotPath);
        }
        callback(undefined, snapshotBuffer);
      })
      .catch((error: any) => {
        callback(error);
      });
  }

  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const start = Date.now();
    const session = new StreamingSession(this.cameraAccessory, this.cameraDevice, request, start);

    this.cameraLogger.debug('Preparing stream...');

    session
      .prepare()
      .then(() => {
        this.cameraLogger.debug(`Stream prepared (${getDurationSeconds(start)}s)`);

        this.sessions[request.sessionID] = session;

        callback(undefined, {
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
      .catch((error: any) => {
        this.cameraLogger.error(`Failed to prepare stream (${getDurationSeconds(start)}s)`, error);
        session.stop();
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
      this.cameraLogger.debug(`Activating stream (${getDurationSeconds(session.start)}s)`);

      session
        .activate(request)
        .then(() => {
          this.cameraLogger.log(`Streaming activated (${getDurationSeconds(session.start)}s)`);
          callback();
        })
        .catch((error: any) => {
          this.cameraLogger.error('Failed to activate stream', error);
          session.stop();
          callback(error);
        });
    } else if (requestType === StreamRequestTypes.STOP) {
      this.cameraLogger.log('Stopping stream...');
      session.stop();
      delete this.sessions[sessionID];
      callback();
    } else {
      // ReconfigureStreamRequest
      callback();
    }
  }

  public cleanup(): void {
    for (const sessionID in this.sessions) {
      this.sessions[sessionID].stop();
    }

    this.sessions = {};
  }
}
