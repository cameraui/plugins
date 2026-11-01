import { errorMessage } from './utils.js';

import type { LoggerService } from '@camera.ui/sdk';
import type { EufyMega } from '@mega-yfue/eufy-sdk';

const POLL_INTERVAL_MS = 30_000;

interface Recording {
  id: string;
  stationSn: string;
  cameraSn: string;
  startTime: string;
  thumbPath?: string;
}

interface CachedImage {
  path: string;
  jpeg: Promise<Buffer>;
}

export class StationHistory {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly latest = new Map<string, Recording>();
  private readonly images = new Map<string, CachedImage>();
  private readonly failing = new Set<string>();

  constructor(
    private readonly client: EufyMega,
    private readonly logger: LoggerService,
    private readonly onRecording: (cameraSn: string) => void,
  ) {}

  public watch(stationSn: string): void {
    if (this.timers.has(stationSn)) return;
    this.timers.set(
      stationSn,
      setInterval(() => {
        this.poll(stationSn);
      }, POLL_INTERVAL_MS),
    );
    this.poll(stationSn);
  }

  public latestImage(cameraSn: string): Promise<Buffer> | undefined {
    const recording = this.latest.get(cameraSn);
    if (!recording?.thumbPath) return undefined;

    const cached = this.images.get(cameraSn);
    if (cached?.path === recording.thumbPath) return cached.jpeg;

    const jpeg = this.client.readStationImage(recording.stationSn, recording.thumbPath);
    const image = { path: recording.thumbPath, jpeg };
    this.images.set(cameraSn, image);
    jpeg.catch(() => {
      if (this.images.get(cameraSn) === image) this.images.delete(cameraSn);
    });
    return jpeg;
  }

  public stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.seen.clear();
    this.latest.clear();
    this.images.clear();
    this.failing.clear();
  }

  private async poll(stationSn: string): Promise<void> {
    let rows: unknown[];
    try {
      rows = await this.client.readStationTable(stationSn, 'history_record_info');
    } catch (error) {
      if (!this.failing.has(stationSn)) this.logger.warn(`Could not read the event list of HomeBase ${stationSn}: ${errorMessage(error)}`);
      this.failing.add(stationSn);
      return;
    }
    if (!this.timers.has(stationSn)) return;
    this.failing.delete(stationSn);

    const recordings = rows.map((row) => toRecording(stationSn, row)).filter((recording) => recording !== undefined);
    const previous = this.seen.get(stationSn);
    this.seen.set(stationSn, new Set(recordings.map((recording) => recording.id)));

    for (const recording of recordings) {
      const latest = this.latest.get(recording.cameraSn);
      // the newest row is read again on every poll, its picture may only arrive later
      if (!latest || recording.startTime >= latest.startTime) this.latest.set(recording.cameraSn, recording);
      if (previous && !previous.has(recording.id)) this.onRecording(recording.cameraSn);
    }
  }
}

function toRecording(stationSn: string, row: unknown): Recording | undefined {
  const { device_sn, record_id, start_time, thumb_path } = (row ?? {}) as Record<string, unknown>;
  if (typeof device_sn !== 'string' || !isScalar(record_id) || !isScalar(start_time)) return undefined;
  return {
    id: `${device_sn}:${String(record_id)}`,
    stationSn,
    cameraSn: device_sn,
    startTime: String(start_time),
    thumbPath: typeof thumb_path === 'string' && thumb_path ? thumb_path : undefined,
  };
}

function isScalar(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}
