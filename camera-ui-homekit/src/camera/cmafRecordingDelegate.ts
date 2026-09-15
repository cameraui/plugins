import type { CameraDevice, Fmp4VideoInfo, LoggerService } from '@camera.ui/sdk';
import type { BufferActivityCommandRequest, CameraRecordingPublishingPointValue, CMAFClipRequest, CMAFError, CMAFRecordingDelegate, CMAFSegment } from '../hap.js';
import type { RecordingDelegate } from './recordingDelegate.js';

export class CmafRecordingDelegate implements CMAFRecordingDelegate {
  private readonly logPrefix = '[CMAF]';
  private logger: LoggerService;

  constructor(
    cameraDevice: CameraDevice,
    private recordingDelegate: RecordingDelegate,
  ) {
    this.logger = cameraDevice.logger;
  }

  public async *streamClip(request: CMAFClipRequest): AsyncGenerator<CMAFSegment> {
    const { command } = request;
    this.logger.log(this.logPrefix, `Clip upload ${command.sessionId} started`);
    this.logger.debug(this.logPrefix, `Upload command ${command.command}, start ${command.start ?? '-'}, stop ${command.stop ?? '-'}`);

    for await (const part of this.recordingDelegate.getClipStream({ start: command.start, stop: command.stop, signal: request.signal })) {
      if (part.type === 'init') {
        yield { type: 'init', data: part.data, media: mediaDescription(part.videoInfo), startedAt: new Date(part.startedAt) };
      } else {
        yield { type: 'media', data: part.data, duration: part.duration, last: part.last };
      }
    }
  }

  public handleBufferActivity(request: BufferActivityCommandRequest): void {
    this.logger.debug(this.logPrefix, `Buffer activity ${request.activity}, start ${request.start}, duration ${request.duration}ms`);
  }

  public updateRecordingActive(active: boolean, audioActive: boolean): void {
    this.logger.debug(this.logPrefix, `Recording active: ${active}, audio: ${audioActive}`);
  }

  public updatePublishingPoint(publishingPoint: CameraRecordingPublishingPointValue | undefined): void {
    if (!publishingPoint) {
      this.logger.log(this.logPrefix, 'Publishing point cleared');
      return;
    }
    this.logger.log(this.logPrefix, `Publishing point set: ${new URL(publishingPoint.url).host}`);
  }

  public updateClientCertificate(installed: boolean): void {
    this.logger.log(this.logPrefix, installed ? 'Client certificate installed' : 'Client certificate cleared');
  }

  public handleUploadResult(cmafSessionId: bigint, error?: CMAFError, detail?: string): void {
    if (error === undefined) {
      this.logger.log(this.logPrefix, `Clip upload ${cmafSessionId} finished${detail ? ` (${detail})` : ''}`);
    } else {
      this.logger.warn(this.logPrefix, `Clip upload ${cmafSessionId} failed: cmafError=${error}${detail ? ` ${detail}` : ''}`);
    }
  }
}

function mediaDescription(info: Fmp4VideoInfo | undefined): CMAFSegment['media'] {
  if (!info?.width || !info.height) {
    return undefined;
  }
  const fps = info.fps > 0 ? info.fps : 30;
  return {
    codecs: info.codecString,
    width: info.width,
    height: info.height,
    bitrate: Math.round(info.width * info.height * fps * 0.06),
  };
}
