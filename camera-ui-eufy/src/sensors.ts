import {
  AudioSensor,
  BatteryCapability,
  BatteryInfo,
  CarbonMonoxideSensor,
  ChargingState,
  ContactSensor,
  LeakSensor,
  LightCapability,
  LightControl,
  LockControl,
  LockState,
  MotionSensor,
  ObjectSensor,
  PTZCapability,
  PTZControl,
  SecuritySystem,
  SecuritySystemState,
  SirenControl,
  SmokeSensor,
  SwitchControl,
} from '@camera.ui/sdk';
import { ArmingMode, PtzDirection } from '@mega-yfue/eufy-sdk';

import { errorMessage } from './utils.js';

import type { LoggerService, ObjectDetectionLabel, PTZDirection, PTZPosition, PTZRelativeMove, SensorOptions, TrackedDetection } from '@camera.ui/sdk';
import type { AnyDeviceEvent, Device } from '@mega-yfue/eufy-sdk';

const DETECTION_HOLD_MS = 10_000;
const SIREN_SECONDS = 30;
const PTZ_STEP_INTERVAL_MS = 600;
const ALARM_HOLD_MS = 15 * 60_000;
const ALARM_STOP_TYPES = new Set([0, 1, 15, 16, 17]);

const ARMING_STATES: Record<number, SecuritySystemState> = {
  0: SecuritySystemState.AwayArm,
  1: SecuritySystemState.StayArm,
  2: SecuritySystemState.AwayArm,
  3: SecuritySystemState.NightArm,
  4: SecuritySystemState.NightArm,
  5: SecuritySystemState.NightArm,
  6: SecuritySystemState.Disarmed,
  47: SecuritySystemState.AwayArm,
  63: SecuritySystemState.Disarmed,
};

const ARMING_MODES: Partial<Record<SecuritySystemState, ArmingMode>> = {
  [SecuritySystemState.AwayArm]: ArmingMode.away,
  [SecuritySystemState.StayArm]: ArmingMode.home,
  [SecuritySystemState.NightArm]: ArmingMode.custom1,
  [SecuritySystemState.Disarmed]: ArmingMode.disarmed,
};

export interface BindableSensor {
  device: Device | undefined;
  sync(): void;
}

export class EufyMotionSensor extends MotionSensor {
  private resetTimer?: NodeJS.Timeout;

  public pulse(): void {
    this.reportDetections(true);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.reportDetections(false), DETECTION_HOLD_MS);
  }

  protected override onStop(): void {
    clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
  }
}

export class EufyObjectSensor extends ObjectSensor {
  private readonly active = new Map<ObjectDetectionLabel, NodeJS.Timeout>();

  public pulse(label: ObjectDetectionLabel): void {
    clearTimeout(this.active.get(label));
    this.active.set(
      label,
      setTimeout(() => {
        this.active.delete(label);
        this.report();
      }, DETECTION_HOLD_MS),
    );
    this.report();
  }

  protected override onStop(): void {
    for (const timer of this.active.values()) clearTimeout(timer);
    this.active.clear();
  }

  private report(): void {
    if (this.active.size === 0) {
      this.reportDetections(false);
      return;
    }
    const detections: TrackedDetection[] = [...this.active.keys()].map((label) => ({ label, confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 } }));
    this.reportDetections(true, detections);
  }
}

export class EufyAudioSensor extends AudioSensor {
  private resetTimer?: NodeJS.Timeout;

  public pulse(attribute?: string): void {
    this.reportDetections(true, [{ label: 'audio', confidence: 1, box: { x: 0, y: 0, width: 1, height: 1 }, attribute }]);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.reportDetections(false), DETECTION_HOLD_MS);
  }

  protected override onStop(): void {
    clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
  }
}

export class EufyBatteryInfo extends BatteryInfo implements BindableSensor {
  private lowAtLevel?: number;

  constructor(public device: Device | undefined) {
    super('Eufy Battery');
    this.capabilities = device?.battery?.()?.charging === undefined ? [BatteryCapability.LowBattery] : [BatteryCapability.LowBattery, BatteryCapability.Charging];
  }

  public sync(): void {
    const battery = this.device?.battery?.();
    if (!battery) return;
    if (battery.level !== undefined) this.setLevel(battery.level);
    if (battery.charging !== undefined) this.setCharging(battery.charging ? ChargingState.Charging : ChargingState.NotCharging);

    // eufy pushes the low alert but never its end, a charge or a rising level ends it
    if (this.lowAtLevel !== undefined && (battery.charging || (battery.level ?? 0) > this.lowAtLevel)) {
      this.lowAtLevel = undefined;
      this.setLow(false);
    }
  }

