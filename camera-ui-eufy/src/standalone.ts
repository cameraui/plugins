import { SensorType } from '@camera.ui/sdk';

import {
  EufyCarbonMonoxideSensor,
  EufyContactSensor,
  EufyLeakSensor,
  EufyLockControl,
  EufyMotionSensor,
  EufySecuritySystem,
  EufySirenControl,
  EufySmokeSensor,
} from './sensors.js';

import type { AdoptedSensor, DiscoveredSensor, LoggerService, SensorOptions } from '@camera.ui/sdk';
import type { AnyDeviceEvent, Device, EufyDevice } from '@mega-yfue/eufy-sdk';

const KINDS = {
  contact: { type: SensorType.Contact, label: 'Contact' },
  motion: { type: SensorType.Motion, label: 'Motion' },
  lock: { type: SensorType.Lock, label: 'Lock' },
  securitySystem: { type: SensorType.SecuritySystem, label: 'Guard Mode' },
  siren: { type: SensorType.Siren, label: 'Siren' },
  leak: { type: SensorType.Leak, label: 'Leak' },
  smoke: { type: SensorType.Smoke, label: 'Smoke' },
  co: { type: SensorType.CarbonMonoxide, label: 'Carbon Monoxide' },
} as const;

type StandaloneKind = keyof typeof KINDS;

type BindableStandalone = EufyContactSensor | EufyLockControl | EufySecuritySystem | EufySirenControl | EufyLeakSensor | EufySmokeSensor | EufyCarbonMonoxideSensor;

export type StandaloneSensorInstance = EufyMotionSensor | BindableStandalone;

export class StandaloneSensor {
  constructor(
    public readonly nativeId: string,
    public readonly sn: string,
    public readonly sensor: StandaloneSensorInstance,
  ) {}

  public bind(device: Device | undefined): void {
    if (!(this.sensor instanceof EufyMotionSensor)) this.sensor.device = device;
    this.sensor.setSourceState(device ? 'connected' : 'unavailable');
    if (device) this.sync();
  }

  public markRemoved(): void {
    if (!(this.sensor instanceof EufyMotionSensor)) this.sensor.device = undefined;
    this.sensor.setSourceState('removed');
  }

  public handleEvent(event: AnyDeviceEvent, direct: boolean): void {
    // events of a device behind a station also name the station, only its guard mode and alarm concern it
    if (!direct && event.eventName !== 'alarm' && event.eventName !== 'armingModeChanged') return;

    if (this.sensor instanceof EufyMotionSensor) {
      if (event.eventName === 'motion') this.sensor.pulse();
      return;
    }
    if (event.eventName === 'alarm') {
      if (this.sensor instanceof EufySecuritySystem) this.sensor.handleAlarm(event);
      return;
    }
    if (event.eventName === 'contactState' && event.open !== undefined && this.sensor instanceof EufyContactSensor) {
      this.sensor.setDetected(event.open);
      return;
    }
    if (event.eventName === 'propertyChanged' || event.eventName === 'armingModeChanged' || event.eventName === 'lockState' || event.eventName === 'contactState') {
      this.sync();
    }
  }

  private sync(): void {
    if (!(this.sensor instanceof EufyMotionSensor)) this.sensor.sync();
  }
}

export function discoverStandaloneSensors(record: EufyDevice, device: Device): DiscoveredSensor[] {
  const kinds = standaloneKinds(record, device);
  return kinds.map((kind) => ({
    id: standaloneNativeId(record.sn, kind),
    name: kinds.length > 1 ? `${device.name} ${KINDS[kind].label}` : device.name,
    type: KINDS[kind].type,
    address: record.sn,
    manufacturer: 'Eufy',
    model: device.modelName,
  }));
}

export function createStandaloneSensor(record: AdoptedSensor, logger: LoggerService): StandaloneSensor | undefined {
  const parsed = parseNativeId(record.nativeId);
  if (!parsed) return undefined;

  const options: SensorOptions = { nativeId: record.nativeId, address: parsed.sn };
  const sensor = buildSensor(parsed.kind, record.name, options, logger);
  sensor.setSourceState('unavailable');
  return new StandaloneSensor(record.nativeId, parsed.sn, sensor);
}

function standaloneKinds(record: EufyDevice, device: Device): StandaloneKind[] {
  if (record.deviceClass === 'camera') return [];

  // sdk model hints also match the name the user gave, a name alone must not create a sensor
  const kinds: StandaloneKind[] = [];
  if (device.contact?.()) kinds.push('contact');
  if (device.has('motion') && record.deviceClass === 'sensor' && !device.contact?.()) kinds.push('motion');
  if (device.lock?.() && record.deviceClass === 'other') kinds.push('lock');
  if (device.arming?.()) kinds.push('securitySystem');
  if (device.siren?.()?.trigger) kinds.push('siren');
  if (device.leak?.()?.leakDetected !== undefined) kinds.push('leak');
  if (device.smoke?.()?.smokeDetected !== undefined) kinds.push('smoke');
  if (device.co?.()?.coDetected !== undefined) kinds.push('co');
  return kinds;
}

function buildSensor(kind: StandaloneKind, name: string, options: SensorOptions, logger: LoggerService): StandaloneSensorInstance {
  switch (kind) {
    case 'contact':
      return new EufyContactSensor(undefined, name, options);
    case 'motion':
      return new EufyMotionSensor(name, options);
    case 'lock':
      return new EufyLockControl(undefined, logger, name, options);
    case 'securitySystem':
      return new EufySecuritySystem(undefined, logger, name, options);
    case 'siren':
      return new EufySirenControl(undefined, logger, name, options);
    case 'leak':
      return new EufyLeakSensor(undefined, name, options);
    case 'smoke':
      return new EufySmokeSensor(undefined, name, options);
    case 'co':
      return new EufyCarbonMonoxideSensor(undefined, name, options);
  }
}

function standaloneNativeId(sn: string, kind: StandaloneKind): string {
  return `${sn}:${kind}`;
}

function parseNativeId(nativeId: string): { sn: string; kind: StandaloneKind } | undefined {
  const separator = nativeId.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const kind = nativeId.slice(separator + 1);
  if (!(kind in KINDS)) return undefined;
  return { sn: nativeId.slice(0, separator), kind: kind as StandaloneKind };
}
