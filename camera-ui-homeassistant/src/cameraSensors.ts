import { AudioSensor, BatteryCapability, BatteryInfo, ChargingState, MotionSensor, ObjectSensor } from '@camera.ui/sdk';

import { importOptions } from './types.js';

import type { ObjectDetectionLabel } from '@camera.ui/sdk';

// event entities only say that something happened, hold it like a camera plugin holds a push
const PULSE_MS = 10_000;
const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 };

export interface CameraDetector<T> {
  set(key: string, value: T, on: boolean): void;
  pulse(key: string, value: T): void;
}

class ActiveSet<T> {
  private readonly entries = new Map<string, { value: T; timer?: NodeJS.Timeout }>();

  constructor(private readonly changed: () => void) {}

  get values(): Set<T> {
    return new Set([...this.entries.values()].map((entry) => entry.value));
  }

  public set(key: string, value: T, on: boolean): void {
    clearTimeout(this.entries.get(key)?.timer);
    if (on) this.entries.set(key, { value });
    else this.entries.delete(key);
    this.changed();
  }

  public pulse(key: string, value: T): void {
    clearTimeout(this.entries.get(key)?.timer);
    const timer = setTimeout(() => {
      this.entries.delete(key);
      this.changed();
    }, PULSE_MS);
    this.entries.set(key, { value, timer });
    this.changed();
  }

  public clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}

export class HaMotionSensor extends MotionSensor implements CameraDetector<true> {
  private readonly active = new ActiveSet<true>(() => this.reportDetections(this.active.values.size > 0));

  constructor(nativeId: string) {
    super('Home Assistant Motion', importOptions(nativeId));
  }

  public set(key: string, value: true, on: boolean): void {
    this.active.set(key, value, on);
  }

  public pulse(key: string, value: true): void {
    this.active.pulse(key, value);
  }

  protected override onStop(): void {
    this.active.clear();
  }
}

export class HaObjectSensor extends ObjectSensor implements CameraDetector<ObjectDetectionLabel> {
  private readonly active = new ActiveSet<ObjectDetectionLabel>(() => this.report());

  constructor(nativeId: string, name = 'Home Assistant Object') {
    super(name, importOptions(nativeId));
  }

  public set(key: string, label: ObjectDetectionLabel, on: boolean): void {
    this.active.set(key, label, on);
  }

  public pulse(key: string, label: ObjectDetectionLabel): void {
    this.active.pulse(key, label);
  }

  protected override onStop(): void {
    this.active.clear();
  }

  private report(): void {
    const labels = this.active.values;
    if (labels.size === 0) {
      this.reportDetections(false);
      return;
    }
    this.reportDetections(
      true,
      [...labels].map((label) => ({ label, confidence: 1, box: FULL_FRAME })),
    );
  }
}

export class HaAudioSensor extends AudioSensor implements CameraDetector<string> {
  private readonly active = new ActiveSet<string>(() => this.report());

  constructor(nativeId: string, name = 'Home Assistant Audio') {
    super(name, importOptions(nativeId));
  }

  public set(key: string, sound: string, on: boolean): void {
    this.active.set(key, sound, on);
  }

  public pulse(key: string, sound: string): void {
    this.active.pulse(key, sound);
  }

  protected override onStop(): void {
    this.active.clear();
  }

  private report(): void {
    const sounds = this.active.values;
    if (sounds.size === 0) {
      this.reportDetections(false);
      return;
    }
    this.reportDetections(
      true,
      [...sounds].map((sound) => ({ label: 'audio', confidence: 1, box: FULL_FRAME, attribute: sound || undefined })),
    );
  }
}

export type BatteryPart = 'level' | 'low' | 'charging';

export class HaBatteryInfo extends BatteryInfo {
  constructor(nativeId: string, parts: ReadonlySet<BatteryPart>) {
    super('Home Assistant Battery', importOptions(nativeId));
    const capabilities: BatteryCapability[] = [];
    if (parts.has('low')) capabilities.push(BatteryCapability.LowBattery);
    if (parts.has('charging')) capabilities.push(BatteryCapability.Charging);
    this.capabilities = capabilities;
  }

  public apply(part: BatteryPart, state: string): void {
    if (part === 'level') {
      const level = Number(state);
      if (Number.isNaN(level)) return;
      this.setLevel(level);
      return;
    }
    if (part === 'low') {
      this.setLow(state === 'on');
      return;
    }
    this.setCharging(state === 'on' ? ChargingState.Charging : ChargingState.NotCharging);
  }
}