  public reportLow(): void {
    this.lowAtLevel = this.device?.battery?.()?.level ?? 0;
    this.setLow(true);
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufyLightControl extends LightControl implements BindableSensor {
  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
  ) {
    super('Eufy Light');
    this.capabilities = device?.light?.()?.brightness === undefined ? [] : [LightCapability.Brightness];
  }

  public sync(): void {
    const light = this.device?.light?.();
    if (light?.isOn !== undefined) void (light.isOn ? super.setOn() : super.setOff());
    if (light?.brightness !== undefined) super.setBrightness(light.brightness);
  }

  public override async setOn(): Promise<void> {
    await runCommand(this.logger, 'turn on the light', async () => {
      await required(this.device?.light?.(), this.displayName).on();
      await super.setOn();
    });
  }

  public override async setOff(): Promise<void> {
    await runCommand(this.logger, 'turn off the light', async () => {
      await required(this.device?.light?.(), this.displayName).off();
      await super.setOff();
    });
  }

  public override async setBrightness(value: number): Promise<void> {
    const brightness = Math.max(1, Math.min(100, Math.round(value)));
    await runCommand(this.logger, 'set the light brightness', async () => {
      await required(this.device?.light?.(), this.displayName).setBrightness(brightness);
      await super.setBrightness(brightness);
    });
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufySirenControl extends SirenControl implements BindableSensor {
  private resetTimer?: NodeJS.Timeout;

  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
    name = 'Eufy Siren',
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const active = this.device?.siren?.()?.active;
    if (active !== undefined) void (active ? super.setActive() : super.setInactive());
  }

  public override async setActive(): Promise<void> {
    await runCommand(this.logger, 'trigger the siren', async () => {
      const siren = required(this.device?.siren?.(), this.displayName);
      if (!siren.trigger) throw new Error(`${this.displayName} has no siren that can be triggered`);
      await siren.trigger(SIREN_SECONDS);
      await super.setActive();
      clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => super.setInactive(), SIREN_SECONDS * 1000);
    });
  }

  public override async setInactive(): Promise<void> {
    await runCommand(this.logger, 'stop the siren', async () => {
      const siren = required(this.device?.siren?.(), this.displayName);
      if (!siren.stop) throw new Error(`${this.displayName} has no siren that can be stopped`);
      await siren.stop();
      clearTimeout(this.resetTimer);
      await super.setInactive();
    });
  }

  protected override onStart(): void {
    this.sync();
  }

  protected override onStop(): void {
    clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
  }
}

export class EufyCameraSwitch extends SwitchControl implements BindableSensor {
  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
  ) {
    super('Eufy Camera');
  }

  public sync(): void {
    const enabled = this.device?.camera?.()?.enabled;
    if (enabled !== undefined) void (enabled ? super.setOn() : super.setOff());
  }

  public override async setOn(): Promise<void> {
    await runCommand(this.logger, 'turn on the camera', async () => {
      await required(this.device?.camera?.(), this.displayName).on();
      await super.setOn();
    });
  }

