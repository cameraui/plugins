import { DoorbellTrigger, MotionSensor, Sensor, SensorType, sensorMeta } from '@camera.ui/sdk';

import { applyControlState, controlKindForEntity, createControl } from './controls.js';
import { mapEntity } from './mapping.js';
import { importOptions } from './types.js';

import type { SensorCategory, SensorMeta } from '@camera.ui/sdk';
import type { CommandFn, ControlKind, HaControl } from './controls.js';
import type { HaState } from './types.js';

export class ImportedStateSensor extends Sensor<Record<string, unknown>> {
  readonly type: SensorType;
  readonly category: SensorCategory;

  private readonly stateProperty: string;

  constructor(meta: SensorMeta, name: string, nativeId: string) {
    super(name, importOptions(nativeId));
    this.type = meta.type;
    this.category = meta.category;
    this.stateProperty = meta.semantics!.stateProperty;

    const initial = meta.virtual?.properties?.[this.stateProperty] ?? (meta.properties[this.stateProperty]?.type === 'number' ? 0 : false);
    this._writeState({ [this.stateProperty]: initial });
  }

  writeStateValue(value: boolean | number): void {
    this._writeState({ [this.stateProperty]: value });
  }

  updateValue(): void {}
}

export type ImportedSensor =
  | { kind: 'binary' | 'measurement'; sensor: ImportedStateSensor }
  | { kind: 'motion'; sensor: MotionSensor }
  | { kind: 'doorbell'; sensor: DoorbellTrigger; lastEventState?: string }
  | { kind: 'control'; controlKind: ControlKind; sensor: HaControl };

export interface ImportSpec {
  type: SensorType;
  name: string;
  nativeId: string;
  address?: string;
}

const CONTROL_SENSOR_TYPES: Record<ControlKind, SensorType> = {
  lock: SensorType.Lock,
  garage: SensorType.Garage,
  securitySystem: SensorType.SecuritySystem,
  switch: SensorType.Switch,
  light: SensorType.Light,
  siren: SensorType.Siren,
};

const CONTROL_KINDS = new Map(Object.entries(CONTROL_SENSOR_TYPES).map(([kind, type]) => [type, kind as ControlKind]));

export function importableSensorType(state: HaState): SensorType | undefined {
  const controlKind = controlKindForEntity(state);
  if (controlKind) return CONTROL_SENSOR_TYPES[controlKind];
  const mapping = mapEntity(state);
  if (!mapping) return undefined;
  if (mapping.kind === 'motion') return SensorType.Motion;
  if (mapping.kind === 'doorbell') return SensorType.Doorbell;
  return mapping.meta.type;
}

export function createImportedSensor(spec: ImportSpec, commandFor: (kind: ControlKind) => CommandFn): ImportedSensor | undefined {
  const imported = buildImportedSensor(spec, commandFor);
  if (imported && spec.address) imported.sensor.setAddress(spec.address);
  return imported;
}

function buildImportedSensor({ type, name, nativeId }: ImportSpec, commandFor: (kind: ControlKind) => CommandFn): ImportedSensor | undefined {
  const controlKind = CONTROL_KINDS.get(type);
  if (controlKind) {
    return { kind: 'control', controlKind, sensor: createControl(controlKind, name, nativeId, commandFor(controlKind)) };
  }
  if (type === SensorType.Motion) {
    return { kind: 'motion', sensor: new MotionSensor(name, importOptions(nativeId)) };
  }
  if (type === SensorType.Doorbell) {
    return { kind: 'doorbell', sensor: new DoorbellTrigger(name, importOptions(nativeId)) };
  }

  const meta = sensorMeta(type);
  const stateProperty = meta?.semantics?.stateProperty;
  if (!meta || !stateProperty) return undefined;
  const kind = meta.properties[stateProperty]?.type === 'number' ? 'measurement' : 'binary';
  return { kind, sensor: new ImportedStateSensor(meta, name, nativeId) };
}

export function entityUnavailable(imported: ImportedSensor, state: HaState): boolean {
  if (state.state === 'unavailable') return true;
  return state.state === 'unknown' && imported.kind !== 'doorbell';
}

export function applyEntityState(imported: ImportedSensor, state: HaState, live: boolean): void {
  if (imported.kind === 'doorbell') {
    if (state.state === 'unavailable') return;
    // an event entity's state is the last-trigger timestamp: only a live change
    // is a press, syncs and reconnect replays just seed the baseline
    const changed = imported.lastEventState !== undefined && imported.lastEventState !== state.state;
    imported.lastEventState = state.state;
    if (live && changed && state.state !== 'unknown') imported.sensor.trigger();
    return;
  }

  if (state.state === 'unavailable' || state.state === 'unknown') return;

  if (imported.kind === 'control') {
    applyControlState(imported.controlKind, imported.sensor, state);
    return;
  }

  if (imported.kind === 'motion') {
    imported.sensor.reportDetections(state.state === 'on');
    return;
  }

  if (imported.kind === 'binary') {
    imported.sensor.writeStateValue(state.state === 'on');
    return;
  }

  const value = Number(state.state);
  if (!Number.isNaN(value)) {
    imported.sensor.writeStateValue(value);
  }
}
