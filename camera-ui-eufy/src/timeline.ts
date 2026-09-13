const ORIGIN_MARGIN_MS = 1000;
const AUDIO_RESYNC_S = 0.25;
const RESAMPLED_RESYNC_S = 1;
const MAX_PENDING_STAMPS = 300;
const MIN_STEP_S = 0.001;
const WRAP = 0x1_0000_0000;

export type TimelineMode = 'frames' | 'samples' | 'resampled';

export class StationClock {
  private origin?: number;
  private base = 0;
  private lastRaw?: number;

  public get started(): boolean {
    return this.origin !== undefined;
  }

  public start(raw: number): void {
    this.origin ??= this.unwrap(raw) - ORIGIN_MARGIN_MS;
  }

  public seconds(raw: number): number | undefined {
    if (this.origin === undefined) return undefined;
    return (this.unwrap(raw) - this.origin) / 1000;
  }

  private unwrap(raw: number): number {
    if (this.lastRaw !== undefined && raw - this.lastRaw > WRAP / 2) return raw + this.base - WRAP;
    if (this.lastRaw !== undefined && this.lastRaw - raw > WRAP / 2) this.base += WRAP;
    this.lastRaw = raw;
    return raw + this.base;
  }
}

export class TrackTimeline {
  private readonly stamps: number[] = [];
  private latest?: number;
  private last?: number;

  constructor(
    private readonly clock: StationClock,
    private readonly mode: TimelineMode,
    private readonly fallbackStep: number,
  ) {}

  public push(raw: number | undefined): void {
    const at = raw === undefined ? undefined : this.clock.seconds(raw);
    if (at === undefined) return;
    this.latest = at;
    if (this.mode === 'resampled') return;
    this.stamps.push(at);
    if (this.stamps.length > MAX_PENDING_STAMPS) this.stamps.shift();
  }

  public next(duration?: number): number {
    const stamp = this.mode === 'resampled' ? undefined : this.stamps.shift();
    const last = this.last;

    let out: number;
    if (last === undefined) {
      out = stamp ?? this.latest ?? 0;
    } else if (this.mode === 'frames') {
      out = stamp ?? last + this.fallbackStep;
    } else {
      const paced = last + (duration ?? this.fallbackStep);
      const reference = stamp ?? this.latest;
      const limit = this.mode === 'samples' ? AUDIO_RESYNC_S : RESAMPLED_RESYNC_S;
      out = reference !== undefined && Math.abs(reference - paced) > limit ? reference : paced;
    }

    this.last = Math.max(out, last === undefined ? 0 : last + MIN_STEP_S);
    return this.last;
  }
}