  public override async setOff(): Promise<void> {
    await runCommand(this.logger, 'turn off the camera', async () => {
      await required(this.device?.camera?.(), this.displayName).off();
      await super.setOff();
    });
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufySecuritySystem extends SecuritySystem implements BindableSensor {
  private alarmTimer?: NodeJS.Timeout;

  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
    name = 'Eufy Guard Mode',
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const mode = this.device?.arming?.()?.mode;
    const state = mode === undefined ? undefined : ARMING_STATES[mode];
    if (state === undefined) return;
    // a running alarm ends with a mode change or its stop push
    if (this.currentState === SecuritySystemState.AlarmTriggered && state === this.targetState) return;
    this.clearAlarmTimer();
    super.setTargetState(state);
  }

  public handleAlarm(event: Extract<AnyDeviceEvent, { eventName: 'alarm' }>): void {
    if (event.phase === 'delayed') return;

    const alarmType = (event as { alarm_type?: unknown }).alarm_type;
    if (typeof alarmType === 'number' && ALARM_STOP_TYPES.has(alarmType)) {
      this.endAlarm();
      return;
    }

    this.setCurrentState(SecuritySystemState.AlarmTriggered);
    this.clearAlarmTimer();
    this.alarmTimer = setTimeout(() => this.endAlarm(), ALARM_HOLD_MS);
  }

  public override async setTargetState(value: SecuritySystemState): Promise<void> {
    const mode = ARMING_MODES[value];
    if (!mode) return;
    await runCommand(this.logger, 'set the guard mode', async () => {
      await required(this.device?.arming?.(), this.displayName).setMode(mode);
      this.clearAlarmTimer();
      await super.setTargetState(value);
    });
  }

  protected override onStart(): void {
    this.sync();
  }

  protected override onStop(): void {
    this.clearAlarmTimer();
  }

  private endAlarm(): void {
    this.clearAlarmTimer();
    if (this.currentState === SecuritySystemState.AlarmTriggered) this.setCurrentState(this.targetState);
  }

  private clearAlarmTimer(): void {
    clearTimeout(this.alarmTimer);
    this.alarmTimer = undefined;
  }
}

export class EufyContactSensor extends ContactSensor implements BindableSensor {
  constructor(
    public device: Device | undefined,
    name: string,
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const open = this.device?.contact?.()?.open;
    if (open !== undefined) this.setDetected(open);
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufyLockControl extends LockControl implements BindableSensor {
  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
    name: string,
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const locked = this.device?.lock?.()?.locked;
    if (locked === undefined) {
      this.setCurrentState(LockState.Unknown);
      return;
    }
    const state = locked ? LockState.Secured : LockState.Unsecured;
    if (this.targetState === state) {
      this.setCurrentState(state);
    } else {
      super.setTargetState(state);
    }
  }

  public override async setTargetState(value: LockState): Promise<void> {
    if (value === LockState.Unknown) return;
    await runCommand(this.logger, value === LockState.Secured ? 'lock' : 'unlock', async () => {
      const lock = required(this.device?.lock?.(), this.displayName);
      await (value === LockState.Secured ? lock.lock() : lock.unlock());
      await super.setTargetState(value);
    });
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufyLeakSensor extends LeakSensor implements BindableSensor {
  constructor(
    public device: Device | undefined,
    name: string,
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const detected = this.device?.leak?.()?.leakDetected;
    if (detected !== undefined) this.setDetected(detected);
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufySmokeSensor extends SmokeSensor implements BindableSensor {
  constructor(
    public device: Device | undefined,
    name: string,
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const detected = this.device?.smoke?.()?.smokeDetected;
    if (detected !== undefined) this.setDetected(detected);
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufyCarbonMonoxideSensor extends CarbonMonoxideSensor implements BindableSensor {
  constructor(
    public device: Device | undefined,
    name: string,
    options?: SensorOptions,
  ) {
    super(name, options);
  }

  public sync(): void {
    const detected = this.device?.co?.()?.coDetected;
    if (detected !== undefined) this.setDetected(detected);
  }

  protected override onStart(): void {
    this.sync();
  }
}

export class EufyPtzControl extends PTZControl implements BindableSensor {
  private readonly presetIds = new Map<string, number>();
  private presetsRequested = false;
  private lastStepAt = 0;
  private movingTimer?: NodeJS.Timeout;

  constructor(
    public device: Device | undefined,
    private readonly logger: LoggerService,
  ) {
    super('Eufy PTZ');
    this.capabilities = [PTZCapability.Pan, PTZCapability.Tilt, PTZCapability.RelativeMove, PTZCapability.VelocityControl];
  }

  public sync(): void {
    // the preset query opens P2P, a battery camera would wake on every start
    if (this.presetsRequested || !this.device || this.device.has('battery')) return;
    this.presetsRequested = true;
    this.loadPresets();
  }

  public override async setVelocity(value: PTZDirection | undefined): Promise<void> {
    if (!value) return;
    await this.step(value.panSpeed, value.tiltSpeed, true);
  }

  public override async setRelativeMove(value: PTZRelativeMove): Promise<void> {
    await this.step(value.panDelta, value.tiltDelta, false);
  }

  public override async setTargetPreset(value: string | undefined): Promise<void> {
    const id = value === undefined ? undefined : this.presetIds.get(value);
    if (id === undefined) return;
    await runCommand(this.logger, `move to ${value}`, async () => {
      await required(this.device?.ptz?.(), this.displayName).preset().goto(id);
      await super.setTargetPreset(value);
    });
  }

  public override async setPosition(_value: PTZPosition): Promise<void> {}

  protected override onStop(): void {
    clearTimeout(this.movingTimer);
    this.movingTimer = undefined;
  }

  private async step(pan: number, tilt: number, throttle: boolean): Promise<void> {
    if (pan === 0 && tilt === 0) return;

    const now = Date.now();
    if (throttle && now - this.lastStepAt < PTZ_STEP_INTERVAL_MS) return;
    this.lastStepAt = now;

    const direction = Math.abs(pan) >= Math.abs(tilt) ? (pan > 0 ? PtzDirection.right : PtzDirection.left) : tilt > 0 ? PtzDirection.up : PtzDirection.down;

    this.setMoving(true);
    clearTimeout(this.movingTimer);
    this.movingTimer = setTimeout(() => this.setMoving(false), PTZ_STEP_INTERVAL_MS);

    await runCommand(this.logger, `move the camera ${direction}`, async () => {
      await required(this.device?.ptz?.(), this.displayName).rotate(direction);
    });
  }

  private async loadPresets(): Promise<void> {
    const actions = this.device?.ptz?.()?.preset();
    if (!actions?.list) return;
    try {
      const presets = await actions.list();
      this.presetIds.clear();
      for (const preset of presets) this.presetIds.set(`Preset ${preset.id}`, preset.id);
      this.setPresets([...this.presetIds.keys()]);
      if (this.presetIds.size > 0) this.capabilities = [...this.capabilities, PTZCapability.Presets];
    } catch (error) {
      this.logger.debug(`Could not load the PTZ presets: ${errorMessage(error)}`);
    }
  }
}

async function runCommand(logger: LoggerService, action: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(`Could not ${action}: ${errorMessage(error)}`);
  }
}

function required<T>(value: T | false | undefined, name: string): T {
  if (value === undefined || value === false) throw new Error(`${name} is not connected to Eufy or does not support this`);
  return value;
}
