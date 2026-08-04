import {
  GarageControl,
  GarageProperty,
  GarageState,
  LightControl,
  LightProperty,
  LockControl,
  LockProperty,
  LockState,
  SecuritySystem,
  SecuritySystemProperty,
  SecuritySystemState,
  SirenControl,
  SirenProperty,
  SwitchControl,
  SwitchProperty,
} from '@camera.ui/sdk';

import { importOptions } from './types.js';

import type { HaState } from './types.js';

export type ControlKind = 'lock' | 'garage' | 'securitySystem' | 'switch' | 'light' | 'siren';

export type CommandFn = (property: string, value: unknown) => Promise<void>;

export interface ServiceCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
}

export class HaLockControl extends LockControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class HaGarageControl extends GarageControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class HaSecuritySystem extends SecuritySystem {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class HaSwitchControl extends SwitchControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class HaLightControl extends LightControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export class HaSirenControl extends SirenControl {
  constructor(
    name: string,
    nativeId: string,
    private readonly command: CommandFn,
  ) {
    super(name, importOptions(nativeId));
  }

  writeStates(partial: Record<string, unknown>): void {
    this._writeState(partial);
  }

  override async updateValue(property: string, value: unknown): Promise<void> {
    this._writeState({ [property]: value });
    await this.command(property, value);
  }
}

export type HaControl = HaLockControl | HaGarageControl | HaSecuritySystem | HaSwitchControl | HaLightControl | HaSirenControl;

export function controlKindForEntity(state: HaState): ControlKind | undefined {
  const domain = state.entity_id.split('.')[0];
  const deviceClass = state.attributes.device_class ?? '';

  if (domain === 'lock') return 'lock';
  if (domain === 'cover' && ['garage', 'garage_door', 'gate'].includes(deviceClass)) return 'garage';
  if (domain === 'alarm_control_panel') return 'securitySystem';
  if (domain === 'switch' || domain === 'input_boolean') return 'switch';
  if (domain === 'light') return 'light';
  if (domain === 'siren') return 'siren';
  return undefined;
}

export function applyControlState(kind: ControlKind, control: HaControl, state: HaState): void {
  switch (kind) {
    case 'lock': {
      const locked = state.state === 'locked' || state.state === 'locking';
      const current = state.state === 'jammed' ? LockState.Unknown : locked ? LockState.Secured : LockState.Unsecured;
      control.writeStates({ [LockProperty.CurrentState]: current, [LockProperty.TargetState]: current === LockState.Unknown ? LockState.Unsecured : current });
      break;
    }
    case 'garage': {
      const current =
        state.state === 'open'
          ? GarageState.Open
          : state.state === 'opening'
            ? GarageState.Opening
            : state.state === 'closing'
              ? GarageState.Closing
              : GarageState.Closed;
      const target = current === GarageState.Open || current === GarageState.Opening ? GarageState.Open : GarageState.Closed;
      control.writeStates({ [GarageProperty.CurrentState]: current, [GarageProperty.TargetState]: target });
      break;
    }
    case 'securitySystem': {
      const map: Record<string, SecuritySystemState> = {
        armed_home: SecuritySystemState.StayArm,
        armed_away: SecuritySystemState.AwayArm,
        armed_night: SecuritySystemState.NightArm,
        armed_vacation: SecuritySystemState.AwayArm,
        disarmed: SecuritySystemState.Disarmed,
        triggered: SecuritySystemState.AlarmTriggered,
      };
      const current = map[state.state];
      if (current === undefined) return;
      const target = current === SecuritySystemState.AlarmTriggered ? SecuritySystemState.Disarmed : current;
      control.writeStates({ [SecuritySystemProperty.CurrentState]: current, [SecuritySystemProperty.TargetState]: target });
      break;
    }
    case 'switch': {
      control.writeStates({ [SwitchProperty.On]: state.state === 'on' });
      break;
    }
    case 'light': {
      const on = state.state === 'on';
      const brightness = state.attributes.brightness;
      const partial: Record<string, unknown> = { [LightProperty.On]: on };
      if (typeof brightness === 'number') {
        partial[LightProperty.Brightness] = Math.round((brightness / 255) * 100);
      }
      control.writeStates(partial);
      break;
    }
    case 'siren': {
      control.writeStates({ [SirenProperty.Active]: state.state === 'on' });
      break;
    }
  }
}

const LOCK_TARGET: string = LockProperty.TargetState;
const GARAGE_TARGET: string = GarageProperty.TargetState;
const SECURITY_TARGET: string = SecuritySystemProperty.TargetState;
const SWITCH_ON: string = SwitchProperty.On;
const LIGHT_ON: string = LightProperty.On;
const LIGHT_BRIGHTNESS: string = LightProperty.Brightness;
const SIREN_ACTIVE: string = SirenProperty.Active;

export function commandToService(kind: ControlKind, entityId: string, property: string, value: unknown): ServiceCall | undefined {
  const data = { entity_id: entityId };

  switch (kind) {
    case 'lock':
      if (property !== LOCK_TARGET) return undefined;
      return { domain: 'lock', service: value === LockState.Secured ? 'lock' : 'unlock', data };
    case 'garage':
      if (property !== GARAGE_TARGET) return undefined;
      return { domain: 'cover', service: value === GarageState.Open ? 'open_cover' : 'close_cover', data };
    case 'securitySystem': {
      if (property !== SECURITY_TARGET) return undefined;
      const services: Record<number, string> = {
        [SecuritySystemState.StayArm]: 'alarm_arm_home',
        [SecuritySystemState.AwayArm]: 'alarm_arm_away',
        [SecuritySystemState.NightArm]: 'alarm_arm_night',
        [SecuritySystemState.Disarmed]: 'alarm_disarm',
      };
      const service = services[value as number];
      return service ? { domain: 'alarm_control_panel', service, data } : undefined;
    }
    case 'switch':
      if (property !== SWITCH_ON) return undefined;
      // homeassistant.turn_on covers switch and input_boolean alike
      return { domain: 'homeassistant', service: value ? 'turn_on' : 'turn_off', data };
    case 'light':
      if (property === LIGHT_BRIGHTNESS) {
        return { domain: 'light', service: 'turn_on', data: { ...data, brightness_pct: value } };
      }
      if (property === LIGHT_ON) {
        return { domain: 'light', service: value ? 'turn_on' : 'turn_off', data };
      }
      return undefined;
    case 'siren':
      if (property !== SIREN_ACTIVE) return undefined;
      return { domain: 'siren', service: value ? 'turn_on' : 'turn_off', data };
  }
}

export function createControl(kind: ControlKind, name: string, nativeId: string, command: CommandFn): HaControl {
  switch (kind) {
    case 'lock':
      return new HaLockControl(name, nativeId, command);
    case 'garage':
      return new HaGarageControl(name, nativeId, command);
    case 'securitySystem':
      return new HaSecuritySystem(name, nativeId, command);
    case 'switch':
      return new HaSwitchControl(name, nativeId, command);
    case 'light':
      return new HaLightControl(name, nativeId, command);
    case 'siren':
      return new HaSirenControl(name, nativeId, command);
  }
}
